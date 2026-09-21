import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../authz';
// The unscoped client, deliberately. See "Why this is the one module that holds
// PrismaService" in the class docblock; `src/maintenance/**` is allowlisted by
// directory in .eslintrc.json alongside auth, infrastructure, cli and health.
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  AUTO_DISABLE_ADVISORY_LOCK_KEY,
  AUTO_DISABLE_AUDIT_ACTION,
  BreakerSnapshot,
  autoDisableReason,
  hasBeenOpenLongEnough,
} from './auto-disable-policy';

/** What one pass did. Returned so a test - and an operator - can see it. */
export interface AutoDisableReport {
  /** True when another replica held the advisory lock and this pass did nothing. */
  skipped: boolean;
  /** Endpoints examined. */
  considered: number;
  /** Endpoints actually switched off by this pass. */
  disabled: number;
  /**
   * True when the pass stopped on its per-run ceiling rather than because it ran
   * out of candidates. More endpoints are waiting; the next pass takes them.
   */
  truncated: boolean;
}

export interface AutoDisableOptions {
  enabled: boolean;
  afterHours: number;
  maxPerRun: number;
}

/**
 * A row from the candidate query: the breaker's view of a dead endpoint, joined
 * to the tenancy the audit entry has to be filed against.
 */
interface Candidate extends BreakerSnapshot {
  endpointId: string;
  endpointName: string;
  endpointUrl: string;
  projectId: string;
  organizationId: string;
  previousStatus: string;
}

/**
 * Switches off endpoints whose circuit breaker has been open long enough that
 * they are not coming back (docs/FAILURE_RECOVERY.md, G14, first half).
 *
 * ## The gap
 *
 * The breaker removes REQUEST pressure from a dead endpoint within five
 * failures. Nothing removed ROW pressure: every new matching event still fanned
 * out to the corpse, producing a delivery that would be claimed, refused by the
 * open breaker, deferred, re-claimed, and finally expired 24 hours later - for
 * ever, at ingest rate. `disabled_reason` was only ever set to NULL.
 *
 * ## Why the CONTROL plane writes this, and not the data plane
 *
 * The data plane has never issued a write against `endpoints`, and that
 * separation is worth more than the convenience of putting this next to the
 * breaker that produces the signal. Four reasons, in the order they matter:
 *
 *  1. **One writer, one definition of "disabled".** `endpoints` is customer
 *     configuration. The rules around changing it - a deleted endpoint cannot be
 *     modified, an endpoint with no live signing secret cannot be enabled - live
 *     in `EndpointsService`, in TypeScript. A second writer in Go would be a
 *     second copy of those rules, and copies drift.
 *  2. **The audit row is the product feature, not a side effect.** An endpoint
 *     that stops receiving webhooks with no explanation is a support ticket;
 *     the audit log is what makes it self-service. Writing `audit_logs` from the
 *     data plane would mean reimplementing the action vocabulary, the tenancy
 *     resolution and the metadata redaction rule in a second language.
 *  3. **It is not latency-sensitive.** The breaker has already stopped the
 *     requests. This only stops rows accruing, so being a quarter of an hour
 *     late costs a bounded number of delivery rows - never a delivery. If the
 *     control plane is down for an hour, dead endpoints stay enabled for an
 *     hour: time, not data, which is the question ARCHITECTURE.md asks of every
 *     component.
 *  4. **No new coupling.** The signal - `endpoint_health` - is already in the
 *     shared schema and already modelled by Prisma. Nothing had to be exported
 *     from the data plane for this to work.
 *
 * ## What this does NOT do, and why
 *
 * It does not touch `endpoint_health`. The breaker's state machine belongs to
 * the workers, it is what will notice the endpoint coming back, and a disabled
 * endpoint receives no deliveries to probe with anyway. Disabling is a
 * statement about configuration; the health row keeps being a statement about
 * the last thing the network said.
 *
 * ## What happens to the deliveries
 *
 * Both halves of this are already decided elsewhere and this service
 * deliberately joins the existing path rather than inventing a third state:
 *
 *  - **New events stop producing delivery rows.** `router.gate` skips a
 *    candidate whose endpoint is not `active` or not `enabled`
 *    (`SkipEndpointNotActive` / `SkipEndpointDisabled`) and counts the skip, so
 *    "why did finance not get this event?" is answerable from a metric and the
 *    event row, both of which survive. The comment on that branch has always
 *    said "the circuit breaker's auto-disable writes this flag"; this is the
 *    thing it was waiting for.
 *  - **Queued deliveries are CANCELLED, not failed.** A worker that claims a
 *    delivery for a disabled endpoint finishes it `cancelled` with reason
 *    `endpoint_disabled` (`worker.Endpoint.Deliverable`). That is the right
 *    word: we stopped on purpose, which keeps `failed` meaning "the endpoint
 *    rejected it", and it drains the backlog in one pass instead of leaving it
 *    to expire one delivery at a time over the next 24 hours.
 *
 * The ledger is still the record of what SHOULD have been delivered up to the
 * moment we stopped: every delivery created before the disable keeps its row,
 * its attempt history and its terminal state. What the ledger stops recording
 * is deliveries the platform never intended to make - which is what a delivery
 * row for a disabled endpoint would be.
 *
 * ## Why this is the one module that holds PrismaService
 *
 * The sweep is platform-wide by nature: it has no request, no user and no
 * tenant, so there is no `RequestContext` to build a `TenantScope` from and
 * nothing for a tenant predicate to be. `ScopedRepository` is the right tool for
 * a request and the wrong one for a reaper. What replaces the predicate here is
 * that every write is addressed by primary key from a row this transaction just
 * read, and the organization an audit entry is filed against is READ THROUGH THE
 * OWNERSHIP CHAIN (endpoint -> project -> organization) rather than stated.
 */
