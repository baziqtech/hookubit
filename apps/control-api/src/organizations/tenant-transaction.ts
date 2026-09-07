import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AuditEntry,
  AuditService,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
// See the docblock below. The
// scoped repositories cannot open a transaction, and this is the only way to
// get one without every service holding the unscoped client. Allowlisted by
// exact filename in .eslintrc.json; the entry goes away when this moves into
// src/authz.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * One database transaction, with a `TenantScope` bound to it, run at
 * SERIALIZABLE isolation and retried on a serialisation failure.
 *
 * `TenantScope.withClient(...)` exists for exactly this and its docblock says
 * "use inside `$transaction`" — but nothing in the authorization layer can
 * START a transaction. `TenantScopeFactory` takes a client and does not expose
 * one, `ScopedRepository`'s transaction runner is private and wraps a single
 * read-after-write pair, and `PrismaService` is banned from module code by
 * eslint. A module that needed two statements to be atomic therefore had a
 * choice between injecting the unscoped client and not being atomic, and the
 * members module cannot take either:
 *
 *   assertRoleChangeAllowed's own docblock: "Count it inside the same
 *   transaction as the update, or two concurrent demotions each see two owners
 *   and leave zero."
 *
 * ## Why atomicity was not enough, and why the isolation level is here
 *
 * Being in one transaction closes nothing on its own. `$transaction` with no
 * `isolationLevel` runs at PostgreSQL's default READ COMMITTED, and the
 * last-owner invariant is a read-then-write over a SET of rows, not over the
 * row being written:
 *
 *   T1: count(role='owner') -> 2   T2: count(role='owner') -> 2
 *   T1: UPDATE member_a            T2: UPDATE member_b
 *   both commit. Zero owners.
 *
 * The two UPDATEs touch DIFFERENT rows, so there is no row lock to contend on
 * and neither transaction blocks. Both reviewers reproduced exactly this:
 * `outcomes: ['fulfilled','fulfilled'], remaining owners: 0`. An organization
 * with no owner cannot be recovered through the API — nobody left holds
 * `members.write` at owner rank, `mayAssignRole(admin,'owner')` is permanently
 * false, and `DELETE /v1/organizations/:orgId` is owner-only and unreachable.
 * Recovery is a psql session.
 *
 * Three ways to close it, and why this one:
 *
 *  - **A partial unique index** cannot express "at least one row matching this
 *    predicate". Unique indexes forbid duplicates; they cannot require an
 *    occupant. Not available.
 *  - **An explicit `SELECT ... FOR UPDATE`** over the owner rows works, but the
 *    lock has to name the table and the predicate being counted. That makes it
 *    a per-caller fix: this runner would have to be told which rows each
 *    callback intends to read-then-write, and every future caller
 *    (deliveries, events, rate limits — all read-then-write by nature) would
 *    have to remember to declare it. That is the property that just failed.
 *  - **SERIALIZABLE**, here, once. PostgreSQL's SSI detects the read/write
 *    dependency cycle the two transactions above form and aborts one with
 *    `40001`; the survivor's count is then correct and the lattice refuses it.
 *    The runner needs to know nothing about the callback to make that hold, so
 *    a module that inherits this runner inherits the guarantee rather than the
 *    obligation.
 *
 * The cost is real and accepted: SSI aborts legitimate work under contention,
 * so every transaction here must be retryable — and the control plane's write
 * volume (organizations, members, endpoints, keys) is nowhere near where the
 * abort rate matters. The data plane does not use this class.
 *
 * ## The callback must be REPLAYABLE
 *
 * A serialisation failure re-runs `fn` from the top. Everything it does must
 * therefore be either inside the transaction (and rolled back) or idempotent.
 * Do not send mail, call a third party, or consume a single-use token inside
 * `run`. Reads, writes and `audit.record` are all fine.
 *
 * ## What the callback is handed
 *
 * A `TenantScope` bound to the transaction client — its reads and writes are
 * inside the transaction AND still carry the tenant predicate — and a
 * `TenantAudit`, which is `AuditService.recordFor` with the context and the
 * transaction client already closed over.
 *
 * The raw `Prisma.TransactionClient` is deliberately NOT passed any more. It
 * exposes every model delegate with no tenant predicate whatsoever, so a
 * callback could write `tx.organizationMember.updateMany({ where: {}, data: {
 * role: 'owner' } })` and pass lint cleanly: the eslint fence bans IMPORTING
 * prisma.service and PrismaClient, not RECEIVING an unscoped client as an
 * argument. This class is exported from `OrganizationsModule` and already
 * imported elsewhere, so that was one careless callback away from being a
 * live cross-tenant write. The audit handle is the only thing callers ever
 * needed it for.
 *
 * PLACEMENT: belongs on `TenantScopeFactory` in `src/authz` as
 * `transaction(context, fn)` — see HANDOFF.md.
 */

