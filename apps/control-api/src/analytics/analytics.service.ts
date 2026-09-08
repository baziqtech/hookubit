import { Injectable } from '@nestjs/common';
import { DeliveryStatus, Prisma } from '@prisma/client';
import { RequestContext, TenantScope, TenantScopeFactory } from '../authz';
import {
  AnalyticsWindow,
  range,
  resolveWindow,
} from './analytics-window';
import {
  LATENCY_ATTEMPT_SAMPLE,
  LATENCY_DELIVERY_SAMPLE,
  MAX_ENDPOINT_RANKING,
  MAX_EVENT_TYPES,
  MAX_STATUS_GROUPS,
} from './analytics-limits';
import {
  AnalyticsWindowDto,
  AttemptLatencyDto,
  DeliveryOutcomeSummaryDto,
  DeliveryOutcomesDto,
  DeliveryStatusCountsDto,
  EventVolumeDto,
  EventVolumeQueryDto,
  FailingEndpointDto,
  FailingEndpointsDto,
  FailingEndpointsQueryDto,
  AnalyticsWindowQueryDto,
} from './dto';

/** The nine statuses, from the Prisma enum so the list cannot drift. */
const ALL_STATUSES: readonly DeliveryStatus[] = Object.values(DeliveryStatus);

/** Terminal failure. `failed` may still be retried; `exhausted` will not. */
const FAILING: readonly DeliveryStatus[] = [DeliveryStatus.failed, DeliveryStatus.exhausted];

/** Neither settled nor failed: the delivery is still on its way. */
const IN_FLIGHT: readonly DeliveryStatus[] = [
  DeliveryStatus.pending,
  DeliveryStatus.scheduled,
  DeliveryStatus.queued,
  DeliveryStatus.processing,
  DeliveryStatus.retrying,
];

