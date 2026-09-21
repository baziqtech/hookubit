import { Injectable } from '@nestjs/common';
import { Delivery, DeliveryStatus, Event, Prisma } from '@prisma/client';
import { MAX_PAGE_SIZE, RequestContext, TenantScope, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { DeliveriesService, dateRange } from '../deliveries/deliveries.service';
import { MAX_REPLAY_FAN_OUT } from '../deliveries/delivery-limits';
import { DeliveryReplayService } from '../deliveries/delivery-replay.service';
import {
  DeliveryListDto,
  ListDeliveriesQueryDto,
  ReplayEventDto,
  ReplayResultDto,
} from '../deliveries/dto';
import {
  EventDetailDto,
  EventListDto,
  ListEventsQueryDto,
  toEventDetailDto,
  toEventDto,
} from './dto';
import { DeliveryRollup, emptyCounts, rollUp } from './delivery-rollup';
import { crossTenantNotFound, withCrossTenantNotFound } from './not-found';

/**
 * Events: what was published, and what became of it.
 *
 * An event is written once; the fan-out materialises it into one `deliveries`
 * row per matching subscription, each with an independent retry chain. That
 * choice - copied deliberately from Convoy, see CLAUDE.md - is what makes
 * per-endpoint replay possible and what makes "did finance ever receive this?"
 * a query rather than an inference. This module exposes both halves: the event,
 * and the fan-out it produced.
 *
 * ## Two rules that shape everything here
 *
 * **`payload_raw` is authoritative; `payload` (jsonb) is not.** The distinction
 * is on the wire, not in a comment - see `event-payload.ts`. A payload screen
 * that shows the jsonb copy as "the payload" sends someone debugging a
 * signature failure into the wrong system.
 *
 * **Replay uses history, not a re-match.** `POST /events/:id/replay` re-sends
 * to the endpoints the event ACTUALLY reached, read off the existing delivery
 * rows. It never re-runs the subscription match. Subscriptions are mutable:
 * re-matching a three-week-old event against today's subscriptions would
 * deliver it to endpoints that were never targeted and skip ones that were, and
 * the operator asking for a replay is asking about what happened.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly deliveries: DeliveriesService,
    private readonly replays: DeliveryReplayService,
  ) {}

  /**
   * A PAGE of events. Never the payloads - see `EventDto`.
   *
   * `findPage`, never `findMany`: this is the largest table in the system, and
   * a bare array cannot say whether the bound was reached.
   */
  async list(context: RequestContext, query: ListEventsQueryDto): Promise<EventListDto> {
    const scope = this.scopes.for(context);
    const page = await scope.events.findPage({
      where: EventsService.filterWhere(query),
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });

    const rollups = await this.rollUpDeliveries(
      scope,
      page.rows.map((event) => event.id),
      page.rows,
    );

    return {
      data: page.rows.map((event) => toEventDto(event, rollups.get(event.id))),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * What became of each event on this page, in one grouped query per 200
   * groups.
   *
   * ## Why the list needs this at all
   *
   * `Event.status` is the ingest/fan-out state: `processed` means the router
   * ran and committed, and says nothing about whether anyone received
   * anything. A list built on it reports a project as healthy while every
   * delivery it produced is failing, and it cannot express `dropped` - fan-out
   * completed and matched nobody - which is the state newcomers actually hit.
   *
   * ## Why it is paged rather than one query
   *
   * `groupBy(['eventId', 'status'])` produces up to nine groups per event, so a
   * 50-event page is 450 groups against a `MAX_PAGE_SIZE` of 200 - and
   * `ScopedRepository.groupBy` with an explicit take SLICES. A silently
   * truncated rollup would show `delivered` on an event whose failures fell off
   * the end, which is the one error this column must not make. So it walks
   * pages until one comes back short: three queries for a default page, nine
   * for the largest one the API allows.
   *
   * Never one query per event. That is the N+1 this method exists to avoid.
   */
  private async rollUpDeliveries(
    scope: TenantScope,
    eventIds: string[],
    events: Event[],
  ): Promise<Map<string, DeliveryRollup>> {
    const rollups = new Map<string, DeliveryRollup>();
    if (eventIds.length === 0) return rollups;

    const counts = new Map<string, Record<DeliveryStatus, number>>();
    for (const id of eventIds) counts.set(id, emptyCounts());

    for (let skip = 0; ; skip += MAX_PAGE_SIZE) {
      const groups = await scope.deliveries.groupBy({
        by: ['eventId', 'status'],
        where: { eventId: { in: eventIds } } satisfies Prisma.DeliveryWhereInput,
        _count: { _all: true },
        take: MAX_PAGE_SIZE,
        skip,
      });

      for (const group of groups) {
        const eventId = group.eventId;
        const status = group.status;
        if (typeof eventId !== 'string' || typeof status !== 'string') continue;
        const row = counts.get(eventId);
        if (!row) continue;
        const count = (group._count as { _all?: number } | undefined)?._all ?? 0;
        row[status as DeliveryStatus] = count;
      }

      if (groups.length < MAX_PAGE_SIZE) break;
    }

    for (const event of events) {
      rollups.set(event.id, rollUp(event.status, counts.get(event.id) ?? emptyCounts()));
    }
    return rollups;
  }

  /** One event, with the payload, labelled as raw-versus-jsonb. */
  async get(context: RequestContext, eventId: string): Promise<EventDetailDto> {
    return toEventDetailDto(await this.require(this.scopes.for(context), eventId));
  }

  /**
   * The fan-out: every delivery this event produced, with per-endpoint status.
   *
   * This is the "did finance ever receive this?" route. The event is resolved
   * first so a cross-tenant event id 404s rather than returning an empty page -
   * an empty page and "not yours" are genuinely different answers here, and
   * conflating them would have an operator conclude the fan-out matched nothing
   * when in fact they are looking at the wrong project.
   */
  async listDeliveries(
    context: RequestContext,
    eventId: string,
    query: ListDeliveriesQueryDto,
  ): Promise<DeliveryListDto> {
    const event = await this.require(this.scopes.for(context), eventId);
    return this.deliveries.listForEvent(context, event.id, query);
  }

  /**
   * Replay an event to one endpoint, or to all the endpoints it originally
   * reached.
   *
   * Both forms create NEW delivery rows carrying `replay_of_delivery_id`; no
   * original is read-modify-written and no `delivery_attempts` row is touched.
   * The selection happens inside the replay transaction so the set that is
   * re-sent is the set that existed when the inserts ran.
   */
  async replay(
    context: RequestContext,
    eventId: string,
    dto: ReplayEventDto,
  ): Promise<ReplayResultDto> {
    const created = await withCrossTenantNotFound(
      this.replays.replay(
        context,
        async (scope) => {
          const event = await this.require(scope, eventId);
          const originals = dto.endpoint_id
            ? [await EventsService.originalFor(scope, event, dto.endpoint_id)]
            : await EventsService.originalsFor(scope, event);

          return {
            originals,
            action: 'event.replayed',
            resourceType: 'event',
            resourceId: event.id,
            metadata: {
              event_type: event.eventType,
              // Which shape of replay this was. Worth recording: "somebody
              // re-sent this event to everyone" and "somebody re-sent it to one
              // endpoint" are different operational facts.
              target: dto.endpoint_id ? 'endpoint' : 'all_originally_matched',
              requested_endpoint_id: dto.endpoint_id ?? null,
            },
          };
        },
        dto.reason ?? null,
      ),
    );
    return DeliveriesService.toReplayResult(created);
  }

  // -------------------------------------------------------------------------

  private async require(scope: TenantScope, eventId: string): Promise<Event> {
    const event = await scope.events.findById(eventId);
    if (!event) throw crossTenantNotFound();
    return event;
  }

  /**
   * The ORIGINAL delivery for one endpoint, or a refusal.
   *
   * `replay_of_delivery_id: null` is what makes this the original rather than
   * some earlier replay: the partial unique index
   * `deliveries_event_endpoint_original_key` guarantees there is at most one
   * such row per `(event, endpoint)`, so this is a point lookup with a single
   * correct answer however many times the pair has been replayed since.
   *
   * The endpoint is resolved through the scope FIRST, so an id from another
   * tenant is the shared 404 rather than the "never delivered here" 409 - the
   * second would confirm the id names something real elsewhere.
   */
  private static async originalFor(
    scope: TenantScope,
    event: Event,
    endpointId: string,
  ): Promise<Delivery> {
    const endpoint = await scope.endpoints.findById(endpointId);
    if (!endpoint) throw crossTenantNotFound();

    const original = await scope.deliveries.findFirst({
      where: { eventId: event.id, endpointId: endpoint.id, replayOfDeliveryId: null },
    });
    if (original) return original;

    // Refused, not silently created. Delivering an event to an endpoint it
    // never reached is not a replay - there is no attempt budget to inherit, no
    // subscription that matched, and nothing in the ledger it re-runs. It is a
    // new delivery, and the honest way to get one is a subscription plus a
    // publish.
    throw new AppError(
      'conflict',
      `Event ${event.id} was never fanned out to endpoint ${endpoint.id}, so there is nothing to replay to it. Sending it there for the first time would be a new delivery, not a replay: add a subscription and publish the event.`,
      { event_id: event.id, endpoint_id: endpoint.id },
    );
  }

  /**
   * Every endpoint this event ACTUALLY reached - the original delivery rows,
   * oldest first.
   *
   * Not a re-match, and this is the load-bearing sentence of the whole module.
   * `webhook_subscriptions` is mutable: `event_types` can be narrowed or
   * widened, a subscription can be re-pointed at a different endpoint, disabled
   * or deleted. Re-running the match would therefore silently deliver a
   * three-week-old event to endpoints that were never targeted, and skip ones
   * that were. The delivery rows are the record of what the fan-out decided at
   * the time, and they are what this replays.
   *
   * `replay_of_delivery_id: null` for the same reason as above, and it also
   * makes the operation idempotent in shape: replaying the same event twice
   * re-sends to the same set of endpoints rather than compounding over the
   * replays the first call created.
   */
  private static async originalsFor(scope: TenantScope, event: Event): Promise<Delivery[]> {
    const page = await scope.deliveries.findPage({
      where: { eventId: event.id, replayOfDeliveryId: null },
      orderBy: { createdAt: 'asc' },
      take: MAX_REPLAY_FAN_OUT,
    });

    if (page.hasMore) {
      // One extra COUNT, on the error path only, so the message can name the
      // real number instead of "more than 50". An operator deciding how to
      // break the work up needs the number.
      const total = await scope.deliveries.count({
        eventId: event.id,
        replayOfDeliveryId: null,
      });
      throw new AppError(
        'limit_exceeded',
        `Event ${event.id} was fanned out to ${total} endpoints, and a single replay may create at most ${MAX_REPLAY_FAN_OUT} deliveries. Replay to one endpoint at a time with 'endpoint_id'.`,
        { limit: MAX_REPLAY_FAN_OUT, current: total, resource: 'replay_fan_out' },
      );
    }

    if (page.rows.length === 0) {
      throw new AppError(
        'conflict',
        `Event ${event.id} has no deliveries to replay. Either it matched no subscription, or the fan-out has not run yet - check 'status' on the event.`,
        { event_id: event.id, event_status: event.status },
      );
    }

    return page.rows;
  }

  /**
   * The query string, as a WHERE clause. Static and pure so the index claims in
   * `ListEventsQueryDto` can be checked against one function.
   */
  static filterWhere(query: ListEventsQueryDto): Prisma.EventWhereInput {
    const where: Prisma.EventWhereInput = {};

    if (query.event_type !== undefined) where.eventType = query.event_type;
    if (query.status !== undefined) where.status = query.status;

    const createdAt = dateRange(query.created_after, query.created_before);
    if (createdAt) where.createdAt = createdAt;

    if (query.idempotency_key !== undefined) {
      // `mode: 'insensitive'` is a real ILIKE, not a lower() on the argument
      // only: producers generate these keys, and a UUID pasted from a log is as
      // likely to be upper case as lower.
      where.idempotencyKey = { contains: query.idempotency_key, mode: 'insensitive' };
    }

    return where;
  }
}
