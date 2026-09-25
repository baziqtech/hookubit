import type { DeliverySeries, SeriesBucket } from '../../types/api';

/**
 * Turning a series into a chart, with no React and no DOM.
 *
 * Every decision that can make a chart LIE lives here rather than in the
 * component: what the axis maxes out at, how a bar is divided, which ticks get
 * labels, and what a bucket with nothing in it looks like. Those are the things
 * worth testing, and this workspace has no jsdom (see HANDOFF.md), so they have
 * to be expressible without one.
 */

/** The three drawn bands, in stacking order: best outcome at the bottom. */
export const BANDS = [
  { key: 'delivered_first_try', label: 'Delivered', tone: 'ok' },
  { key: 'delivered_after_retry', label: 'Retried', tone: 'warn' },
  { key: 'failed', label: 'Failed', tone: 'danger' },
] as const;

export type BandKey = (typeof BANDS)[number]['key'];

export interface BarSegment {
  key: BandKey | 'in_flight';
  /** Share of the chart's Y range, 0..1. Multiply by the plot height. */
  fraction: number;
  count: number;
}

export interface Bar {
  start: string;
  end: string;
  total: number;
  segments: BarSegment[];
  /** True when the bucket held nothing at all — drawn as a baseline tick. */
  empty: boolean;
}

export interface ChartLayout {
  bars: Bar[];
  /** The value the top of the plot represents. Always > 0. */
  max: number;
  /** Gridline values from top to bottom, including `max` and 0. */
  ticks: number[];
  /** Index → label, for the buckets that get one. */
  xLabels: Map<number, string>;
  /** Totals across every bucket, for the legend. */
  totals: Record<BandKey | 'in_flight', number>;
}

/** The counted fields of a bucket, in stacking order, plus the undrawn one. */
const STACK: Array<BandKey | 'in_flight'> = [
  'delivered_first_try',
  'delivered_after_retry',
  'failed',
  'in_flight',
];

/**
 * A chart from a series.
 *
 * ## The Y axis is rounded UP to a readable number, never fitted to the data
 *
 * A plot whose top is exactly the tallest bar has no headroom and no round
 * gridline, so two screenshots taken an hour apart are drawn to different
 * scales and cannot be compared by eye — which is the only way anybody compares
 * them. `niceMax` rounds to 1, 2 or 5 times a power of ten.
 *
 * ## An empty window is a flat chart, not a blank one
 *
 * When nothing happened the max is forced to 1, so the axis reads 0 and 1 and
 * the plot is an empty grid rather than a collapsed strip. "Nothing was
 * delivered" and "the chart failed to load" must not look the same.
 *
 * ## `in_flight` is stacked but not in the legend
 *
 * It is included in each bar's height so the newest bucket is not a cliff, and
 * it is drawn in a muted tone because it is not an outcome — it is work that
 * has not finished. Leaving it out entirely would make the current bucket look
 * like a traffic collapse on every page load.
 */
export function layoutSeries(series: DeliverySeries, maxXLabels = 8): ChartLayout {
  const buckets = series.buckets;

  const totals = {
    delivered_first_try: 0,
    delivered_after_retry: 0,
    failed: 0,
    in_flight: 0,
  } as Record<BandKey | 'in_flight', number>;

  let tallest = 0;
  for (const bucket of buckets) {
    let height = 0;
    for (const key of STACK) {
      const value = bucketValue(bucket, key);
      totals[key] += value;
      height += value;
    }
    if (height > tallest) tallest = height;
  }

  const max = tallest === 0 ? 1 : niceMax(tallest);

  const bars: Bar[] = buckets.map((bucket) => {
    const segments: BarSegment[] = [];
    let total = 0;
    for (const key of STACK) {
      const count = bucketValue(bucket, key);
      total += count;
      if (count > 0) segments.push({ key, fraction: count / max, count });
    }
    return { start: bucket.start, end: bucket.end, total, segments, empty: total === 0 };
  });

  return {
    bars,
    max,
    ticks: ticksFor(max),
    xLabels: xLabelsFor(buckets, series.bucket_ms, maxXLabels),
    totals,
  };
}

function bucketValue(bucket: SeriesBucket, key: BandKey | 'in_flight'): number {
  const value = bucket[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The smallest 1/2/5 × 10^n at or above `value`.
 *
 * 37 → 40, 210 → 500, 1 → 1. The point is a top-of-axis a human recognises as
 * a round number, so the gridlines below it are round too.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** Four gridlines including both ends, so the axis has a middle to read against. */
function ticksFor(max: number): number[] {
  return [max, (max * 2) / 3, max / 3, 0].map((value) => Math.round(value));
}

/**
 * Label roughly `maxLabels` of the buckets, evenly spaced, newest always
 * labelled.
 *
 * Labelling every bucket is unreadable at 24 bars and illegible at 31. Anchoring
 * the spacing on the LAST bucket rather than the first means the rightmost bar —
 * the one being read right now — always has a time under it.
 */
function xLabelsFor(
  buckets: readonly SeriesBucket[],
  bucketMs: number,
  maxLabels: number,
): Map<number, string> {
  const labels = new Map<number, string>();
  if (buckets.length === 0) return labels;

  const stride = Math.max(1, Math.ceil(buckets.length / maxLabels));
  // A bucket a day wide or more is a date; anything finer is a clock time.
  const daily = bucketMs >= 24 * 3_600_000;

  for (let index = buckets.length - 1; index >= 0; index -= stride) {
    labels.set(index, formatTick(buckets[index].start, daily));
  }
  return labels;
}

function formatTick(iso: string, daily: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return daily
    ? date.toLocaleDateString(undefined, { weekday: 'short' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * "48,210 deliveries · 99.3% delivered", or the honest absence of it.
 *
 * Returns null when nothing settled in the window. A success rate of 0% means
 * everything failed, which is the loudest thing this chart can say, so an idle
 * project must never be rendered as one.
 */
export function settledRate(totals: ChartLayout['totals']): number | null {
  const settled = totals.delivered_first_try + totals.delivered_after_retry + totals.failed;
  if (settled === 0) return null;
  return (totals.delivered_first_try + totals.delivered_after_retry) / settled;
}
