import { AppError } from '../common/errors';
import { AnalyticsWindow } from './analytics-window';

/**
 * Bucket widths, smallest first. Every one divides 24 hours exactly, which is
 * what lets a bucket be aligned by flooring epoch milliseconds and still land
 * on a wall-clock boundary in UTC — 16:00, 19:00, 22:00 rather than 16:37.
 * An x-axis whose labels are offset by the moment the page was opened is an
 * axis nobody can compare against yesterday's screenshot.
 */
export const BUCKET_WIDTHS = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '2h': 2 * 3_600_000,
  '3h': 3 * 3_600_000,
  '6h': 6 * 3_600_000,
  '12h': 12 * 3_600_000,
  '1d': 24 * 3_600_000,
} as const;

export type BucketUnit = keyof typeof BUCKET_WIDTHS;

export const BUCKET_UNITS = Object.keys(BUCKET_WIDTHS) as BucketUnit[];

/**
 * The hard ceiling on buckets in one response, and therefore on queries.
 *
 * This is a cost model, not a layout preference. Each bucket is two grouped
 * counts over its own slice of the window (see `AnalyticsService.deliverySeries`
 * for why two, and for why it is not one statement with `date_trunc`), so the
 * bucket count sets the query count. Thirty daily bars is the widest chart the
 * design draws, across a 30-day window.
 *
 * It is 32 rather than 30 because a window is almost never aligned to a bucket
 * boundary. A 30-day window opened at 14:37 starts inside yesterday's bucket
 * and ends inside today's, so it needs 31 daily buckets to be covered — and
 * refusing the request everybody actually makes, in order to keep a round
 * number here, would be a ceiling defending itself rather than the database.
 */
export const MAX_BUCKETS = 32;

export interface SeriesBucket {
  start: Date;
  /** Exclusive, and equal to the next bucket's `start`. */
  end: Date;
}

export interface SeriesPlan {
  unit: BucketUnit;
  widthMs: number;
  buckets: SeriesBucket[];
  /**
   * True when the first bucket begins BEFORE the requested window did.
   *
   * Buckets are aligned to wall-clock boundaries, so a 24-hour window opened at
   * 14:37 starts inside the 14:00 bucket rather than at its edge. Saying so is
   * the difference between a first bar that is honestly labelled partial and
   * one that looks like a traffic dip every time somebody opens the page.
   */
  leadingPartial: boolean;
}

/**
 * The default bucket for a window: the finest one that stays inside
 * `MAX_BUCKETS`.
 *
 * A 1-hour window gets twelve five-minute bars, a day gets twenty-four hourly
 * ones, a week gets twenty-eight six-hourly ones. The caller can always ask for
 * something coarser — the dashboard asks for `1d` over a week, because the
 * design's weekly chart is seven bars labelled Mon to Sun and twenty-eight
 * unlabelled ones answer a different question.
 */
export function defaultBucket(windowHours: number): BucketUnit {
  const spanMs = windowHours * 3_600_000;
  for (const unit of BUCKET_UNITS) {
    // `+ 1` is the unaligned case: a window that starts and ends mid-bucket
    // needs one more than its span divided by the width. Choosing a default
    // that only fits when the clock happens to be on the hour would make the
    // API refuse its own default for most of every hour.
    if (Math.ceil(spanMs / BUCKET_WIDTHS[unit]) + 1 <= MAX_BUCKETS) return unit;
  }
  return '1d';
}

/**
 * Turn a window into aligned buckets, or refuse.
 *
 * ## Why this refuses rather than coarsens
 *
 * The same argument `resolveWindow` makes about clamping the window. A request
 * for 30 days of hourly buckets is a request for 720 queries; answering it with
 * 30 daily buckets would be a different chart wearing the requested chart's
 * label, and the person reading it is trying to see whether a spike happened at
 * 3am. Being told "no, ask for 1d" is recoverable.
 */
export function planSeries(window: AnalyticsWindow, unit?: BucketUnit): SeriesPlan {
  const resolved = unit ?? defaultBucket(window.hours);
  const widthMs = BUCKET_WIDTHS[resolved];
  if (widthMs === undefined) {
    throw new AppError(
      'invalid_request',
      `'bucket' must be one of ${BUCKET_UNITS.join(', ')}; got '${String(unit)}'.`,
    );
  }

  // Align BOTH ends outward to bucket boundaries, then count. Deriving the
  // count from the span instead and hanging it off the last bucket leaves a
  // gap at the old end whenever the clock is not on a boundary: a 24-hour
  // window opened at 14:37 would start its first bucket at 15:00 yesterday and
  // silently drop the 23 minutes before it. Every delivery in the window has to
  // be in exactly one bucket, which means the buckets must cover the window.
  const firstStart = Math.floor(window.from.getTime() / widthMs) * widthMs;
  const lastStart = Math.floor(window.to.getTime() / widthMs) * widthMs;
  const count = (lastStart - firstStart) / widthMs + 1;

  if (count > MAX_BUCKETS) {
    throw new AppError(
      'invalid_request',
      `A ${window.hours}-hour window in '${resolved}' buckets is ${count} buckets, and ${MAX_BUCKETS} ` +
        'is the ceiling: every bucket is its own grouped count, so the bucket count is the query ' +
        `count. Ask for a coarser bucket — '${defaultBucket(window.hours)}' fits this window — or a ` +
        'shorter window. The request is refused rather than coarsened, so a response is never ' +
        'labelled with a finer resolution than it actually has.',
    );
  }

  const buckets: SeriesBucket[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = firstStart + index * widthMs;
    buckets.push({ start: new Date(start), end: new Date(start + widthMs) });
  }

  return {
    unit: resolved,
    widthMs,
    buckets,
    leadingPartial: firstStart < window.from.getTime(),
  };
}

/**
 * One bucket's counts, as the response carries them.
 *
 * The three drawn series are DISJOINT, which is what makes them stackable: a
 * delivery that succeeded on its third attempt is counted in
 * `delivered_after_retry` and nowhere else. A `delivered` total that included
 * the retried ones would double the bar.
 *
 * `in_flight` is not drawn, and it is the reason the newest bar is allowed to
 * look short. It is what makes the bucket total honest: without it, the bar for
 * the current hour would appear to be a collapse in traffic rather than work
 * that has not finished yet.
 */
export interface SeriesCounts {
  delivered_first_try: number;
  delivered_after_retry: number;
  failed: number;
  in_flight: number;
  cancelled: number;
}

export const EMPTY_COUNTS: SeriesCounts = {
  delivered_first_try: 0,
  delivered_after_retry: 0,
  failed: 0,
  in_flight: 0,
  cancelled: 0,
};