/**
 * Operator analytics: four questions, four queries, no derived state.
 *
 * ## What this module refuses to be
 *
 * It is not a metrics pipeline and it writes nothing. Every number below is
 * read from the delivery ledger at request time through `ScopedRepository`, so
 * it cannot disagree with `GET /deliveries` - which is the property that
 * matters at 2am, when someone reads a failure count here and then goes looking
 * for the rows behind it. A cached or rolled-up number that is thirty seconds
 * stale is a number that sends that person hunting for deliveries that are not
 * there yet.
 *
 * The price is that these are aggregates over the three tables that only grow.
 * Every query is therefore bounded by a window with a hard ceiling
 * (`analytics-window.ts`), throttled at the controller, and index-supported -
 * with the plan that proves it recorded above each one. See HANDOFF.md for the
 * row counts at which each stops being acceptable.
 *
 * ## Why there is no hourly time series
 *
 * The dashboard's speculative shape asked for 24 hourly buckets. Bucketing a
 * timestamp needs `date_trunc`, which needs raw SQL, which needs
 * `PrismaService` - banned outside the allowlist for the reason that makes this
 * whole layer worth having. The alternative, one grouped query per bucket, is
 * twenty-four index range scans of the same range to answer one question.
 *
 * So the comparison is made explicit instead: every count is reported for the
 * window AND for the immediately preceding window of equal length, with the
 * delta. "Is it getting worse?" is a comparison, and this answers it in a
 * number rather than asking a human to eyeball the slope of a bar chart. The
 * cost is two index range scans, not twenty-four.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly scopes: TenantScopeFactory) {}

  /**
   * Delivery outcomes over the window, beside the window before it.
   *
   * TWO `groupBy` queries, both fenced by `ScopedRepository`, both grouped and
   * counted in PostgreSQL. Nothing is counted in application code except the
   * roll-up of nine exact counts into four - which is arithmetic on nine
   * integers, not aggregation over rows.
   *
   * EXPLAIN (PostgreSQL 16.2, 800k deliveries in the project, 90 days of
   * history, 1M rows in the table):
   *
   *   24h  -> Nested Loop over the project's endpoints, Bitmap Index Scan on
   *           deliveries_endpoint_id_created_at_idx, HashAggregate.
   *           8,874 rows, 13.7 ms. No sequential scan.
   *   168h -> Bitmap Index Scan on deliveries_project_id_created_at_idx
   *           (the index this module adds), 62k rows, 22.7 ms.
   *   720h -> Parallel Seq Scan, 266k rows (33% of the table), 207 ms. That is
   *           the CORRECT plan at that selectivity - a third of a table is not
   *           an index lookup - and it is why 720h is the ceiling rather than a
   *           default. See HANDOFF.md.
   */
  async deliveryOutcomes(
    context: RequestContext,
    query: AnalyticsWindowQueryDto,
    now?: Date,
  ): Promise<DeliveryOutcomesDto> {
    const window = resolveWindow(query.window_hours, now);
    const scope = this.scopes.for(context);

    const [current, previous] = await Promise.all([
      this.statusCounts(scope, window.from, window.to),
      this.statusCounts(scope, window.previousFrom, window.previousTo),
    ]);

    const currentSummary = AnalyticsService.summarise(current);
    const previousSummary = AnalyticsService.summarise(previous);

    return {
      window: AnalyticsService.windowDto(window),
      current: currentSummary,
      previous: previousSummary,
      success_rate_delta:
        currentSummary.success_rate === null || previousSummary.success_rate === null
          ? null
          : round(currentSummary.success_rate - previousSummary.success_rate),
      total_delta: currentSummary.total - previousSummary.total,
    };
  }

  /**
   * The endpoints failing hardest in the window, ranked, worst first.
   *
   * THREE queries, and the ranking is done by PostgreSQL - `ORDER BY count DESC
   * LIMIT n` inside the `groupBy`, not a sort of every endpoint in memory. That
   * distinction is the difference between a bounded response and reading one
   * group per endpoint on a project with thousands of them.
   *
   *   1. rank:      groupBy (endpoint_id) WHERE status IN (failed, exhausted)
   *   2. breakdown: groupBy (endpoint_id, status) WHERE endpoint_id IN (ranked)
   *                 - this is where `total` and the per-status split come from,
   *                 in ONE query rather than one per endpoint.
   *   3. the endpoint rows themselves, for name/url/status.
   *
   * EXPLAIN (same fixture, 24h): query 1 is a Bitmap Index Scan on
   * deliveries_project_id_status_created_at_idx - (project_id, status,
   * created_at) is an exact prefix match once status is constrained - 1,479
   * rows, 9.8 ms, GroupAggregate, no sequential scan. Query 2 rides
   * deliveries_endpoint_id_created_at_idx, at most `limit` endpoints wide.
   */
  async failingEndpoints(
    context: RequestContext,
    query: FailingEndpointsQueryDto,
    now?: Date,
  ): Promise<FailingEndpointsDto> {
    const window = resolveWindow(query.window_hours, now);
    const limit = Math.min(query.limit ?? 10, MAX_ENDPOINT_RANKING);
    const scope = this.scopes.for(context);
    const createdAt = range(window.from, window.to);

    const ranked = await scope.deliveries.groupBy({
      by: ['endpointId'],
      where: { createdAt, status: { in: [...FAILING] } },
      _count: { endpointId: true },
      // Ranked in the database. `take` is limit + 1 inside ScopedRepository, so
      // one extra group is read purely to answer `has_more` honestly.
      orderBy: { _count: { endpointId: 'desc' } },
      take: limit,
    });

    const endpointIds = ranked
      .map((group) => group.endpointId)
      .filter((id): id is string => typeof id === 'string');

    if (endpointIds.length === 0) {
      return { window: AnalyticsService.windowDto(window), data: [], has_more: false };
    }

    const [breakdown, endpoints] = await Promise.all([
      scope.deliveries.groupBy({
        by: ['endpointId', 'status'],
        where: { createdAt, endpointId: { in: endpointIds } },
        _count: { endpointId: true },
        // limit x 9 groups at the very most, and `limit` is capped at 50.
        take: MAX_ENDPOINT_RANKING * ALL_STATUSES.length,
      }),
      scope.endpoints.findMany({ where: { id: { in: endpointIds } }, take: limit }),
    ]);

    const byEndpoint = new Map<string, Map<DeliveryStatus, number>>();
    for (const group of breakdown) {
      const id = group.endpointId;
      const status = group.status;
      if (typeof id !== 'string' || typeof status !== 'string') continue;
      if (!isDeliveryStatus(status)) continue;
      const counts = byEndpoint.get(id) ?? new Map<DeliveryStatus, number>();
      counts.set(status, countOf(group, 'endpointId'));
      byEndpoint.set(id, counts);
    }

    const rows = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));

    const data: FailingEndpointDto[] = endpointIds.map((endpointId) => {
      const counts = byEndpoint.get(endpointId) ?? new Map<DeliveryStatus, number>();
      const at = (status: DeliveryStatus): number => counts.get(status) ?? 0;
      let total = 0;
      for (const value of counts.values()) total += value;
      const failed = at(DeliveryStatus.failed);
      const exhausted = at(DeliveryStatus.exhausted);
      const failing = failed + exhausted;
      const endpoint = rows.get(endpointId);
      return {
        endpoint_id: endpointId,
        name: endpoint?.name ?? null,
        url: endpoint?.url ?? null,
        status: endpoint?.status ?? null,
        enabled: endpoint?.enabled ?? null,
        failing,
        failed,
        exhausted,
        retrying: at(DeliveryStatus.retrying),
        total,
        failure_rate: total === 0 ? 0 : round(failing / total),
      };
    });

    return {
      window: AnalyticsService.windowDto(window),
      data,
      // `ranked` was asked for exactly `limit` groups; ScopedRepository reads
      // limit + 1 and slices, so a full page is the only signal available here.
      has_more: ranked.length === limit,
    };
  }

  /**
   * Attempt latency percentiles, from `delivery_attempts.duration_ms`.
   *
   * ## This is a SAMPLE, and the response says so
   *
   * An exact percentile is `percentile_cont`, which is raw SQL, which is
   * `PrismaService`. `ScopedRepository` exposes `aggregate` and `groupBy`;
   * neither can express an ordered-set aggregate, and grouping by `duration_ms`
   * itself would produce thousands of groups and be refused by the repository's
   * own ceiling - correctly.
   *
   * So: the most recent `LATENCY_DELIVERY_SAMPLE` deliveries in the window, and
   * up to `LATENCY_ATTEMPT_SAMPLE` of their measured attempts. `exact` is true
   * only when neither bound was reached, which is the common case for a normal
   * project on a 24h window and always the case for a quiet one. When it is
   * false the percentiles describe the MOST RECENT traffic in the window rather
   * than the whole of it, and the response carries `sample_size` and
   * `sampled_deliveries` so nobody has to guess how much was measured. That
   * recency bias is real; hiding it would be worse than having it.
   *
   * EXPLAIN (same fixture): the delivery sample is the query the new index
   * exists for. `WHERE project_id = ? AND created_at >= ? ORDER BY created_at
   * DESC LIMIT 201` is an Index Scan on deliveries_project_id_created_at_idx
   * returning 201 index tuples and stopping - 0.35 ms at the 720h ceiling, and
   * O(limit) rather than O(window). WITHOUT that index the same query is a
   * Parallel Seq Scan plus a top-N heapsort over 266k rows: 226 ms. That
   * measurement, not a guess, is what the migration is for.
   *
   * The attempt read is 200 Index Scans on delivery_attempts_delivery_id_idx
   * driven by the id list, 37 ms.
   */
  async attemptLatency(
    context: RequestContext,
    query: AnalyticsWindowQueryDto,
    now?: Date,
  ): Promise<AttemptLatencyDto> {
    const window = resolveWindow(query.window_hours, now);
    const scope = this.scopes.for(context);

    const deliveries = await scope.deliveries.findPage({
      where: { createdAt: range(window.from, window.to) },
      orderBy: { createdAt: 'desc' },
      take: LATENCY_DELIVERY_SAMPLE,
    });

    const empty: AttemptLatencyDto = {
      window: AnalyticsService.windowDto(window),
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      min_ms: null,
      max_ms: null,
      sample_size: 0,
      // Nothing to measure IS an exact answer about nothing, and reporting it
      // as a sample would suggest numbers are being withheld.
      exact: !deliveries.hasMore,
      sampled_deliveries: 0,
    };
    if (deliveries.rows.length === 0) return empty;

    const attempts = await scope.deliveryAttempts.findPage({
      where: {
        deliveryId: { in: deliveries.rows.map((delivery) => delivery.id) },
        durationMs: { not: null },
      },
      take: LATENCY_ATTEMPT_SAMPLE,
    });

    const durations = attempts.rows
      .map((attempt) => attempt.durationMs)
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right);

    if (durations.length === 0) {
      return { ...empty, sampled_deliveries: deliveries.rows.length };
    }

    return {
      window: AnalyticsService.windowDto(window),
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
      p99_ms: percentile(durations, 0.99),
      min_ms: durations[0],
      max_ms: durations[durations.length - 1],
      sample_size: durations.length,
      exact: !deliveries.hasMore && !attempts.hasMore,
      sampled_deliveries: deliveries.rows.length,
    };
  }

  /**
   * Event volume over the window, beside the window before it, plus the
   * busiest event types.
   *
   * THREE reads: two counts and one grouped count, all in PostgreSQL.
   *
   * EXPLAIN (600k events, 400k in this project):
   *   24h count    -> Index Scan on events_organization_id_created_at_idx,
   *                   4,431 rows, 24.5 ms.
   *   24h by type  -> same index, HashAggregate, 2.9 ms.
   *   720h count   -> Parallel Bitmap Heap Scan on
   *                   events_project_id_created_at_idx, 133k rows, 209 ms.
   *
   * Note which index the 24h count chose: `events` is scoped
   * `projectAndOrganization`, so the predicate carries BOTH columns and the
   * planner may pick the organization index and filter by project. It did here
   * (1,108 rows removed by filter, ~20% waste). That is cheap for an
   * organization with a handful of projects and gets worse linearly with the
   * number of sibling projects; the note is in HANDOFF.md rather than being
   * fixed by a hint, because the fix is a planner statistics question, not a
   * code one.
   */
  async eventVolume(
    context: RequestContext,
    query: EventVolumeQueryDto,
    now?: Date,
  ): Promise<EventVolumeDto> {
    const window = resolveWindow(query.window_hours, now);
    const limit = Math.min(query.limit ?? 10, MAX_EVENT_TYPES);
    const scope = this.scopes.for(context);

    const [total, previousTotal, byType] = await Promise.all([
      scope.events.count({ createdAt: range(window.from, window.to) }),
      scope.events.count({ createdAt: range(window.previousFrom, window.previousTo) }),
      scope.events.groupBy({
        by: ['eventType'],
        where: { createdAt: range(window.from, window.to) },
        _count: { eventType: true },
        orderBy: { _count: { eventType: 'desc' } },
        take: limit,
      }),
    ]);

    return {
      window: AnalyticsService.windowDto(window),
      total,
      previous_total: previousTotal,
      total_delta: total - previousTotal,
      by_type: byType
        .filter((group): group is Record<string, unknown> & { eventType: string } =>
          typeof group.eventType === 'string',
        )
        .map((group) => ({ event_type: group.eventType, count: countOf(group, 'eventType') })),
      has_more: byType.length === limit,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * One `groupBy` over `status`, and every status present in the result even
   * when PostgreSQL returned no group for it.
   *
   * The zero-filling is the point: `GROUP BY` returns no row for a status with
   * no deliveries, and a response that omitted `exhausted` because there were
   * none is indistinguishable, to a client, from a response that omitted it
   * because this build does not report it.
   */
  private async statusCounts(
    scope: TenantScope,
    from: Date,
    to: Date,
  ): Promise<Record<DeliveryStatus, number>> {
    const groups = await scope.deliveries.groupBy({
      by: ['status'],
      where: { createdAt: range(from, to) } satisfies Prisma.DeliveryWhereInput,
      _count: { status: true },
      // Nine statuses, so this take can never truncate. It is explicit anyway,
      // because ScopedRepository throws on an implicit ceiling hit and a silent
      // partial rollup here would understate failures.
      take: MAX_STATUS_GROUPS,
    });

    const counts = {} as Record<DeliveryStatus, number>;
    for (const status of ALL_STATUSES) counts[status] = 0;
    for (const group of groups) {
      const status = group.status;
      if (typeof status === 'string' && isDeliveryStatus(status)) {
        counts[status] = countOf(group, 'status');
      }
    }
    return counts;
  }

  /** Nine exact counts -> the four an operator reads. Arithmetic, not a scan. */
  private static summarise(counts: Record<DeliveryStatus, number>): DeliveryOutcomeSummaryDto {
    const by_status: DeliveryStatusCountsDto = {
      pending: counts.pending,
      scheduled: counts.scheduled,
      queued: counts.queued,
      processing: counts.processing,
      succeeded: counts.succeeded,
      failed: counts.failed,
      retrying: counts.retrying,
      exhausted: counts.exhausted,
      cancelled: counts.cancelled,
    };
    let total = 0;
    for (const status of ALL_STATUSES) total += counts[status];
    const failing = FAILING.reduce((sum, status) => sum + counts[status], 0);
    const inFlight = IN_FLIGHT.reduce((sum, status) => sum + counts[status], 0);
    const settled = counts.succeeded + failing;

    return {
      total,
      succeeded: counts.succeeded,
      failing,
      exhausted: counts.exhausted,
      in_flight: inFlight,
      cancelled: counts.cancelled,
      // NULL, never 0. Zero means "everything we tried failed", which is the
      // loudest thing this response can say; an idle project must not say it.
      success_rate: settled === 0 ? null : round(counts.succeeded / settled),
      by_status,
    };
  }

  private static windowDto(window: AnalyticsWindow): AnalyticsWindowDto {
    return {
      hours: window.hours,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previous_from: window.previousFrom.toISOString(),
      previous_to: window.previousTo.toISOString(),
    };
  }
}

/** Runtime narrowing for the string PostgreSQL hands back for an enum column. */
function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (ALL_STATUSES as readonly string[]).includes(value);
}

/**
 * `_count` out of a `groupBy` row.
 *
 * Prisma returns `_count` as either a number (`_count: true`) or an object
 * keyed by field (`_count: { field: true }`), and `ScopedRepository.groupBy` is
 * typed as `Record<string, unknown>` because it is model-agnostic. Reading it
 * defensively here is cheaper than an `any` and cannot throw on a shape change:
 * an unrecognised shape counts as 0 rather than crashing the response.
 */
function countOf(group: Record<string, unknown>, field: string): number {
  const raw = group._count;
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number') return value;
    const all = (raw as Record<string, unknown>)._all;
    if (typeof all === 'number') return all;
  }
  return 0;
}

/**
 * Nearest-rank percentile over an ASCENDING sample.
 *
 * Nearest rank, not linear interpolation: every value returned is a duration
 * that was actually observed. An interpolated p95 of 412.5 ms is a number no
 * request ever took, and on a latency panel someone will go looking for the
 * attempt that produced it.
 */
function percentile(ascending: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * ascending.length);
  const index = Math.min(Math.max(rank, 1), ascending.length) - 1;
  return ascending[index];
}

/** Four decimal places. A rate is displayed, not summed; float noise is not. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
