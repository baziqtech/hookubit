import { AppError } from '../common/errors';

/**
 * The window every analytics query runs over.
 *
 * ## Why a bounded parameter, refused rather than clamped
 *
 * `deliveries`, `events` and `delivery_attempts` are the three tables that only
 * grow, and every query in this module is an aggregate over a range of one of
 * them. The window IS the cost model: a caller asking for 90 days is asking for
 * roughly ninety times the work of the default, on the tables where that is
 * most expensive.
 *
 * The ceiling is therefore enforced by REFUSING (400), never by clamping. A
 * clamp answers a question the caller did not ask and labels the answer with
 * the period they asked for: "deliveries in the last 90 days: 4,102" would be a
 * 30-day number wearing a 90-day label, and the person reading it is trying to
 * decide whether something is getting worse. Being told "no" is recoverable;
 * being told a different period's number is not.
 */
export const DEFAULT_WINDOW_HOURS = 24;

/**
 * 30 days. Chosen to match the longest window the operator UI offers and the
 * point past which the plans in HANDOFF.md stop being index-only scans of a
 * useful size. Raising it is a decision about the largest project on the
 * platform, not about this constant.
 */
export const MAX_WINDOW_HOURS = 720;

/** An hour of milliseconds. */
const HOUR_MS = 3_600_000;

/**
 * A resolved window, plus the immediately preceding window of the same length.
 *
 * The previous window is not decoration: "is it getting worse?" is a comparison,
 * and a single number cannot answer it. Two equal-length adjacent ranges is the
 * cheapest honest comparison available - two index range scans rather than the
 * twenty-four a per-hour series would cost.
 *
 * Bounds are `[from, to)` - lower inclusive, upper exclusive - which is the only
 * pair that makes the current and previous windows tile without a row falling in
 * both. `deliveries.service.ts` uses the same convention for `created_after` /
 * `created_before`; a delivery counted twice at the boundary would show as a
 * volume increase that is not there.
 */
export interface AnalyticsWindow {
  hours: number;
  from: Date;
  /** Exclusive. */
  to: Date;
  previousFrom: Date;
  /** Exclusive, and equal to `from`. */
  previousTo: Date;
}

/**
 * Resolve the window, ending now.
 *
 * `now` is injectable so the tests assert a fixed range rather than racing the
 * clock; production always passes nothing.
 *
 * The ceiling is re-checked here even though `AnalyticsWindowQueryDto` declares
 * `@Max(MAX_WINDOW_HOURS)`. The DTO guards the HTTP edge; this guards the
 * function, and the function is what another module would call. A validation
 * rule that only exists on a decorator is one non-HTTP caller away from being
 * absent.
 */
export function resolveWindow(hours: number | undefined, now: Date = new Date()): AnalyticsWindow {
  const requested = hours ?? DEFAULT_WINDOW_HOURS;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new AppError(
      'invalid_request',
      "'window_hours' must be a whole number of hours, 1 or greater.",
    );
  }
  if (requested > MAX_WINDOW_HOURS) {
    throw new AppError(
      'invalid_request',
      `'window_hours' may not exceed ${MAX_WINDOW_HOURS} (30 days); ${requested} was requested. ` +
        'The request is refused rather than shortened, so a response is never labelled with a ' +
        'longer period than it actually covers.',
    );
  }
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - requested * HOUR_MS);
  return {
    hours: requested,
    from,
    to,
    previousFrom: new Date(from.getTime() - requested * HOUR_MS),
    previousTo: from,
  };
}

/** `[from, to)` as a Prisma date filter. Both bounds always present. */
export function range(from: Date, to: Date): { gte: Date; lt: Date } {
  return { gte: from, lt: to };
}
