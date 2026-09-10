import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type {
  AttemptLatency,
  DeliveryOutcomes,
  EventVolume,
  FailingEndpoints,
} from '../../types/api';
import { DEFAULT_ANALYTICS_LIMIT, DEFAULT_WINDOW_HOURS } from '../../types/api';

/**
 * `GET /v1/projects/:projectId/analytics/{deliveries,endpoints,latency,events}`.
 *
 * Four hooks, one per route, on purpose. The controller explains why the
 * routes are separate — the latency sample is an order of magnitude dearer
 * than the event count, and one combined payload makes the cheapest tile wait
 * for the dearest query and blanks the whole panel when one is slow. So each
 * hook is its own query, each tile renders as its own response lands, and a
 * 403 on `events.read` does not take the delivery tiles down with it.
 *
 * THE THROTTLE IS THE OTHER REASON THESE ARE NOT `staleTime: 0`. Every route is
 * limited to 120 requests per five minutes per client (latency: 60), and the
 * limits are set "for a human looking at a screen, not for a polling agent".
 * TanStack's default refetches on every window focus and every remount, which
 * across four routes and a tab someone alt-tabs to and from is a self-inflicted
 * 429. Thirty seconds is the cadence the controller itself budgets for.
 *
 * The `*Query` factories exist so a page that needs one route for MANY projects
 * (Usage) can `useQueries` them under the same keys the single-project hooks
 * use, and share the cache with the Overview and Analytics pages.
 */
const ANALYTICS_STALE_MS = 30_000;

const base = (projectId: string) => `/v1/projects/${projectId}/analytics`;

/**
 * Delivery outcomes over the window, beside the window before it.
 *
 * `current.success_rate` and `success_rate_delta` are `number | null` — null is
 * "nothing settled", and a caller that renders it as 0% has turned an idle
 * project into a total outage. `by_status` always carries all nine statuses.
 */
export function deliveryOutcomesQuery(projectId: string, windowHours = DEFAULT_WINDOW_HOURS) {
  return queryOptions({
    queryKey: queryKeys.analyticsDeliveries(projectId, windowHours),
    queryFn: () =>
      api.get<DeliveryOutcomes>(
        `${base(projectId)}/deliveries${queryString({ window_hours: windowHours })}`,
      ),
    enabled: Boolean(projectId),
    staleTime: ANALYTICS_STALE_MS,
  });
}

export function useDeliveryOutcomes(projectId: string, windowHours = DEFAULT_WINDOW_HOURS) {
  return useQuery(deliveryOutcomesQuery(projectId, windowHours));
}

/**
 * Which endpoints are failing, worst first by `failed + exhausted`. `limit` is
 * 1..50; `has_more` says the list is not the whole set of failing endpoints,
 * though the ones shown are still the worst.
 */
export function useFailingEndpoints(
  projectId: string,
  windowHours = DEFAULT_WINDOW_HOURS,
  limit = DEFAULT_ANALYTICS_LIMIT,
) {
  return useQuery({
    queryKey: queryKeys.analyticsEndpoints(projectId, windowHours, limit),
    queryFn: () =>
      api.get<FailingEndpoints>(
        `${base(projectId)}/endpoints${queryString({ window_hours: windowHours, limit })}`,
      ),
    enabled: Boolean(projectId),
    staleTime: ANALYTICS_STALE_MS,
  });
}

/**
 * Attempt latency percentiles over a BOUNDED SAMPLE. Read `exact` before
 * reading `p95_ms`: when it is false the numbers describe the most recent
 * `sample_size` measured attempts, not the whole window. The dearest route,
 * with half the throttle budget of the others.
 */
export function useAttemptLatency(projectId: string, windowHours = DEFAULT_WINDOW_HOURS) {
  return useQuery({
    queryKey: queryKeys.analyticsLatency(projectId, windowHours),
    queryFn: () =>
      api.get<AttemptLatency>(
        `${base(projectId)}/latency${queryString({ window_hours: windowHours })}`,
      ),
    enabled: Boolean(projectId),
    staleTime: ANALYTICS_STALE_MS,
  });
}

/**
 * Events PUBLISHED in the window — not deliveries — with the busiest types.
 * Gated by `events.read`, not `deliveries.read`; the two are identical in
 * today's role matrix, but the day they diverge this query fails alone.
 */
export function eventVolumeQuery(
  projectId: string,
  windowHours = DEFAULT_WINDOW_HOURS,
  limit = DEFAULT_ANALYTICS_LIMIT,
) {
  return queryOptions({
    queryKey: queryKeys.analyticsEvents(projectId, windowHours, limit),
    queryFn: () =>
      api.get<EventVolume>(
        `${base(projectId)}/events${queryString({ window_hours: windowHours, limit })}`,
      ),
    enabled: Boolean(projectId),
    staleTime: ANALYTICS_STALE_MS,
  });
}

export function useEventVolume(
  projectId: string,
  windowHours = DEFAULT_WINDOW_HOURS,
  limit = DEFAULT_ANALYTICS_LIMIT,
) {
  return useQuery(eventVolumeQuery(projectId, windowHours, limit));
}
