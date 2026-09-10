/**
 * The four analytics routes, computed from the mock's own ledger.
 *
 * `GET /v1/projects/:projectId/analytics/{deliveries,endpoints,latency,events}`
 * — shapes exactly as `apps/control-api/src/analytics/dto/` declares them,
 * derived from the same `deliveries`, `events` and `attempts` fixtures the list
 * pages serve. Nothing here is invented: a count on the Analytics page is a
 * count of rows the Deliveries page will show, which is the property the real
 * service promises ("it cannot disagree with `GET /deliveries`").
 *
 * The semantics mirror `AnalyticsService`: `[from, to)` windows anchored at
 * request time, `success_rate` NULL when nothing settled, nine `by_status`
 * keys always present, nearest-rank percentiles over a bounded sample with
 * `exact` saying whether the sample was everything, and refusal — never a
 * clamp — above `MAX_WINDOW_HOURS`.
 */
import type {
  AnalyticsWindow,
  AttemptLatency,
  DeliveryOutcomeSummary,
  DeliveryOutcomes,
  DeliveryStatus,
  DeliveryStatusCounts,
  EventVolume,
  FailingEndpoint,
  FailingEndpoints,
} from '../../types/api';
import {
  DEFAULT_ANALYTICS_LIMIT,
  DEFAULT_WINDOW_HOURS,
  MAX_ANALYTICS_LIMIT,
  MAX_PAGE_SIZE,
  MAX_WINDOW_HOURS,
} from '../../types/api';
import * as db from './data';

const ALL_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'scheduled',
  'queued',
  'processing',
  'succeeded',
  'failed',
  'retrying',
  'exhausted',
  'cancelled',
];
const FAILING: readonly DeliveryStatus[] = ['failed', 'exhausted'];
const IN_FLIGHT: readonly DeliveryStatus[] = [
  'pending',
  'scheduled',
  'queued',
  'processing',
  'retrying',
];

/** `LATENCY_DELIVERY_SAMPLE` / `LATENCY_ATTEMPT_SAMPLE` — both `MAX_PAGE_SIZE`. */
const LATENCY_SAMPLE = MAX_PAGE_SIZE;

const HOUR_MS = 3_600_000;

interface ResolvedWindow {
  hours: number;
  from: number;
  to: number;
  previousFrom: number;
  previousTo: number;
}

export type AnalyticsQuery =
  | { ok: true; windowHours: number; limit: number }
  | { ok: false; messages: string[] };

/**
 * `window_hours` and `limit` as the global `ValidationPipe` would judge them:
 * each rejected property is its own `"<property>: <reason>"` entry, and a
 * value above the ceiling is refused, never shortened.
 */
export function parseAnalyticsQuery(query: URLSearchParams, withLimit: boolean): AnalyticsQuery {
  const messages: string[] = [];

  const rawHours = query.get('window_hours');
  let windowHours = DEFAULT_WINDOW_HOURS;
  if (rawHours !== null) {
    const parsed = Number(rawHours);
    if (!Number.isInteger(parsed)) messages.push('window_hours: must be an integer number');
    else if (parsed < 1) messages.push('window_hours: must not be less than 1');
    else if (parsed > MAX_WINDOW_HOURS)
      messages.push(`window_hours: must not be greater than ${MAX_WINDOW_HOURS}`);
    else windowHours = parsed;
  }

  const rawLimit = query.get('limit');
  let limit = DEFAULT_ANALYTICS_LIMIT;
  if (rawLimit !== null) {
    if (!withLimit) messages.push('property limit should not exist');
    else {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed)) messages.push('limit: must be an integer number');
      else if (parsed < 1) messages.push('limit: must not be less than 1');
      else if (parsed > MAX_ANALYTICS_LIMIT)
        messages.push(`limit: must not be greater than ${MAX_ANALYTICS_LIMIT}`);
      else limit = parsed;
    }
  }

  return messages.length > 0 ? { ok: false, messages } : { ok: true, windowHours, limit };
}

function resolveWindow(hours: number, now = Date.now()): ResolvedWindow {
  const from = now - hours * HOUR_MS;
  return { hours, from, to: now, previousFrom: from - hours * HOUR_MS, previousTo: from };
}

function windowDto(window: ResolvedWindow): AnalyticsWindow {
  return {
    hours: window.hours,
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    previous_from: new Date(window.previousFrom).toISOString(),
    previous_to: new Date(window.previousTo).toISOString(),
  };
}

/** `[from, to)` — lower inclusive, upper exclusive, so adjacent windows tile. */
const within = (iso: string, from: number, to: number) => {
  const at = new Date(iso).getTime();
  return at >= from && at < to;
};

