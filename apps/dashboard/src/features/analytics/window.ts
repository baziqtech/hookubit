import { DEFAULT_WINDOW_HOURS } from '../../types/api';

/**
 * The three windows the UI offers, and the `window_hours` each maps to.
 *
 * The API takes any integer 1..720; the dashboard offers three because "the
 * last day / week / month" is what an operator compares against, and a
 * free-form hour count would put 721 on a screen and get a 400 back. These are
 * the shorthands the API's own DTO documentation names.
 */
export const ANALYTICS_WINDOWS = [
  { key: '24h', hours: 24, label: 'Last 24 hours', previous: 'the 24 hours before' },
  { key: '7d', hours: 168, label: 'Last 7 days', previous: 'the 7 days before' },
  { key: '30d', hours: 720, label: 'Last 30 days', previous: 'the 30 days before' },
] as const;

export type AnalyticsWindowKey = (typeof ANALYTICS_WINDOWS)[number]['key'];
export type AnalyticsWindowHours = (typeof ANALYTICS_WINDOWS)[number]['hours'];

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

/** Sanity: the default the UI opens on is the default the API applies. */
export const DEFAULT_WINDOW_MATCHES_API = hoursFor(DEFAULT_WINDOW_KEY) === DEFAULT_WINDOW_HOURS;