/**
 * The audit hook, bound to the transaction. Opaque on purpose: it is the whole
 * of what a callback legitimately needed the raw client for, so handing over
 * this instead of `tx` costs a caller nothing and removes the unscoped client
 * from the callback's reach.
 */
export interface TenantAudit {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * SERIALIZABLE for every transaction opened here, not just the ones a caller
 * remembers to ask for. An opt-in isolation level is the same class of bug as
 * an opt-in tenant predicate.
 */
export const TENANT_TRANSACTION_ISOLATION = Prisma.TransactionIsolationLevel.Serializable;

/**
 * Attempts, including the first. Three retries is far past the point where a
 * genuine two-writer conflict resolves; beyond that the contention is real and
 * the caller should be told rather than made to wait.
 */
export const MAX_TRANSACTION_ATTEMPTS = 4;

/** Base backoff. Jittered, so two conflicting retries do not re-collide. */
const RETRY_BASE_DELAY_MS = 5;

/**
 * A PostgreSQL serialisation failure or deadlock, in every shape Prisma reports
 * one.
 *
 * `P2034` is Prisma's own "transaction failed due to a write conflict or a
 * deadlock". A raw or driver-level failure arrives as `P2010`/unknown with the
 * SQLSTATE in `meta.code` (`40001` serialization_failure, `40P01`
 * deadlock_detected) or only in the message. Duck-typed rather than
 * `instanceof`, for the reason `isSlugCollision` gives: a duplicated
 * `@prisma/client` in the tree silently breaks instanceof across a module
 * boundary.
 */
export function isSerializationFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === 'P2034') return true;

  const sqlState = (err as { meta?: { code?: unknown } }).meta?.code;
  if (sqlState === '40001' || sqlState === '40P01') return true;

  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return (
    message.includes('could not serialize access') ||
    message.includes('deadlock detected') ||
    message.includes('40001') ||
    message.includes('40P01')
  );
}

@Injectable()
export class TenantTransactionRunner {
  private readonly logger = new Logger(TenantTransactionRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
  ) {}

  /**
   * Run `fn` inside one SERIALIZABLE transaction, retrying it if PostgreSQL
   * aborts it as unserialisable. See the class docblock for what `fn` may do.
   */
  async run<T>(
    context: RequestContext,
    fn: (scope: TenantScope, audit: TenantAudit) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => fn(this.scopes.for(context, tx), this.auditFor(context, tx)),
          { isolationLevel: TENANT_TRANSACTION_ISOLATION },
        );
      } catch (err) {
        if (!isSerializationFailure(err)) throw err;
        if (attempt >= MAX_TRANSACTION_ATTEMPTS) {
          // Never a 500: the write did not land, nothing is inconsistent, and
          // "try again" is exactly what the caller should do.
          this.logger.warn(
            `Transaction for organization ${context.organization.id} was aborted as unserialisable ${attempt} times; giving up.`,
          );
          throw new AppError(
            'conflict',
            'That change collided with another change to the same organization. Try again.',
          );
        }
        this.logger.debug(
          `Transaction for organization ${context.organization.id} aborted as unserialisable on attempt ${attempt}; retrying.`,
        );
        await TenantTransactionRunner.backoff(attempt);
      }
    }
  }

  /**
   * `AuditService.recordFor` with the context and the transaction client bound.
   * The context comes from the resolved request, never from the callback, so a
   * callback still cannot file a row against an organization it does not hold.
   */
  private auditFor(context: RequestContext, tx: Prisma.TransactionClient): TenantAudit {
    return {
      record: async (entry: AuditEntry): Promise<void> => {
        await this.audit.recordFor(context, entry, tx);
      },
    };
  }

  private static async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY_MS * attempt * (1 + Math.random());
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