/** Four decimal places, as the service rounds every rate. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function statusCounts(projectId: string, from: number, to: number): DeliveryStatusCounts {
  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<
    DeliveryStatus,
    number
  >;
  for (const delivery of db.deliveries) {
    if (delivery.project_id !== projectId) continue;
    if (!within(delivery.created_at, from, to)) continue;
    counts[delivery.status] += 1;
  }
  return counts;
}

function summarise(counts: DeliveryStatusCounts): DeliveryOutcomeSummary {
  const total = ALL_STATUSES.reduce((sum, status) => sum + counts[status], 0);
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
    // NULL, never 0: zero means everything failed, and an idle project must
    // not say that.
    success_rate: settled === 0 ? null : round(counts.succeeded / settled),
    by_status: { ...counts },
  };
}

export function deliveryOutcomes(projectId: string, windowHours: number): DeliveryOutcomes {
  const window = resolveWindow(windowHours);
  const current = summarise(statusCounts(projectId, window.from, window.to));
  const previous = summarise(statusCounts(projectId, window.previousFrom, window.previousTo));
  return {
    window: windowDto(window),
    current,
    previous,
    success_rate_delta:
      current.success_rate === null || previous.success_rate === null
        ? null
        : round(current.success_rate - previous.success_rate),
    total_delta: current.total - previous.total,
  };
}

export function failingEndpoints(
  projectId: string,
  windowHours: number,
  limit: number,
): FailingEndpoints {
  const window = resolveWindow(windowHours);
  const inWindow = db.deliveries.filter(
    (delivery) =>
      delivery.project_id === projectId && within(delivery.created_at, window.from, window.to),
  );

  // Rank by failed + exhausted, worst first, then by id for a stable order.
  const failingBy = new Map<string, number>();
  for (const delivery of inWindow) {
    if (!FAILING.includes(delivery.status)) continue;
    failingBy.set(delivery.endpoint_id, (failingBy.get(delivery.endpoint_id) ?? 0) + 1);
  }
  const ranked = [...failingBy.entries()]
    .sort(([idA, a], [idB, b]) => b - a || idA.localeCompare(idB))
    .map(([endpointId]) => endpointId);
  const shown = ranked.slice(0, limit);

  const data: FailingEndpoint[] = shown.map((endpointId) => {
    const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<
      DeliveryStatus,
      number
    >;
    for (const delivery of inWindow) {
      if (delivery.endpoint_id === endpointId) counts[delivery.status] += 1;
    }
    const total = ALL_STATUSES.reduce((sum, status) => sum + counts[status], 0);
    const failing = counts.failed + counts.exhausted;
    // `endpoints` includes soft-deleted rows with `status: "deleted"`, exactly
    // as the real join does; a missing row is the nullable branch.
    const endpoint = db.endpoints.find((candidate) => candidate.id === endpointId);
    return {
      endpoint_id: endpointId,
      name: endpoint?.name ?? null,
      url: endpoint?.url ?? null,
      status: endpoint?.status ?? null,
      enabled: endpoint?.enabled ?? null,
      failing,
      failed: counts.failed,
      exhausted: counts.exhausted,
      retrying: counts.retrying,
      total,
      failure_rate: total === 0 ? 0 : round(failing / total),
    };
  });

  return { window: windowDto(window), data, has_more: ranked.length > shown.length };
}

/** Nearest-rank over an ASCENDING sample — every value was actually observed. */
function percentile(ascending: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * ascending.length);
  const index = Math.min(Math.max(rank, 1), ascending.length) - 1;
  return ascending[index];
}

export function attemptLatency(projectId: string, windowHours: number): AttemptLatency {
  const window = resolveWindow(windowHours);
  // The most recent `LATENCY_SAMPLE` deliveries in the window, as the service
  // reads them (`ORDER BY created_at DESC LIMIT n`).
  const inWindow = db.deliveries
    .filter(
      (delivery) =>
        delivery.project_id === projectId &&
        within(delivery.created_at, window.from, window.to),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sampledDeliveries = inWindow.slice(0, LATENCY_SAMPLE);
  const deliveriesTruncated = inWindow.length > sampledDeliveries.length;

  const empty: AttemptLatency = {
    window: windowDto(window),
    p50_ms: null,
    p95_ms: null,
    p99_ms: null,
    min_ms: null,
    max_ms: null,
    sample_size: 0,
    exact: !deliveriesTruncated,
    sampled_deliveries: 0,
  };
  if (sampledDeliveries.length === 0) return empty;

  const measured = sampledDeliveries
    .flatMap((delivery) => db.attempts[delivery.id] ?? [])
    .map((attempt) => attempt.duration_ms)
    .filter((value): value is number => typeof value === 'number');
  const attemptsTruncated = measured.length > LATENCY_SAMPLE;
  const durations = measured.slice(0, LATENCY_SAMPLE).sort((a, b) => a - b);

  if (durations.length === 0) {
    return { ...empty, sampled_deliveries: sampledDeliveries.length };
  }

  return {
    window: windowDto(window),
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    p99_ms: percentile(durations, 0.99),
    min_ms: durations[0],
    max_ms: durations[durations.length - 1],
    sample_size: durations.length,
    exact: !deliveriesTruncated && !attemptsTruncated,
    sampled_deliveries: sampledDeliveries.length,
  };
}

export function eventVolume(projectId: string, windowHours: number, limit: number): EventVolume {
  const window = resolveWindow(windowHours);
  const inWindow = db.events.filter(
    (event) => event.project_id === projectId && within(event.created_at, window.from, window.to),
  );
  const previousTotal = db.events.filter(
    (event) =>
      event.project_id === projectId &&
      within(event.created_at, window.previousFrom, window.previousTo),
  ).length;

  const byType = new Map<string, number>();
  for (const event of inWindow) byType.set(event.event_type, (byType.get(event.event_type) ?? 0) + 1);
  const ranked = [...byType.entries()]
    .sort(([typeA, a], [typeB, b]) => b - a || typeA.localeCompare(typeB))
    .map(([event_type, count]) => ({ event_type, count }));

  return {
    window: windowDto(window),
    total: inWindow.length,
    previous_total: previousTotal,
    total_delta: inWindow.length - previousTotal,
    by_type: ranked.slice(0, limit),
    has_more: ranked.length > limit,
  };
}
