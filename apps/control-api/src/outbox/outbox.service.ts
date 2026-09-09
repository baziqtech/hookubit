import { Injectable, Logger } from '@nestjs/common';
import { EventOutbox, Prisma } from '@prisma/client';
import { RequestContext, TenantScope, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import {
  ListOutboxQueryDto,
  OutboxEntryDto,
  OutboxEntryListDto,
  RequeueOutboxDto,
  RequeueParkedDto,
  RequeueResultDto,
  toOutboxEntryDto,
} from './dto';
import { crossTenantNotFound, withCrossTenantNotFound } from './not-found';
import { MAX_REQUEUE_BATCH, REQUEUEABLE_STATUS } from './outbox-limits';

/**
 * The outbox: what the router still owes an accepted event, and the way back
 * when it gives up.
 *
 * ## Why this module exists
 *
 * `POST /v1/projects/:id/events` returns `202 Accepted` once the event and its
 * outbox row are committed together (ARCHITECTURE.md 15/16). That promise is
 * kept by the router, which claims the outbox row and materialises one delivery
 * per matching subscription. When the router cannot - a row that keeps killing
 * the process, or one still failing after its retry duration - it PARKS the row
 * (`event_outbox.status = 'failed'`) and marks the event `failed`.
 *
 * Parking is the right behaviour; a queue a single bad row can block forever is
 * a queue that stops during exactly the incident you need it for. What was
 * missing was the other half. `event_outbox` had **zero references anywhere in
 * this application**: a parked row was invisible to the API and to the
 * dashboard, and an event that had already been answered `202 Accepted` could be
 * permanently undelivered, recoverable only by hand-written SQL against
 * production. ARCHITECTURE.md 57 asks for a defined recovery strategy for every
 * failure mode, and "open psql" is not one.
 *
 * ## Requeue is not replay, and the distinction matters
 *
 * `POST /events/:id/replay` re-sends to the endpoints an event ACTUALLY reached,
 * read off the existing delivery rows, and it refuses an (event, endpoint) pair
 * that was never fanned out - correctly, because that would be a new delivery
 * rather than a replay.
 *
 * A parked event has NO delivery rows. There is nothing for replay to work from,
 * which is why replay cannot be the recovery path here. Requeue does not create
 * deliveries at all: it puts the outbox row back and lets the router run the
 * fan-out it never got to run.
 *
 * That fan-out is bounded to the subscriptions that EXISTED when the event was
 * accepted (`loadCandidatesSQL` in the router: `s.created_at <= events.created_at`),
 * so requeueing an event parked three weeks ago does not hand it to customers
 * who subscribed since. What it does read as of now is their CONFIGURATION -
 * event types, `enabled`, the endpoint's status - and a subscription deleted in
 * the meantime is simply gone. That is the closest thing to the publish-time
 * answer that still exists, and it is the only honest option: the alternative is
 * an event the customer was told we accepted and that nothing will ever deliver.
 *
 * ## What a requeue does not touch
 *
 * `last_error` is preserved. It is the router's field and the only record of why
 * the row was parked; overwriting it at the moment somebody decides the parking
 * was wrong would destroy the evidence. `fan_out_cursor` is preserved too, so a
 * row parked halfway through a wide fan-out resumes rather than re-walking work
 * that already committed - the partial unique index
 * `deliveries_event_endpoint_original_key` makes either choice safe, but
 * resuming is the cheap one.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * A PAGE of outbox rows. `findPage`, never `findMany`: one parked row per
   * event during an incident makes this table large, and a bare array cannot say
   * whether the bound was reached.
   */
  async list(context: RequestContext, query: ListOutboxQueryDto): Promise<OutboxEntryListDto> {
    const page = await this.scopes.for(context).eventOutbox.findPage({
      where: OutboxService.filterWhere(query),
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toOutboxEntryDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /** One row, or the shared 404. */
  async get(context: RequestContext, outboxId: string): Promise<OutboxEntryDto> {
    const scope = this.scopes.for(context);
    const row = await scope.eventOutbox.findById(outboxId);
    if (!row) throw crossTenantNotFound();
    return toOutboxEntryDto(row);
  }

  /**
   * Return ONE parked row to the queue.
   *
   * Read-then-write over the row's status, so it runs through
   * `TenantTransactionRunner`: two operators clicking requeue on the same row
   * must not both see `failed` and both file an audit entry claiming they did
   * it. SERIALIZABLE makes the second one lose, and the callback is replayable -
   * it reads, it updates, it audits, and nothing in it a re-run would double.
   */
  async requeue(
    context: RequestContext,
    outboxId: string,
    dto: RequeueOutboxDto,
  ): Promise<OutboxEntryDto> {
    const row = await withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        const parked = await scope.eventOutbox.findById(outboxId);
        if (!parked) throw crossTenantNotFound();
        OutboxService.assertRequeueable(parked);

        const [requeued] = await OutboxService.returnToQueue(scope, [parked]);
        await audit.record({
          action: 'event_outbox.requeued',
          resourceType: 'event_outbox',
          resourceId: parked.id,
          metadata: {
            event_id: parked.eventId,
            reason: dto.reason ?? null,
            // The state it was rescued FROM. Without this the audit log says
            // somebody pressed a button and not what was wrong.
            parked_error: parked.lastError ?? null,
            parked_attempts: parked.attempts,
            parked_unaccounted_attempts: parked.unaccountedAttempts,
            fan_out_cursor: parked.fanOutCursor ?? null,
            requeued_count: 1,
          },
        });
        return requeued;
      }),
    );

    this.logger.log(
      `Requeued parked outbox row ${row.id} (event ${row.eventId}) in project ${
        context.requireProject().id
      }.`,
    );
    return toOutboxEntryDto(row);
  }

  /**
   * Return up to `MAX_REQUEUE_BATCH` parked rows to the queue, oldest first.
   *
   * The single-row form is unusable at the scale this is actually needed: the
   * incident that parks rows parks them in bulk. Oldest first because those
   * consumers have been waiting longest, and `has_more` so an operator can tell
   * "that is all of them" from "call again" without a second count.
   *
   * Selection happens INSIDE the transaction, against the same snapshot the
   * updates run against, so a row cannot be chosen and then claimed by a
   * concurrent single-row requeue between the read and the write.
   */
  async requeueParked(
    context: RequestContext,
    dto: RequeueParkedDto,
  ): Promise<RequeueResultDto> {
    const result = await withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        // The event is resolved through the scope first, so an id from another
        // tenant is the shared 404 rather than an empty result that reads as
        // "nothing parked" - genuinely different answers.
        if (dto.event_id !== undefined) await scope.eventOutbox.assertOwned('eventId', dto.event_id);

        const where: Prisma.EventOutboxWhereInput = { status: REQUEUEABLE_STATUS };
        if (dto.event_id !== undefined) where.eventId = dto.event_id;

        const page = await scope.eventOutbox.findPage({
          where,
          orderBy: { createdAt: 'asc' },
          take: MAX_REQUEUE_BATCH,
        });

        const requeued = await OutboxService.returnToQueue(scope, page.rows);

        // An audit row even for zero, because "somebody tried to requeue and
        // there was nothing parked" is a fact about an incident too, and a log
        // that only records successes cannot be used to reconstruct one.
        await audit.record({
          action: 'event_outbox.requeued',
          resourceType: 'event_outbox',
          resourceId: dto.event_id ?? null,
          metadata: {
            reason: dto.reason ?? null,
            scope: dto.event_id ? 'event' : 'project',
            requested_event_id: dto.event_id ?? null,
            requeued_count: requeued.length,
            has_more: page.hasMore,
            limit: MAX_REQUEUE_BATCH,
            requeued_outbox_ids: requeued.map((row) => row.id),
            requeued_event_ids: requeued.map((row) => row.eventId),
          },
        });

        return { rows: requeued, hasMore: page.hasMore };
      }),
    );

    this.logger.log(
      `Requeued ${result.rows.length} parked outbox row(s) in project ${
        context.requireProject().id
      }${result.hasMore ? '; more remain' : ''}.`,
    );
    return {
      requeued: result.rows.length,
      has_more: result.hasMore,
      data: result.rows.map(toOutboxEntryDto),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * The whole of the state change, in one place so the single-row and bulk forms
   * cannot drift.
   *
   * ## Why this takes a PAGE rather than a row
   *
   * It used to take one row and the bulk form called it in a loop. Inside one
   * interactive transaction that is a per-row cost of three round trips -
   * `updateById` is an `updateMany` plus a `findFirst` read-back, and the event
   * update is a third - so a full `MAX_REQUEUE_BATCH` page was roughly 300
   * sequential statements. `TenantTransactionRunner` opens its transaction with
   * no `timeout`, so Prisma's default 5000 ms applied: at 20 ms a round trip -
   * entirely plausible on the degraded database that produced the parked rows in
   * the first place - the transaction hit `P2028` and rolled back. `P2028` is
   * not a serialisation failure, so nothing retried, and the operator got a 500
   * having recovered ZERO rows. The recovery path was least reliable exactly
   * when it was needed.
   *
   * Four statements now, whatever the page size: one UPDATE over the outbox
   * rows, one over their events, one read-back, and the caller's audit insert.
   * That is a constant, not a bound, so there is no input to this method that
   * can put the transaction near a timeout and no reason to raise one.
   *
   * The `ScopedRepository` conventions are intact: `updateMany`/`findPage` only,
   * every predicate ANDed under the tenant predicate by `where()`, no
   * `findUnique`/`update`/`delete`, and no primary-key statement that could
   * check ownership only after the fact.
   *
   * ## What it writes
   *
   * The outbox row goes back to `pending` and available immediately. The two
   * BUDGETS are reset - `unaccounted_attempts` (the poison bound) and
   * `failing_since` (the retry-duration clock) - because the operator has looked
   * at the row and decided it deserves a fresh one, which is exactly what those
   * counters are for. `processed_at` is cleared because the row is no longer
   * finished, and a stale timestamp there would make retention treat a live row
   * as an old one.
   *
   * `attempts` is NOT reset, and that is deliberate. It is documented as
   * monotonic in two places that both describe it as the operator's honest
   * "how many times has this been picked up?" - `OutboxRow.Attempts` in
   * services/data-plane/internal/router/store.go and `model EventOutbox` in
   * schema.prisma. Zeroing it here made both comments false after the first
   * requeue: the claim count in the operator UI restarted, and so did the number
   * the router quotes in the next park message, which is the one thing that
   * separates "this row has been requeued four times and keeps dying" from
   * "first time". The counter that decides whether the row parks again is
   * `unaccounted_attempts`, and that IS reset, so preserving `attempts` costs
   * the row nothing.
   *
   * It has one visible consequence, stated rather than hidden: the router's
   * backoff for a released row is computed from `attempts`, so a requeued row
   * whose first new claim fails transiently waits at or near the policy's
   * maximum delay instead of its initial one. That is latency on a row that has
   * already failed repeatedly, bounded by the policy's own cap, and the retry
   * budget it actually spends is the time-based one - which `failing_since:
   * null` has just refunded in full.
   *
   * The event goes `failed -> received`, guarded on `failed`, because that is
   * the honest reversal of what parking did to it. Leaving it `failed` would
   * also break the router: its claim promotes `received -> processing`, so the
   * event would sit reading `failed` right through a fan-out that was working.
   *
   * `last_error` and `fan_out_cursor` are deliberately untouched - see the class
   * docblock.
   */
  private static async returnToQueue(
    scope: TenantScope,
    parked: EventOutbox[],
  ): Promise<EventOutbox[]> {
    if (parked.length === 0) return [];

    const ids = parked.map((row) => row.id);
    // Deduplicated: an event may own more than one outbox row, and repeating an
    // id in an `IN` list is a wasted comparison rather than a second update.
    const eventIds = [...new Set(parked.map((row) => row.eventId))];

    // `status` is re-asserted in the predicate even though the rows were read as
    // parked inside this transaction. It is free, and it means the statement
    // itself - not the read that preceded it - is what refuses to resurrect a
    // row a router has since claimed.
    await scope.eventOutbox.updateMany(
      { id: { in: ids }, status: REQUEUEABLE_STATUS },
      {
        status: 'pending',
        availableAt: new Date(),
        processedAt: null,
        lockedBy: null,
        lockedUntil: null,
        unaccountedAttempts: 0,
        failingSince: null,
      },
    );

    await scope.events.updateMany({ id: { in: eventIds }, status: 'failed' }, { status: 'received' });

    // One read-back for the whole page, in place of the per-row one
    // `updateById` did. `take` is the page's own length - and that length came
    // out of a `findPage` that `ScopedRepository` already clamped to
    // MAX_PAGE_SIZE - so this can never be a truncated read: `hasMore` would
    // have to mean more rows than the ids we just named. If it somehow were
    // short, the map below throws rather than returning a quietly smaller page.
    const page = await scope.eventOutbox.findPage({
      where: { id: { in: ids } },
      take: ids.length,
    });
    const byId = new Map(page.rows.map((row) => [row.id, row]));

    // Returned in the order they were selected (oldest first), not in whatever
    // order the read-back came back in - the caller puts this straight into the
    // response body and into the audit entry.
    return parked.map((row) => {
      const requeued = byId.get(row.id);
      if (!requeued) {
        // Unreachable inside a SERIALIZABLE transaction that just updated the
        // row. Loud rather than a silently short list: the count in the response
        // and in the audit entry is what an operator counts recovered rows by.
        throw new AppError(
          'internal_error',
          `Outbox entry ${row.id} was requeued but could not be read back in the same transaction.`,
        );
      }
      return requeued;
    });
  }

  /**
   * Only a PARKED row may be requeued.
   *
   * A `pending` or `processing` row is already in the queue and the router is
   * working on it; a `processed` row completed. Requeueing either is a no-op the
   * router's idempotency would absorb silently - and an API that accepts a
   * request it knows does nothing teaches the operator that the button does
   * nothing, which is a bad thing to learn during an incident.
   */
  private static assertRequeueable(row: EventOutbox): void {
    if (row.status === REQUEUEABLE_STATUS) return;
    throw new AppError(
      'conflict',
      row.status === 'processed'
        ? `Outbox entry ${row.id} has already been fanned out; there is nothing to requeue. To re-send an event that WAS delivered, replay it: POST /v1/projects/{projectId}/events/${row.eventId}/replay.`
        : `Outbox entry ${row.id} is ${row.status} - it is already in the queue and a router is working on it. Only parked entries (status "failed") can be requeued.`,
      { outbox_id: row.id, event_id: row.eventId, outbox_status: row.status },
    );
  }

  /**
   * The query string, as a WHERE clause. Static and pure so the index claims in
   * `ListOutboxQueryDto` can be checked against one function.
   */
  static filterWhere(query: ListOutboxQueryDto): Prisma.EventOutboxWhereInput {
    const where: Prisma.EventOutboxWhereInput = {};
    if (query.status !== undefined) where.status = query.status;
    if (query.event_id !== undefined) where.eventId = query.event_id;
    return where;
  }
}
