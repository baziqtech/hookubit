import { Injectable, Logger } from '@nestjs/common';
import { Endpoint, EndpointSecret } from '@prisma/client';
import {
  AuditService,
  CROSS_TENANT_MESSAGE,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { CryptoService } from '../common/crypto.service';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
// Direct file import rather than the barrel: this is the ONLY thing these
// modules take from `src/organizations`, and naming the file keeps an unrelated
// change to that module's index out of this module's build.
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import {
  EndpointSecretDto,
  EndpointSecretListDto,
  ListSecretsQueryDto,
  RotatedSecretDto,
  isEffectivelyActive,
  toEndpointSecretDto,
} from './dto';
import {
  DEFAULT_OVERLAP_SECONDS,
  generateSigningSecret,
} from './secret-generator';

/** The physical table, for the encryption AAD. Must match `@@map` in the schema. */
const SECRETS_TABLE = 'endpoint_secrets';

/**
 * HMAC signing secrets, and the rotation window that makes them rollable.
 *
 * ## The invariant this service exists to hold
 *
 * `signing.Header` (services/data-plane/internal/signing/signing.go) returns
 * `ErrNoSecrets` when an endpoint has no active secret. It fails CLOSED on
 * purpose - a header with no `v1=` component is rejected by `Verify`, so
 * delivering unsigned would just be a delivery that cannot be verified, dressed
 * up as a success. The consequence lands here:
 *
 * > **A live endpoint must ALWAYS have at least one active, unexpired secret,
 * > and no operation in this service may leave it with none.**
 *
 * Four paths could break it and each is closed explicitly:
 *
 * 1. **Creation.** An endpoint is created paused and only becomes active once
 *    its version 1 secret exists (`EndpointsService.create`).
 * 2. **Enabling.** `EndpointsService.enable` refuses an endpoint with no live
 *    secret rather than resuming deliveries that cannot be signed.
 * 3. **Rotation.** The new secret is inserted BEFORE the old ones are given an
 *    expiry, so a failure between the two statements leaves two live secrets -
 *    never zero. See `rotate`.
 * 4. **Revocation.** `revoke` refuses to deactivate the last live secret of an
 *    endpoint that is not deleted.
 *
 * ## Why 3 and 4 were not true, and what makes them true
 *
 * Paths 3 and 4 used to be read-then-check-then-write with nothing re-checking
 * at write time, and that made the fourth claim above FALSE under concurrency.
 * Both interleavings were reproduced:
 *
 * - Two simultaneous `DELETE .../secrets/:id`, one for v1 and one for v2, each
 *   snapshot both secrets, each compute the OTHER as their surviving secret,
 *   each pass the check and each write. Live secrets: 0. Endpoint: still
 *   `active`, still `enabled`, every delivery to it failing closed forever,
 *   because `signing.Header` fails closed and no operator gets told.
 * - A revoke landing between rotation's INSERT of v2 and its expiry of v1 sees
 *   both live, deactivates v2 as the "superseded" one, and the rotation then
 *   expires v1 on top of it. Reachable through the leak playbook this service
 *   documents (`rotate` with `overlap_seconds: 0`).
 *
 * Note what BOTH have in common: the check reads a SET of rows and the write
 * touches a DIFFERENT row in that set. There is no row two writers contend on,
 * so atomicity alone closes nothing - at READ COMMITTED the pair still
 * interleaves exactly as above.
 *
 * So `rotate` and `revoke` run their snapshot, their check and their write
 * inside one `TenantTransactionRunner.run`, which opens every transaction at
 * **SERIALIZABLE** and retries a serialisation failure. PostgreSQL's SSI sees
 * the read/write dependency cycle those two transactions form, aborts one with
 * `40001`, and the runner replays it - at which point its snapshot includes the
 * committed write and the survivor check refuses correctly. That is the whole
 * mechanism; `TENANT_TRANSACTION_ISOLATION` in
 * `organizations/tenant-transaction.ts` argues at length why it is there rather
 * than a per-caller `SELECT ... FOR UPDATE`.
 *
 * Because a serialisation failure REPLAYS the callback, everything inside `run`
 * here is a read, a write or an audit record - nothing is sent, consumed or
 * generated that a replay would duplicate. The secret plaintext is generated
 * inside the callback and returned from it, so a replayed attempt returns the
 * secret it actually inserted.
 *
 * `assertStillSigning` is the belt to that braces: after the write, inside the
 * same transaction, the invariant is re-counted and a violation rolls the whole
 * thing back rather than committing an endpoint nothing can sign for.
 *
 * ## Why rotation overlaps rather than swaps
 *
 * `Header` emits one `v1=` per active secret and `Verify` accepts the delivery
 * if ANY of them matches. So while both secrets are active, a consumer holding
 * either one verifies successfully, and the customer can redeploy at their own
 * pace. Deactivating the old secret at the moment the new one is issued would
 * break every consumer in the gap between "we rotated" and "they deployed" -
 * which is the whole failure mode rotation is meant to avoid.
 *
 * ## Secrets in this file
 *
 * The plaintext exists in memory for the length of one request and is returned
 * exactly once, in the response to the call that created it. It is never
 * returned by a read path (`EndpointSecretDto` has no field it could occupy),
 * never written to a log, and never put in audit metadata - `AuditService`
 * would redact a key called `secret` anyway, and this code does not rely on
 * that.
 */
@Injectable()
export class EndpointSecretsService {
  private readonly logger = new Logger(EndpointSecretsService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * One page of secret metadata for this endpoint, newest first. No plaintext,
   * by construction: the only thing that can decrypt `secret_encrypted` is
   * `rotate`, and it decrypts nothing - it encrypts a value it just generated.
   *
   * A page, with `has_more`, rather than a bare array: this is a display read
   * and it is bounded like every other one. The reads that make DECISIONS -
   * next version, survivor count, "does a live secret exist" - do not use this;
   * they use `secretsFor`, which is exhaustive. See its docblock.
   */
  async list(
    context: RequestContext,
    endpointId: string,
    query: ListSecretsQueryDto = {},
  ): Promise<EndpointSecretListDto> {
    const scope = this.scopes.for(context);
    await this.requireEndpoint(scope, endpointId);
    const now = new Date();
    const page = await scope.endpointSecrets.findPage({
      where: { endpointId },
      orderBy: { version: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map((secret) => toEndpointSecretDto(secret, now)),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * Issue a new secret and start the overlap window on the current ones.
   *
   * Statement order is the safety property, and it is not arbitrary:
   *
   *   1. INSERT the new secret, active, with no expiry.
   *   2. UPDATE the previously active secrets to expire at `now + overlap`.
   *
   * The pair is now inside one SERIALIZABLE transaction, which is what makes it
   * serialise against a concurrent `revoke` (see the class docblock). The ORDER
   * still matters and must not be reversed: a transaction that fails between
   * the two statements rolls back to two live secrets, and even in a world
   * without transactions the reverse order would open a window with zero.
   *
   * Two simultaneous rotations are additionally fenced by
   * `@@unique([endpointId, version])`, so neither can claim a version the other
   * took; the loser gets a `conflict` and retries.
   */
  async rotate(
    context: RequestContext,
    endpointId: string,
    overlapSeconds: number = DEFAULT_OVERLAP_SECONDS,
  ): Promise<RotatedSecretDto> {
    return this.transactions.run(context, async (scope, audit) => {
      const endpoint = await this.requireEndpoint(scope, endpointId);
      if (endpoint.status === 'deleted') {
        throw new AppError(
          'conflict',
          'This endpoint is deleted. Rotating a secret for it would create a credential nothing can use.',
        );
      }

      const now = new Date();
      const existing = await this.secretsFor(scope, endpointId);
      const liveBefore = existing.filter((secret) => isEffectivelyActive(secret, now));

      // 1. The new secret first. Everything after this point can fail without
      //    taking the endpoint below one live secret.
      const created = await this.insertSecret(scope, endpointId, existing, now);

      // 2. Now, and only now, put a clock on the old ones.
      const expiresAt = new Date(now.getTime() + overlapSeconds * 1_000);
      const extended = liveBefore.filter(
        (secret) =>
          secret.expiresAt === null || new Date(secret.expiresAt).getTime() > expiresAt.getTime(),
      );
      if (extended.length > 0) {
        await scope.endpointSecrets.updateMany(
          { endpointId, id: { in: extended.map((secret) => secret.id) } },
          { expiresAt, rotatedAt: now },
        );
      }

      // Housekeeping, deliberately after the invariant is already safe: secrets
      // whose window closed before this rotation are flipped inactive so the
      // signing header does not have to re-derive that on every delivery, and so
      // the active set stays small however many times an endpoint is rotated.
      await this.sweepExpired(scope, endpointId, existing, now);

      const stillSigning = EndpointSecretsService.stillSigningAfter(
        liveBefore,
        new Set(extended.map((secret) => secret.id)),
        expiresAt,
        now,
      );

      // The new secret is unexpired and active, so this cannot fail here - it
      // is asserted anyway, because "cannot fail" is what path 4 also said.
      await this.assertStillSigning(scope, endpoint, now);

      await audit.record({
        action: 'endpoint_secret.rotated',
        resourceType: 'endpoint_secret',
        resourceId: created.row.id,
        metadata: {
          endpoint_id: endpointId,
          version: created.row.version,
          overlap_seconds: overlapSeconds,
          previous_versions: stillSigning.versions,
          // The single fact this row is consulted for: when the old secret
          // stopped signing. It carries the same name as the response field.
          previous_secrets_expire_at: stillSigning.until?.toISOString() ?? null,
        },
      });

      return {
        ...toEndpointSecretDto(created.row, now),
        // The one and only time this value crosses the wire.
        secret: created.plaintext,
        previous_secrets_expire_at: stillSigning.until?.toISOString() ?? null,
        overlapping_versions: stillSigning.versions,
      };
    });
  }

  /**
   * Stop a specific secret signing, immediately.
   *
   * Refused when it is the last live secret of an endpoint that still exists,
   * because that is precisely the state `signing.Header` refuses to sign in. The
   * caller is told to rotate instead, which produces the same end state (that
   * secret stops signing) without the outage in between: `rotate` with
   * `overlap_seconds: 0` is the "this secret has leaked" button.
   *
   * Snapshot, check and write are one SERIALIZABLE transaction, so the survivor
   * this call counted is still a survivor when the write lands, and the
   * invariant is re-asserted after the write before anything commits. See the
   * class docblock for the two interleavings that made the check useless when
   * it was none of those things.
   */
  async revoke(
    context: RequestContext,
    endpointId: string,
    secretId: string,
  ): Promise<EndpointSecretDto> {
    return this.transactions.run(context, async (scope, audit) => {
      const endpoint = await this.requireEndpoint(scope, endpointId);

      const now = new Date();
      const secrets = await this.secretsFor(scope, endpointId);
      const target = secrets.find((secret) => secret.id === secretId);
      // Not "which endpoint does this secret belong to?" - `secretsFor` is
      // already fenced to this endpoint inside this tenant, so a secret from
      // anywhere else is simply absent here.
      if (!target) throw new AppError('not_found', CROSS_TENANT_MESSAGE);

      const survivors = secrets.filter(
        (secret) => secret.id !== secretId && isEffectivelyActive(secret, now),
      );
      if (survivors.length === 0 && endpoint.status !== 'deleted') {
        throw new AppError(
          'conflict',
          'This is the only secret currently signing for this endpoint. Removing it would make ' +
            'every delivery fail unsigned. Rotate instead - use an overlap of 0 seconds if this ' +
            'secret has leaked and must stop signing immediately.',
        );
      }

      await scope.endpointSecrets.updateMany(
        { endpointId, id: secretId },
        { active: false, expiresAt: now, rotatedAt: now },
      );

      // Re-counted AFTER the write, inside the transaction. The check above
      // read a snapshot; this reads the state this transaction is about to
      // commit. Under SERIALIZABLE one of two colliding revokes is already
      // aborted before it gets here - this is what refuses if anything ever
      // widens the isolation level or adds a path that skips the pre-check.
      await this.assertStillSigning(scope, endpoint, now);

      await audit.record({
        action: 'endpoint_secret.revoked',
        resourceType: 'endpoint_secret',
        resourceId: secretId,
        metadata: { endpoint_id: endpointId, version: target.version },
      });

      return toEndpointSecretDto({ ...target, active: false, expiresAt: now, rotatedAt: now }, now);
    });
  }

  /**
   * The version 1 secret for a brand-new endpoint.
   *
   * Called by `EndpointsService.create` while the endpoint is still paused, so
   * the endpoint never exists in an active-with-no-secret state. Separate from
   * `rotate` because there is nothing to overlap with and no audit action named
   * "rotated" would be true.
   */
  async mintInitial(
    context: RequestContext,
    endpointId: string,
  ): Promise<{ secret: string; version: number; id: string }> {
    const scope = this.scopes.for(context);
    const created = await this.insertSecret(scope, endpointId, [], new Date());
    await this.audit.recordFor(context, {
      action: 'endpoint_secret.created',
      resourceType: 'endpoint_secret',
      resourceId: created.row.id,
      metadata: { endpoint_id: endpointId, version: created.row.version },
    });
    return { secret: created.plaintext, version: created.row.version, id: created.row.id };
  }

  /**
   * Does this endpoint have a secret that would actually sign right now?
   *
   * `EndpointsService.enable` asks before resuming deliveries. It reads the same
   * rows through the same tenant scope, so an endpoint in another tenant is
   * "no" for the same reason everything else about it is a 404.
   */
  async hasLiveSecret(context: RequestContext, endpointId: string): Promise<boolean> {
    const scope = this.scopes.for(context);
    const now = new Date();
    const secrets = await this.secretsFor(scope, endpointId);
    return secrets.some((secret) => isEffectivelyActive(secret, now));
  }

  // ---------------------------------------------------------------------------

  /**
   * The endpoint, proved to be in this tenant, through the scope.
   *
   * This is also what makes the secret write legal: `endpoint_secrets` has no
   * tenant column of its own, so the parent is the tenancy. Resolving it here
   * first - and passing only the scalar id onward - is the pattern
   * `ScopedRepository` asks for.
   */
  private async requireEndpoint(scope: TenantScope, endpointId: string): Promise<Endpoint> {
    const endpoint = await scope.endpoints.findById(endpointId);
    if (!endpoint) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return endpoint;
  }

  /**
   * The invariant, re-asserted against the rows this transaction will commit.
   *
   * Throwing here rolls the whole transaction back, so a write that would have
   * left a live endpoint with nothing to sign with never lands. It is a
   * deliberate `internal_error`: reaching it means a pre-check that should have
   * refused did not, and the caller is owed a loud failure rather than a
   * plausible one.
   *
   * A deleted endpoint is exempt for the same reason `revoke` exempts it -
   * nothing is delivered to it, so it has nothing to sign.
   */
  private async assertStillSigning(
    scope: TenantScope,
    endpoint: Endpoint,
    now: Date,
  ): Promise<void> {
    if (endpoint.status === 'deleted') return;
    const remaining = await this.secretsFor(scope, endpoint.id);
    if (remaining.some((secret) => isEffectivelyActive(secret, now))) return;
    throw new AppError(
      'internal_error',
      'Refusing to commit: this would have left an active endpoint with no signing secret, ' +
        'and every delivery to it would fail closed. Nothing was changed.',
    );
  }

  /**
   * EVERY secret row for this endpoint, newest version first.
   *
   * Exhaustive, not a page, and that is a correctness requirement rather than
   * thoroughness: the next version number, the survivor count `revoke` refuses
   * on, and `hasLiveSecret` are all computed from this array. Read as a single
   * capped page, each of those is wrong past `MAX_PAGE_SIZE` - the next version
   * would collide with an existing row, and a survivor sitting on page two
   * would be invisible to the check that exists to find it.
   *
   * `forEachPage` is the sanctioned way to say "I processed everything"; it
   * pages by primary key, so nothing is skipped or repeated.
   */
  private async secretsFor(scope: TenantScope, endpointId: string): Promise<EndpointSecret[]> {
    const secrets: EndpointSecret[] = [];
    await scope.endpointSecrets.forEachPage((rows) => {
      secrets.push(...rows);
    }, { where: { endpointId } });
    // Paged by id ascending; the callers all want version order.
    return secrets.sort((a, b) => b.version - a.version);
  }

  /**
   * Which PRIOR versions are still signing once this rotation commits, and when
   * the last of them stops.
   *
   * Not "the ones we just extended". A secret whose own expiry already precedes
   * the new overlap end is correctly left alone - and is still live, still
   * emitting a `v1=` component. Reporting only the extended set told a consumer
   * rolling its secrets that nothing else was signing, which is the one thing
   * that field is read to decide.
   *
   * `overlap_seconds: 0` moves the deadline to `now`, and a secret expiring at
   * `now` is not signing (`isEffectivelyActive` wants strictly greater), so the
   * leak button still reports an empty set - correctly.
   */
  private static stillSigningAfter(
    liveBefore: readonly EndpointSecret[],
    extendedIds: ReadonlySet<string>,
    newExpiry: Date,
    now: Date,
  ): { versions: number[]; until: Date | null } {
    const surviving = liveBefore
      .map((secret) => ({
        version: secret.version,
        // Anything not extended kept its own expiry, and it cannot be null: a
        // null expiry always qualifies for extension.
        until: extendedIds.has(secret.id)
          ? newExpiry
          : new Date(secret.expiresAt as Date),
      }))
      .filter((secret) => secret.until.getTime() > now.getTime());

    if (surviving.length === 0) return { versions: [], until: null };
    return {
      versions: surviving.map((secret) => secret.version).sort((a, b) => b - a),
      until: new Date(Math.max(...surviving.map((secret) => secret.until.getTime()))),
    };
  }

  /**
   * Encrypt and insert one secret, returning the row and the plaintext.
   *
   * The row id is minted before the ciphertext because the id is part of the
   * AES-GCM additional authenticated data, together with the table and the
   * owning endpoint. That binding is what stops someone with database write
   * access from moving a ciphertext - or re-pointing this row's `endpoint_id` -
   * so that the platform signs another endpoint's traffic with a secret they
   * control. See the `EncryptionContext` docblock in `common/crypto.service.ts`.
   */
  private async insertSecret(
    scope: TenantScope,
    endpointId: string,
    existing: readonly EndpointSecret[],
    now: Date,
  ): Promise<{ row: EndpointSecret; plaintext: string }> {
    const id = newId('endpointSecret');
    const plaintext = generateSigningSecret();
    const version = existing.reduce((highest, secret) => Math.max(highest, secret.version), 0) + 1;

    try {
      const row = await scope.endpointSecrets.create({
        id,
        endpointId,
        secretEncrypted: this.crypto.encrypt(plaintext, {
          table: SECRETS_TABLE,
          id,
          owner: endpointId,
        }),
        version,
        active: true,
        createdAt: now,
        expiresAt: null,
      });
      return { row, plaintext };
    } catch (err) {
      if (EndpointSecretsService.isUniqueViolation(err)) {
        // `@@unique([endpointId, version])` did its job: another rotation took
        // this version between our read and our write. Nothing was written, so
        // the endpoint's live secrets are exactly as they were.
        this.logger.warn(
          `Concurrent rotation on endpoint ${endpointId}: version ${version} was already taken.`,
        );
        throw new AppError(
          'conflict',
          'Another rotation for this endpoint is in progress. Retry the request.',
        );
      }
      throw err;
    }
  }

  /**
   * Flip `active` to false on secrets whose window has already closed.
   *
   * Purely housekeeping - `isEffectivelyActive` and the data plane's loader both
   * already treat an expired row as not signing - so it is never the thing that
   * holds the invariant, and it runs only after a new secret exists.
   */
  private async sweepExpired(
    scope: TenantScope,
    endpointId: string,
    secrets: readonly EndpointSecret[],
    now: Date,
  ): Promise<void> {
    const stale = secrets.filter(
      (secret) =>
        secret.active &&
        secret.expiresAt !== null &&
        new Date(secret.expiresAt).getTime() <= now.getTime(),
    );
    if (stale.length === 0) return;
    await scope.endpointSecrets.updateMany(
      { endpointId, id: { in: stale.map((secret) => secret.id) } },
      { active: false },
    );
  }

  /** Duck-typed: the fake used in tests does not throw Prisma's error class. */
  private static isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2002'
    );
  }
}
