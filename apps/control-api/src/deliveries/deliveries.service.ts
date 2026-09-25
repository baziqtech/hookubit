import { Injectable } from '@nestjs/common';
import { Delivery, Prisma } from '@prisma/client';
import { RequestContext, TenantScope, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import {
  PAYLOAD_PREVIEW_READ_BYTES,
  PayloadPreview,
  previewPayload,
} from '../events/event-payload';
import { DeliveryReplayService } from './delivery-replay.service';
import { FAILING_NOW_STATUSES, MAX_INLINE_ATTEMPTS } from './delivery-limits';
import {
  DeliveryAttemptListDto,
  DeliveryDetailDto,
  DeliveryListDto,
  ListAttemptsQueryDto,
  ListDeliveriesQueryDto,
  ReplayDeliveryDto,
  ReplayResultDto,
  toAttemptDto,
  toDeliveryDto,
  toDeliveryListItemDto,
  toEndpointRef,
  toEventRef,
} from './dto';
import { crossTenantNotFound, withCrossTenantNotFound } from './not-found';

/**
 * What a list row says when the event row behind it could not be read at all.
 *
 * Not "an empty payload": `null` throughout, and `truncated: false` so nothing
 * renders an ellipsis after nothing.
 */
const NO_PAYLOAD_PREVIEW: PayloadPreview = Object.freeze({
  preview: null,
  size: null,
  truncated: false,
});

/**
 * The delivery ledger: one row per (event, endpoint), each with its own retry
 * chain, and the append-only attempt history hanging off it.
 *
 * This module is the answer to the question the product exists to answer. From
 * ARCHITECTURE.md 34 and the project brief: *the reason people pay for a
 * webhook platform is not the retry loop, it is answering "what happened to
 * this event?" at 2am — if a human needs psql to answer that, the product is
 * not finished.* Every choice below is measured against that:
 *
 *  - `GET /deliveries/:id` returns the delivery, the event it came from, the
 *    endpoint as it stands NOW, and the full ordered attempt history - because
 *    the person asking has one delivery id and no patience for three requests.
 *  - `locked_by`/`locked_until` are on the wire, because "stuck in processing"
 *    is a real 2am state and the lease is what distinguishes a busy worker from
 *    a crashed one.
 *  - `failing_now` exists because "show me what is broken right now" is the
 *    first thing anyone types, and making them enumerate three statuses is how
 *    they end up in psql.
 *
 * ## This module writes exactly one thing
 *
 * Replays. There is no status write, no cancel, no "retry now" that mutates a
 * row - the data plane owns the delivery state machine, and a control-plane
 * UPDATE racing a worker's lease is a corruption this API is not going to
 * introduce. Everything else here is a read.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly replays: DeliveryReplayService,
  ) {}

  /**
   * A PAGE of deliveries, and whether there are more.
   *
   * `findPage`, never `findMany`: `deliveries` is one of the two largest tables
   * in the system, and a bounded read that returns a bare array cannot tell its
   * caller the bound was reached. See `ListDeliveriesQueryDto` for which filter
   * rides which index and which one is a scan.
   */
  async list(context: RequestContext, query: ListDeliveriesQueryDto): Promise<DeliveryListDto> {
    const scope = this.scopes.for(context);
    const page = await scope.deliveries.findPage({
      where: DeliveriesService.filterWhere(query),
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    const previews = await DeliveriesService.payloadPreviews(scope, page.rows);
    return {
      data: page.rows.map((delivery) =>
        toDeliveryListItemDto(delivery, previews.get(delivery.eventId) ?? NO_PAYLOAD_PREVIEW),
      ),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * The payload preview for every row of a page: TWO statements for the page,
   * never one per row.
   *
   * Materialised routing means one event becomes N delivery rows, so a page of a
   * broadcast is mostly the SAME event repeated - the ids are deduplicated
   * first, and a 200-row page of one broadcast asks about one event. The
   * statement itself slices in PostgreSQL (`substring(payload_raw from 1 for
   * N)`), so a 1 MiB body costs 640 bytes on the wire, and it never touches
   * object storage: an offloaded payload has `payload_raw` NULL and comes back
   * as a null preview with its size intact, rather than 200 S3 round trips
   * hanging off a list request.
   *
   * An event id with no row - another tenant's, or one whose event is gone -
   * simply has no entry, and the caller renders no preview. The delivery is
   * still the record of what should have been delivered, which is the whole
   * point of the table; a missing event does not get to fail the listing.
   */
  private static async payloadPreviews(
    scope: TenantScope,
    rows: readonly Delivery[],
  ): Promise<Map<string, PayloadPreview>> {
    const eventIds = [...new Set(rows.map((row) => row.eventId))];
    const heads = await scope.eventPayloadHeads(eventIds, PAYLOAD_PREVIEW_READ_BYTES);

    const previews = new Map<string, PayloadPreview>();
    for (const eventId of eventIds) {
      const head = heads.get(eventId);
      if (!head) continue;
      previews.set(
        eventId,
        previewPayload({
          head: head.head ?? null,
          inlineBytes: head.inline_bytes ?? null,
          payloadSize: head.payload_size ?? null,
          payloadLocation: head.payload_location ?? null,
        }),
      );
    }
    return previews;
  }

  /**
   * Every delivery an event was routed to. "Did finance ever receive this?"
   *
   * Called by the events module for `GET /events/:id/deliveries`. The event id
   * is forced onto the predicate here rather than trusted from `event_id` in
   * the query string, so the route cannot be turned into a general listing by
   * a client that passes both.
   */
  async listForEvent(
    context: RequestContext,
    eventId: string,
    query: ListDeliveriesQueryDto,
  ): Promise<DeliveryListDto> {
    return this.list(context, { ...query, event_id: eventId });
  }

  /**
   * One delivery, with everything a human needs to explain it.
   *
   * Four reads, deliberately, rather than a Prisma `include`: `include` is a
   * nested read that `ScopedRepository` does not expose, and reaching for the
   * unscoped client to get it would be trading the tenant predicate for a round
   * trip. Each of the four carries its own predicate.
   */
  async get(context: RequestContext, deliveryId: string): Promise<DeliveryDetailDto> {
    const scope = this.scopes.for(context);
    const delivery = await this.require(scope, deliveryId);

    const [event, endpoint, attempts] = await Promise.all([
      scope.events.findById(delivery.eventId),
      scope.endpoints.findById(delivery.endpointId),
      scope.deliveryAttempts.findPage({
        where: { deliveryId: delivery.id },
        // Ascending: the history reads as a story, and attempt 1 is where it
        // starts. `(delivery_id, attempt_number)` is unique, so this is a total
        // order with no ties to break.
        orderBy: { attemptNumber: 'asc' },
        take: MAX_INLINE_ATTEMPTS,
      }),
    ]);

    // Both are ON DELETE RESTRICT and endpoints are soft-deleted, so neither can
    // actually be missing. If one ever is, the delivery is still the record of
    // what should have happened and must stay readable - losing the operator
    // surface at the moment the data is already wrong is the worst possible
    // failure mode for this response.
    if (!event || !endpoint) throw crossTenantNotFound();

    return {
      ...toDeliveryDto(delivery),
      event: toEventRef(event),
      endpoint: toEndpointRef(endpoint),
      attempts: attempts.rows.map(toAttemptDto),
      attempts_truncated: attempts.hasMore,
    };
  }

  /**
   * The attempt history, paged, for the rare delivery with more attempts than
   * `GET /deliveries/:id` inlines.
   *
   * The delivery is resolved first, through the scope, so a caller cannot use
   * this route to probe for delivery ids: an id outside the tenant 404s before
   * any attempt is read, with the same message as everything else.
   */
  async listAttempts(
    context: RequestContext,
    deliveryId: string,
    query: ListAttemptsQueryDto,
  ): Promise<DeliveryAttemptListDto> {
    const scope = this.scopes.for(context);
    const delivery = await this.require(scope, deliveryId);

    const page = await scope.deliveryAttempts.findPage({
      where: { deliveryId: delivery.id },
      orderBy: { attemptNumber: 'asc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toAttemptDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * Re-deliver one delivery. A NEW row; the original is not touched.
   *
   * Replaying a replay is allowed and chains: `replay_of_delivery_id` names the
   * row that was replayed, not the ultimate original. That is the honest
   * record - "I replayed the replay" is what happened - and the chain is
   * walkable in either direction.
   */
  async replay(
    context: RequestContext,
    deliveryId: string,
    dto: ReplayDeliveryDto,
  ): Promise<ReplayResultDto> {
    const created = await withCrossTenantNotFound(
      this.replays.replay(
        context,
        async (scope) => {
          const delivery = await this.require(scope, deliveryId);
          return {
            originals: [delivery],
            action: 'delivery.replayed',
            resourceType: 'delivery',
            resourceId: delivery.id,
            metadata: {
              event_id: delivery.eventId,
              endpoint_id: delivery.endpointId,
              original_status: delivery.status,
              original_attempt_count: delivery.attemptCount,
            },
          };
        },
        dto.reason ?? null,
      ),
    );
    return DeliveriesService.toReplayResult(created);
  }

  // -------------------------------------------------------------------------

  /** 404 with the shared message for absent AND for another tenant's row. */
  private async require(scope: TenantScope, deliveryId: string): Promise<Delivery> {
    const delivery = await scope.deliveries.findById(deliveryId);
    if (!delivery) throw crossTenantNotFound();
    return delivery;
  }

  static toReplayResult(created: Delivery[]): ReplayResultDto {
    return {
      deliveries: created.map(toDeliveryDto),
      replayed_count: created.length,
      replay_of: created.map((delivery) => delivery.replayOfDeliveryId ?? ''),
    };
  }

  /**
   * The query string, as a WHERE clause.
   *
   * Static and pure so it can be unit tested without a database, and so the
   * index argument in `ListDeliveriesQueryDto` can be checked against one
   * function rather than against three call sites.
   */
  static filterWhere(query: ListDeliveriesQueryDto): Prisma.DeliveryWhereInput {
    const where: Prisma.DeliveryWhereInput = {};

    // Refused rather than resolved. `status=succeeded&failing_now=true` is a
    // contradiction, and picking a winner would silently answer a question the
    // caller did not ask - on the one screen where a wrong answer sends someone
    // looking for a delivery that is not in the list.
    if (query.failing_now === true && query.status !== undefined) {
      throw new AppError(
        'invalid_request',
        "'status' and 'failing_now' contradict each other. `failing_now=true` is exactly `status IN (retrying, failed, exhausted)`; pass one of them.",
      );
    }

    if (query.status !== undefined) where.status = query.status;
    else if (query.failing_now === true) where.status = { in: [...FAILING_NOW_STATUSES] };

    if (query.endpoint_id !== undefined) where.endpointId = query.endpoint_id;
    if (query.event_id !== undefined) where.eventId = query.event_id;
    // A relation filter, so the join happens in PostgreSQL. Not indexed - see
    // the DTO. An id from another tenant simply matches nothing here: the
    // tenant predicate is ANDed on top, so a filter cannot be used to probe.
    if (query.event_type !== undefined) where.event = { eventType: query.event_type };

    const createdAt = dateRange(query.created_after, query.created_before);
    if (createdAt) where.createdAt = createdAt;

    if (query.origin === 'original') where.replayOfDeliveryId = null;
    if (query.origin === 'replay') where.replayOfDeliveryId = { not: null };

    return where;
  }
}

/**
 * `created_after`/`created_before` as one range filter, or nothing.
 *
 * Lower bound inclusive, upper bound EXCLUSIVE. That is the only pair that
 * makes adjacent windows tile without overlapping, which is what an operator
 * walking backwards hour by hour is doing - `lte` on the upper bound returns
 * the boundary row in both windows and makes a delivery look duplicated.
 *
 * Exported for the events module, which pages the same way over the same
 * column.
 */
export function dateRange(
  after: Date | undefined,
  before: Date | undefined,
): Prisma.DateTimeFilter | undefined {
  if (after === undefined && before === undefined) return undefined;
  if (after !== undefined && before !== undefined && after.getTime() >= before.getTime()) {
    throw new AppError(
      'invalid_request',
      "'created_after' must be strictly before 'created_before'; as given, the range selects nothing.",
    );
  }
  const filter: Prisma.DateTimeFilter = {};
  if (after !== undefined) filter.gte = after;
  if (before !== undefined) filter.lt = before;
  return filter;
}
