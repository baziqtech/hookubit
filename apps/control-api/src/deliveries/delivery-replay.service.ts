import { Injectable, Logger } from '@nestjs/common';
import { Delivery, Endpoint, EndpointStatus } from '@prisma/client';
import { AuditAction, RequestContext, TenantScope } from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import { MAX_REPLAY_FAN_OUT } from './delivery-limits';
import { crossTenantNotFound } from './not-found';
import { currentTraceparent } from './trace-context';

/**
 * What one replay request is going to do, decided inside the transaction.
 *
 * The originals are chosen by the caller (a single delivery, one endpoint's
 * delivery, or every endpoint an event reached) but they are chosen INSIDE the
 * transaction, against the same snapshot the inserts run against - otherwise a
 * delivery could be selected, then deleted or re-pointed, before the replay of
 * it lands.
 */
export interface ReplayPlan {
  /** The delivery rows being replayed. Never mutated. */
  originals: Delivery[];
  /** `event.replayed` / `delivery.replayed`. */
  action: AuditAction;
  resourceType: string;
  /** The thing the operator asked about: an event id or a delivery id. */
  resourceId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Replay: the one route in this API that manufactures outbound traffic.
 *
 * ## The invariant, and the index that enforces half of it
 *
 * ARCHITECTURE.md 34 is unambiguous: *do not overwrite original delivery
 * history; the original delivery remains immutable.* Nothing in this file
 * issues an UPDATE or a DELETE against `deliveries` or `delivery_attempts`.
 * A replay is an INSERT and only an INSERT:
 *
 *   - `replay_of_delivery_id` names the row being replayed,
 *   - `replayed_by` names the human who asked,
 *   - `attempt_count` restarts at 0 with a fresh budget,
 *   - the original keeps its status, its attempt count, its `last_error`, its
 *     timestamps and every one of its `delivery_attempts` rows.
 *
 * Setting `replay_of_delivery_id` is not decoration. The database carries
 *
 *     CREATE UNIQUE INDEX deliveries_event_endpoint_original_key
 *       ON deliveries (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL;
 *
 * which is the arbiter the fan-out router names in its `ON CONFLICT` so a
 * re-run router cannot double-fan-out. It is PARTIAL precisely so replay can
 * legitimately create a second row for the same `(event, endpoint)` pair. An
 * insert here that forgot `replay_of_delivery_id` would therefore collide with
 * the ORIGINAL row - and the natural "fix" for that collision is an upsert,
 * which is exactly the history-destroying write the section forbids. The
 * concurrency suite pins this: the pre-fix shape (insert with no
 * `replay_of_delivery_id`) is run against the same property check and fails on
 * the index.
 *
 * ## Refusals are better than silence
 *
 * A replay to a soft-deleted or disabled endpoint would be accepted, queued,
 * picked up by a worker and immediately abandoned with `endpoint_deleted` /
 * `endpoint_disabled` (see `worker/state.go`). The operator would have watched
 * a 202 turn into a second failed delivery. It is refused here instead, with
 * the endpoint's current status in the error details.
 *
 * ## Bounded on purpose
 *
 * `MAX_REPLAY_FAN_OUT` caps one request. See its docblock for both reasons.
 */
@Injectable()
export class DeliveryReplayService {
  private readonly logger = new Logger(DeliveryReplayService.name);

  constructor(private readonly transactions: TenantTransactionRunner) {}

  /**
   * Run `plan` and insert one new delivery per original, atomically with the
   * audit row.
   *
   * `TenantTransactionRunner` gives SERIALIZABLE plus a bounded retry, and the
   * callback is replayable: it reads, it inserts, it audits, and it does
   * nothing a re-run would double. No HTTP is made here - the data plane's
   * PostgreSQL queue polls `status IN ('pending', ...) AND next_attempt_at <=
   * now()`, so the insert IS the enqueue and a rolled-back transaction leaves
   * nothing behind to deliver.
   */
  async replay(
    context: RequestContext,
    plan: (scope: TenantScope) => Promise<ReplayPlan>,
    reason?: string | null,
  ): Promise<Delivery[]> {
    // The operator's request is the CAUSE of every row this creates, so its
    // trace context is what the worker should link each replay attempt to.
    // Captured here, before the transaction opens, so that what is stamped is
    // the request span - not whatever inner span a transaction runner or a
    // database hook may make active later - and captured once, because a
    // fan-out of fifty replays has one cause, not fifty. Null when tracing is
    // off or nothing is active; see currentTraceparent.
    const traceContext = currentTraceparent();

    return this.transactions.run(context, async (scope, audit) => {
      const { originals, action, resourceType, resourceId, metadata } = await plan(scope);

      DeliveryReplayService.assertWithinFanOut(originals.length);

      // Every endpoint is resolved and checked BEFORE anything is written, so a
      // fan-out with one disabled endpoint in it fails as a whole rather than
      // half-replaying and then erroring. The transaction would roll the
      // inserts back anyway; doing it in this order also makes the error name
      // the endpoint that caused it rather than the first one that happened to
      // be reached.
      const endpoints = await this.resolveEndpoints(scope, originals);

      const now = new Date();
      const created: Delivery[] = [];
      for (const original of originals) {
        created.push(await this.insertReplay(scope, context, original, now, traceContext));
      }

      await audit.record({
        action,
        resourceType,
        resourceId,
        metadata: {
          ...(metadata ?? {}),
          reason: reason ?? null,
          replayed_count: created.length,
          // Both sides of the mapping, because "which rows did this create?" and
          // "which rows did it re-send?" are different questions and the audit
          // log is the only place both are answerable after the fact.
          replay_of_delivery_ids: originals.map((original) => original.id),
          created_delivery_ids: created.map((delivery) => delivery.id),
          endpoint_ids: [...endpoints.keys()],
        },
      });

      this.logger.log(
        `Replayed ${created.length} deliver${created.length === 1 ? 'y' : 'ies'} in project ${
          context.requireProject().id
        } for ${resourceType} ${resourceId}.`,
      );
      return created;
    });
  }

  /**
   * The insert. Column by column, and every one of them deliberate.
   *
   * `subscriptionId` is carried over only if that subscription still exists.
   * `webhook_subscriptions` rows are hard-deletable, and `ScopedRepository`
   * proves every declared foreign key resolves inside the tenant before
   * writing - so blindly copying the id off a months-old delivery whose
   * subscription has since been deleted would fail the whole replay with a 404
   * about a resource the operator never mentioned. The provenance that matters
   * is `replay_of_delivery_id`, which points at a row that can never be deleted
   * (`deliveries.event_id`/`endpoint_id` are ON DELETE RESTRICT).
   *
   * `traceContext` is the OPERATOR'S, never the original's. The original's
   * `trace_context` names the router span that fanned it out, weeks ago on a
   * request that has nothing to do with this one; copying it would attribute
   * this replay to that request. A replay is new work with a new cause
   * (migration 20260910000000 makes the same argument for why `events` carries
   * no trace context at all), and the cause is the request being handled now.
   */
  private async insertReplay(
    scope: TenantScope,
    context: RequestContext,
    original: Delivery,
    now: Date,
    traceContext: string | null,
  ): Promise<Delivery> {
    const subscriptionId =
      original.subscriptionId && (await scope.subscriptions.findById(original.subscriptionId))
        ? original.subscriptionId
        : null;

    return scope.deliveries.create({
      id: newId('delivery'),
      eventId: original.eventId,
      endpointId: original.endpointId,
      subscriptionId,
      // A fresh lifecycle. `pending` with `next_attempt_at = now` is exactly
      // what the fan-out router writes, and it is what the queue's ready
      // predicate claims - see services/data-plane/internal/queue/postgres.go.
      status: 'pending',
      attemptCount: 0,
      // The budget the original was given, not today's policy: a replay of a
      // delivery is a re-run of that delivery, and silently widening or
      // narrowing its retry budget would make the two incomparable.
      maxAttempts: original.maxAttempts,
      nextAttemptAt: now,
      lastAttemptAt: null,
      completedAt: null,
      orderingKey: original.orderingKey,
      lockedBy: null,
      lockedUntil: null,
      // THE two columns that make this a replay rather than a collision.
      replayOfDeliveryId: original.id,
      replayedBy: context.user.userId,
      lastError: null,
      traceContext,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Endpoint id -> the endpoint row, for every distinct endpoint in the plan.
   *
   * Read through the scoped repository, so an endpoint outside the tenant is a
   * 404 rather than a row. Deduplicated because replay-to-all can name the same
   * endpoint only once today, but nothing stops a caller's plan from repeating
   * one, and re-reading it per delivery would multiply the statement count
   * inside a SERIALIZABLE transaction for no gain.
   */
  private async resolveEndpoints(
    scope: TenantScope,
    originals: Delivery[],
  ): Promise<Map<string, Endpoint>> {
    const endpoints = new Map<string, Endpoint>();
    for (const original of originals) {
      if (endpoints.has(original.endpointId)) continue;
      const endpoint = await scope.endpoints.findById(original.endpointId);
      // Unreachable through the tenant scope - the delivery was read through
      // the `delivery -> endpoint -> project` chain, so its endpoint is in this
      // tenant by construction. Answered as a 404 anyway rather than a crash.
      if (!endpoint) throw crossTenantNotFound();
      assertReplayable(endpoint);
      endpoints.set(endpoint.id, endpoint);
    }
    return endpoints;
  }

  private static assertWithinFanOut(count: number): void {
    if (count <= MAX_REPLAY_FAN_OUT) return;
    throw new AppError(
      'limit_exceeded',
      `A single replay may create at most ${MAX_REPLAY_FAN_OUT} deliveries, and this one would create ${count}. Replay to one endpoint at a time.`,
      { limit: MAX_REPLAY_FAN_OUT, current: count, resource: 'replay_fan_out' },
    );
  }
}

/**
 * Refuse a replay that would be queued to nowhere.
 *
 * The three states, and why each is refused rather than accepted:
 *
 *  - `deleted` - a soft delete. The endpoint row survives forever because the
 *    ledger points at it, but nothing is ever delivered to it again.
 *  - `disabled` - the circuit breaker took it out, or an operator did.
 *    `disabled_reason` says which; it is in the error details.
 *  - `paused`, or `enabled = false` - operator intent, and the same outcome.
 *
 * In every case the worker would abandon the delivery on pickup and the
 * operator would have watched an accepted replay become a second failure. A 409
 * naming the current status is a better answer than a 202 that is not true.
 */
export function assertReplayable(endpoint: Endpoint): void {
  if (endpoint.status === EndpointStatus.deleted) {
    throw new AppError(
      'conflict',
      `Endpoint ${endpoint.id} has been deleted. Its delivery history is kept, but nothing can be delivered to it again - a replay would be abandoned by the worker as 'endpoint_deleted'.`,
      { endpoint_id: endpoint.id, endpoint_status: endpoint.status },
    );
  }
  if (endpoint.status !== EndpointStatus.active || !endpoint.enabled) {
    throw new AppError(
      'conflict',
      `Endpoint ${endpoint.id} is ${endpoint.status} and is not accepting deliveries. Re-enable it first, or the replay would be abandoned by the worker as 'endpoint_disabled'.`,
      {
        endpoint_id: endpoint.id,
        endpoint_status: endpoint.status,
        enabled: endpoint.enabled,
        disabled_reason: endpoint.disabledReason ?? null,
      },
    );
  }
}
