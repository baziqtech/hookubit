import { Injectable } from '@nestjs/common';
import { DeliveryStatus, Prisma } from '@prisma/client';
import { MAX_PAGE_SIZE, RequestContext, TenantScope, TenantScopeFactory } from '../authz';

/** How far back the rate and the waiting count look. One hour, fixed. */
export const HEALTH_WINDOW_MS = 3_600_000;

export interface EndpointHealthSummary {
  /**
   * Successes over SETTLED deliveries in the last hour.
   *
   * NULL, never 0, when nothing settled. The difference is the whole point:
   * 0 means every delivery we attempted failed, which is the loudest thing this
   * object can say, and an endpoint that simply had no traffic must never be
   * rendered as one. A new endpoint reads "no data", not "0%".
   */
  success_rate_1h: number | null;
  /** Deliveries created in the last hour, settled or not. Context for the rate. */
  deliveries_1h: number;
  /** Created and still moving, at any age. What is queued behind a problem. */
  deliveries_waiting: number;
  /** From the breaker. Zero when the endpoint has never failed in a row. */
  consecutive_failures: number;
  /** When the breaker opened, or null when it is not open. */
  opened_at: string | null;
  last_delivery_at: string | null;
}

const IN_FLIGHT: readonly DeliveryStatus[] = [
  DeliveryStatus.pending,
  DeliveryStatus.scheduled,
  DeliveryStatus.queued,
  DeliveryStatus.processing,
  DeliveryStatus.retrying,
];

const FAILING: readonly DeliveryStatus[] = [DeliveryStatus.failed, DeliveryStatus.exhausted];

/**
 * Per-endpoint health, for a whole page of endpoints at once.
 *
 * ## Why this is a separate service and not part of `EndpointsService`
 *
 * It reads `deliveries` and `endpoint_health`, and `EndpointsService` reads
 * `endpoints` and `endpoint_secrets`. Keeping them apart means a failure to
 * compute health cannot take the endpoint list down with it — the list is how
 * you fix a broken endpoint, and it has to render when the thing it describes
 * is on fire.
 *
 * ## Why no p95 here
 *
 * Per-endpoint attempt latency needs a sample of that endpoint's attempts, and
 * `delivery_attempts` carries no `endpoint_id` — it joins through `deliveries`.
 * The project-wide percentile route is already the dearest query in the
 * product; multiplying it by a page of endpoints is not a list-page query. It
 * belongs on the endpoint DETAIL page, where there is exactly one endpoint and
 * the sample is bounded the same way `analytics/latency` bounds its own.
 *
 * ## Cost
 *
 * Three grouped reads for the whole page, never one per endpoint:
 *
 *   1. `groupBy(endpointId, status)` over the last hour - the rate.
 *   2. `groupBy(endpointId, status)` over in-flight statuses at any age - what
 *      is queued behind a problem, which is NOT an hour-bounded question.
 *   3. `findMany` on `endpoint_health` for the breaker's counters.
 *
 * Queries 1 and 2 are paged for the same reason the event rollup is: nine
 * statuses per endpoint against a 200-group ceiling means a full page of 200
 * endpoints is 1,800 groups, and `groupBy` with an explicit take SLICES.
 */
@Injectable()
export class EndpointHealthService {
  constructor(private readonly scopes: TenantScopeFactory) {}

  async summarise(
    context: RequestContext,
    endpointIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, EndpointHealthSummary>> {
    const summaries = new Map<string, EndpointHealthSummary>();
    if (endpointIds.length === 0) return summaries;

    const scope = this.scopes.for(context);
    const since = new Date(now.getTime() - HEALTH_WINDOW_MS);

    const [recent, waiting, breakers, lastSeen] = await Promise.all([
      this.countsByEndpoint(scope, { endpointId: { in: endpointIds }, createdAt: { gte: since } }),
      this.countsByEndpoint(scope, {
        endpointId: { in: endpointIds },
        status: { in: [...IN_FLIGHT] },
      }),
      scope.endpointHealth.findMany({ where: { endpointId: { in: endpointIds } } }),
      this.lastDeliveryByEndpoint(scope, endpointIds),
    ]);

    const breakerFor = new Map(breakers.map((row) => [row.endpointId, row]));

    for (const endpointId of endpointIds) {
      const counts = recent.get(endpointId) ?? new Map<string, number>();
      const succeeded = counts.get(DeliveryStatus.succeeded) ?? 0;
      const failing = FAILING.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
      const settled = succeeded + failing;
      let total = 0;
      for (const count of counts.values()) total += count;

      const inFlight = waiting.get(endpointId);
      let stillMoving = 0;
      if (inFlight) for (const count of inFlight.values()) stillMoving += count;

      const breaker = breakerFor.get(endpointId);

      summaries.set(endpointId, {
        success_rate_1h: settled === 0 ? null : round(succeeded / settled),
        deliveries_1h: total,
        deliveries_waiting: stillMoving,
        consecutive_failures: breaker?.consecutiveFailures ?? 0,
        opened_at: breaker?.openedAt ? new Date(breaker.openedAt).toISOString() : null,
        last_delivery_at: lastSeen.get(endpointId) ?? null,
      });
    }

    return summaries;
  }

  /** `groupBy(endpointId, status)`, paged so it can never silently truncate. */
  private async countsByEndpoint(
    scope: TenantScope,
    where: Prisma.DeliveryWhereInput,
  ): Promise<Map<string, Map<string, number>>> {
    const byEndpoint = new Map<string, Map<string, number>>();

    for (let skip = 0; ; skip += MAX_PAGE_SIZE) {
      const groups = await scope.deliveries.groupBy({
        by: ['endpointId', 'status'],
        where,
        _count: { _all: true },
        take: MAX_PAGE_SIZE,
        skip,
      });

      for (const group of groups) {
        const endpointId = group.endpointId;
        const status = group.status;
        if (typeof endpointId !== 'string' || typeof status !== 'string') continue;
        const counts = byEndpoint.get(endpointId) ?? new Map<string, number>();
        counts.set(status, (group._count as { _all?: number } | undefined)?._all ?? 0);
        byEndpoint.set(endpointId, counts);
      }

      if (groups.length < MAX_PAGE_SIZE) break;
    }

    return byEndpoint;
  }

  /**
   * The newest delivery per endpoint.
   *
   * `groupBy(endpointId)` with `_max: { createdAt }` — one row per endpoint, so
   * it cannot exceed the group ceiling for any page the API will serve.
   */
  private async lastDeliveryByEndpoint(
    scope: TenantScope,
    endpointIds: string[],
  ): Promise<Map<string, string>> {
    const groups = await scope.deliveries.groupBy({
      by: ['endpointId'],
      where: { endpointId: { in: endpointIds } } satisfies Prisma.DeliveryWhereInput,
      _max: { createdAt: true },
      take: MAX_PAGE_SIZE,
    });

    const last = new Map<string, string>();
    for (const group of groups) {
      const endpointId = group.endpointId;
      const createdAt = (group._max as { createdAt?: Date | string | null } | undefined)?.createdAt;
      if (typeof endpointId !== 'string' || !createdAt) continue;
      last.set(endpointId, new Date(createdAt).toISOString());
    }
    return last;
  }
}

/** Four decimal places, as every other rate in this codebase rounds. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
