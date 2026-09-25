import { MAX_PAGE_SIZE } from '../authz';

/**
 * The ceilings that keep every analytics response bounded.
 *
 * Each one is a promise about the worst case, not a default: the window can be
 * as wide as the caller likes up to `MAX_WINDOW_HOURS`, but the SIZE of every
 * intermediate result and of every response is fixed here regardless.
 */

/** Nine `DeliveryStatus` values; the extra room is so a tenth cannot truncate. */
export const MAX_STATUS_GROUPS = 16;

/** How many endpoints `GET /analytics/endpoints` will ever rank. */
export const MAX_ENDPOINT_RANKING = 50;

/** How many event types `GET /analytics/events` will ever list. */
export const MAX_EVENT_TYPES = 50;

/**
 * How many recent deliveries the latency sample is drawn from.
 *
 * `MAX_PAGE_SIZE` (200), the same ceiling `ScopedRepository` puts on every
 * other read, and not a number of this module's own: the id list this produces
 * becomes an `IN (...)` with one parameter per delivery, and a limit that
 * disagreed with the repository's would be a second, quieter opinion about how
 * large a single read may be.
 */
export const LATENCY_DELIVERY_SAMPLE = MAX_PAGE_SIZE;

/** How many measured attempts the percentiles are computed from. */
export const LATENCY_ATTEMPT_SAMPLE = MAX_PAGE_SIZE;

/**
 * How many of the delivery-series bucket queries may be in flight at once.
 *
 * The series issues two grouped counts per bucket (see
 * `AnalyticsService.deliverySeries`), so the widest chart is 64 statements.
 * Firing all of them at once would take sixty-four connections from a pool shared
 * with every write path on the platform, to draw a chart. Eight keeps the
 * wall-clock cost at a handful of round trips while leaving the pool alone.
 */
export const SERIES_QUERY_CONCURRENCY = 8;