@Injectable()
export class EndpointAutoDisableService {
  private readonly logger = new Logger(EndpointAutoDisableService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: NotificationDispatcher,
  ) {}

  /**
   * One pass.
   *
   * ONE TRANSACTION, for the whole pass, and it is doing two jobs at once.
   *
   * The first is atomicity between a disable and the audit row that explains it
   * - `AuditService`'s own docblock asks for exactly this, and a disable that
   * commits without its explanation is the silent switch-off this service
   * exists to avoid.
   *
   * The second is mutual exclusion. The control API is horizontally scaled, so
   * every replica runs this timer. `pg_try_advisory_xact_lock` makes the pass a
   * singleton with no leader election and no lease to expire: it is TRY, so a
   * replica that does not get it returns immediately instead of queueing, and it
   * is XACT, so it is released by COMMIT, by ROLLBACK and by the connection
   * dying. A replica killed mid-pass cannot hold it.
   *
   * The per-run ceiling is what keeps that transaction short. It also bounds the
   * blast radius: if a shared dependency takes a thousand endpoints down at
   * once, this is a gradual, visible drain an operator can stop rather than
   * "the platform disabled everything you have in one minute".
   */
  async sweep(options: AutoDisableOptions, now: Date = new Date()): Promise<AutoDisableReport> {
    const empty: AutoDisableReport = {
      skipped: false,
      considered: 0,
      disabled: 0,
      truncated: false,
    };
    if (!options.enabled) return empty;

    return this.prisma.$transaction(
      async (tx) => {
        if (!(await EndpointAutoDisableService.takeLock(tx))) {
          return { ...empty, skipped: true };
        }

        const candidates = await this.candidates(tx, options, now);
        let disabled = 0;
        for (const candidate of candidates) {
          // The same test the query already applied, re-applied in process.
          // The query is what makes the scan cheap; this is what makes the
          // decision reviewable and testable without a database, and it is the
          // one that would catch a predicate that drifted.
          if (!hasBeenOpenLongEnough(candidate, now, options.afterHours)) continue;
          if (await this.disable(tx, candidate, options, now)) disabled += 1;
        }

        return {
          skipped: false,
          considered: candidates.length,
          disabled,
          truncated: candidates.length >= options.maxPerRun,
        };
      },
      // Generous next to a request handler, because this is not one. The
      // ceiling on the work is `maxPerRun`, not the clock; a timeout here would
      // roll back a pass that was making progress.
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /**
   * Endpoints whose breaker has been open past the window, oldest first.
   *
   * `state: 'open'` and not `half_open`: half-open means a worker is holding the
   * probe slot at this instant, and an endpoint one second away from answering
   * a probe should not be switched off. The row returns to `open` when the probe
   * fails, so a genuinely dead endpoint is caught on the next pass.
   *
   * `status: 'active', enabled: true` keeps the pass idempotent - an endpoint
   * this sweep has already disabled is not a candidate again - and keeps it from
   * overwriting an operator's own pause, which sets `status = 'paused'` and
   * deliberately leaves `disabled_reason` NULL.
   *
   * Ordered by `openedAt` so that when the ceiling binds, the endpoints that
   * have been dark longest are the ones taken first.
   */
  private async candidates(
    tx: Prisma.TransactionClient,
    options: AutoDisableOptions,
    now: Date,
  ): Promise<Candidate[]> {
    const cutoff = new Date(now.getTime() - options.afterHours * 3_600_000);
    const rows = await tx.endpointHealth.findMany({
      where: {
        state: 'open',
        openedAt: { lte: cutoff },
        endpoint: { status: 'active', enabled: true },
      },
      orderBy: { openedAt: 'asc' },
      take: options.maxPerRun,
      select: {
        endpointId: true,
        openedAt: true,
        consecutiveFailures: true,
        lastSuccessAt: true,
        endpoint: {
          select: {
            name: true,
            url: true,
            status: true,
            projectId: true,
            // The organization is READ THROUGH THE CHAIN rather than taken from
            // a denormalised column. It is the organization the audit row is
            // filed against, and this service has no tenant context to check a
            // stated one against.
            project: { select: { organizationId: true } },
          },
        },
      },
    });

    return rows.map((row) => ({
      endpointId: row.endpointId,
      openedAt: row.openedAt,
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt,
      endpointName: row.endpoint.name,
      endpointUrl: row.endpoint.url,
      previousStatus: row.endpoint.status,
      projectId: row.endpoint.projectId,
      organizationId: row.endpoint.project.organizationId,
    }));
  }

  /**
   * Disable one endpoint and file the audit entry, or do neither.
   *
   * The UPDATE repeats `status: 'active', enabled: true` in its predicate. That
   * is not belt and braces - it is the whole concurrency story. The candidate
   * was read at the top of this transaction; between then and here an operator
   * may have paused it, deleted it, or a racing replica may have disabled it. A
   * conditional update either matches the row it read or matches nothing, and
   * the audit row is written only in the first case. Without it a customer who
   * had just deleted an endpoint would get an audit entry saying the platform
   * auto-disabled it.
   *
   * `status: 'disabled'` rather than `'paused'`: `paused` is the state an
   * operator's own `POST /disable` produces, and the two must stay
   * distinguishable in a listing. Both stop delivery identically as far as the
   * data plane is concerned - `worker.Endpoint.Deliverable` treats `paused`,
   * `disabled` and `enabled: false` the same - so this is about who did it, not
   * about what happens next.
   */
  private async disable(
    tx: Prisma.TransactionClient,
    candidate: Candidate,
    options: AutoDisableOptions,
    now: Date,
  ): Promise<boolean> {
    const reason = autoDisableReason(candidate, now);
    const updated = await tx.endpoint.updateMany({
      where: { id: candidate.endpointId, status: 'active', enabled: true },
      data: {
        status: 'disabled',
        enabled: false,
        disabledReason: reason,
        disabledAt: now,
        updatedAt: now,
      },
    });
    if (updated.count === 0) return false;

    await this.audit.recordSystem(
      candidate.organizationId,
      {
        action: AUTO_DISABLE_AUDIT_ACTION,
        resourceType: 'endpoint',
        resourceId: candidate.endpointId,
        metadata: {
          project_id: candidate.projectId,
          name: candidate.endpointName,
          url: candidate.endpointUrl,
          previous_status: candidate.previousStatus,
          reason,
          circuit_open_since: candidate.openedAt?.toISOString() ?? null,
          consecutive_failures: candidate.consecutiveFailures,
          last_success_at: candidate.lastSuccessAt?.toISOString() ?? null,
          threshold_hours: options.afterHours,
          // Stated so the entry reads correctly to a customer who has never
          // heard of this sweep: nothing they did caused it, and the remedy is
          // a route they already have.
          remedy: 'POST /v1/projects/{projectId}/endpoints/{endpointId}/enable',
        },
      },
      tx,
    );
    this.logger.warn(
      `Endpoint ${candidate.endpointId} (${candidate.endpointUrl}) was auto-disabled: ${reason}`,
    );

    /*
     * Tell somebody. This is the design's most urgent trigger and the only one
     * that wakes people out of hours, because the consequence is not "a
     * delivery failed" — it is that every new matching event now creates
     * nothing for this endpoint until a human acts.
     *
     * OUTSIDE the transaction and never awaited into the result: sending mail
     * inside a SERIALIZABLE transaction holds it open for an SMTP round trip,
     * and a failure must not roll back a disable that has already been decided.
     * The dispatcher swallows its own errors and records them on the
     * destination, where the operator can see them.
     */
    void this.alerts
      .alert({
        projectId: candidate.projectId,
        event: 'endpoint.stopped',
        subject: `endpoint:${candidate.endpointId}:stopped`,
        headline: `We stopped sending to ${candidate.endpointName}`,
        body:
          `${candidate.endpointName} failed ${candidate.consecutiveFailures} times in a row, so we stopped sending to it. ` +
          'New events create nothing for this endpoint and queued deliveries are being cancelled until someone starts it again. ' +
          'Nothing you did caused this, and starting it again is a button on the endpoint.',
        link: `/orgs/${candidate.organizationId}/projects/${candidate.projectId}/endpoints/${candidate.endpointId}`,
      })
      .catch(() => undefined);

    return true;
  }

  /**
   * `pg_try_advisory_xact_lock` - TRY, so a replica that loses returns rather
   * than queueing behind the winner and running the pass again immediately
   * afterwards.
   */
  private static async takeLock(tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${AUTO_DISABLE_ADVISORY_LOCK_KEY}::bigint) AS locked`;
    return rows[0]?.locked === true;
  }
}
