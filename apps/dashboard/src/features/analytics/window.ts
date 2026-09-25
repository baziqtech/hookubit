import { DEFAULT_WINDOW_HOURS } from '../../types/api';

/**
 * The four windows the UI offers, the `window_hours` each maps to, and the
 * bucket width its chart asks for.
 *
 * The API takes any integer 1..720; the dashboard offers four because "the last
 * hour / day / week / month" is what an operator compares against, and a
 * free-form hour count would put 721 on a screen and get a 400 back.
 *
 * `bucket` is stated rather than left to the API's default in the two cases
 * where the bars have to be NAMED. Over a week the default is `6h` — twenty
 * eight unlabelled bars — where `1d` is seven bars called Mon to Sun. Over a
 * month the default `1d` is already right, so it is repeated here only so the
 * table reads as one decision per row rather than three plus a silence.
 *
 * `1h` is the incident window: something is happening now and the hourly chart
 * is too coarse to see it. Twelve five-minute bars is the finest the API will
 * cut, and it is enough to tell a spike from a plateau.
 */
export const ANALYTICS_WINDOWS = [
  { key: '1h', hours: 1, label: 'Last hour', previous: 'the hour before', bucket: '5m' },
  { key: '24h', hours: 24, label: 'Last 24 hours', previous: 'the 24 hours before', bucket: '1h' },
  { key: '7d', hours: 168, label: 'Last 7 days', previous: 'the 7 days before', bucket: '1d' },
  { key: '30d', hours: 720, label: 'Last 30 days', previous: 'the 30 days before', bucket: '1d' },
] as const;

/** One row of the table above: everything a page needs to label a window. */
export type AnalyticsWindowChoice = (typeof ANALYTICS_WINDOWS)[number];
export type AnalyticsWindowKey = (typeof ANALYTICS_WINDOWS)[number]['key'];
export type AnalyticsWindowHours = (typeof ANALYTICS_WINDOWS)[number]['hours'];
export type AnalyticsWindowBucket = (typeof ANALYTICS_WINDOWS)[number]['bucket'];

export const DEFAULT_WINDOW_KEY: AnalyticsWindowKey = '24h';

/**
 * `?window=` → a window. Anything unrecognised is the default rather than an
 * error: the parameter is a view preference, and a stale bookmark should open
 * the page, not break it.
 */
export function parseWindowKey(raw: string | null | undefined): AnalyticsWindowKey {
  const found = ANALYTICS_WINDOWS.find((window) => window.key === raw);
  return found ? found.key : DEFAULT_WINDOW_KEY;
}

export function windowFor(key: AnalyticsWindowKey) {
  return ANALYTICS_WINDOWS.find((window) => window.key === key) ?? ANALYTICS_WINDOWS[0];
}

export function hoursFor(key: AnalyticsWindowKey): AnalyticsWindowHours {
  return windowFor(key).hours;
}

export function bucketFor(key: AnalyticsWindowKey): AnalyticsWindowBucket {
  return windowFor(key).bucket;
}

/** Sanity: the default the UI opens on is the default the API applies. */
export const DEFAULT_WINDOW_MATCHES_API = hoursFor(DEFAULT_WINDOW_KEY) === DEFAULT_WINDOW_HOURS;
