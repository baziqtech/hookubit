import { formatPercent } from '../../lib/format';

/**
 * The few derivations the analytics screens make from response fields.
 *
 * Kept as plain functions, apart from the JSX, for two reasons: they are the
 * places a null can silently become a 0, which is the one bug the DTOs exist
 * to prevent, and they are testable without a DOM.
 */

/**
 * `success_rate` is `number | null`, and null means "nothing settled" — NOT 0%,
 * which means everything failed. This is the only place a rate becomes text.
 */
export function formatRate(rate: number | null, digits = 2): string {
  return rate === null ? '—' : formatPercent(rate, digits);
}

/**
 * A rate change in percentage POINTS, signed. `success_rate_delta` is null when
 * either window had nothing settled, because a change from "unknown" is not a
 * change — and that null is rendered as words, never as "+0.0 pts".
 */
export function formatRateDelta(delta: number | null, digits = 1): string {
  if (delta === null) return 'no comparison';
  const points = delta * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '±';
  return `${sign}${Math.abs(points).toFixed(digits)} pts`;
}

/** A count change, signed. `0` is "no change" rather than "+0". */
export function formatCountDelta(delta: number): string {
  if (delta === 0) return 'no change';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta).toLocaleString('en')}`;
}

/**
 * The tone of a success rate. Null has no tone: an idle project is not a
 * healthy one and not a broken one, and painting it green would be a claim.
 */
export function rateTone(rate: number | null): 'default' | 'ok' | 'warn' | 'danger' {
  if (rate === null) return 'default';
  if (rate < 0.9) return 'danger';
  if (rate < 0.99) return 'warn';
  return 'ok';
}

/**
 * Deliveries per event. One publish becomes one delivery per matching
 * subscription, so `deliveries.total / events.total` is how many deliveries an average publish
 * creates here.
 * Null when there were no events: a ratio over zero is not a number, and the
 * two totals also come from two different responses that may not both be in
 * hand yet.
 */
export function deliveriesPerEvent(
  deliveriesTotal: number | undefined,
  eventsTotal: number | undefined,
): number | null {
  if (deliveriesTotal === undefined || eventsTotal === undefined) return null;
  if (eventsTotal <= 0) return null;
  return deliveriesTotal / eventsTotal;
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : `${ratio.toFixed(2)}×`;
}

/** A nullable millisecond figure, for the latency percentiles. */
export function formatNullableDuration(
  ms: number | null,
  format: (ms: number) => string,
): string {
  return ms === null ? '—' : format(ms);
}

/**
 * A share of a total, in 0..1, for the proportion bars. Zero total is zero
 * share, not NaN — the bar is decoration beside a table that carries the
 * counts, so it is allowed to be empty and never allowed to be wrong.
 */
export function share(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  return Math.min(1, count / total);
}
