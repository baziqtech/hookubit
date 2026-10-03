/**
 * "Has this person seen the tour?" — answered by the SERVER, with this file
 * as the fallback for the moments the server has not caught up.
 *
 * The user record carries `onboarding_completed_at` (see `AuthUserDto`), set
 * by `POST /v1/auth/onboarding-completed` when the tour is finished or skipped
 * and returned on every response that carries a user. That is the source of
 * truth: it follows the person to their phone, to a second browser, and
 * through a cleared site-data, which a browser-local record never could.
 *
 * `localStorage` survives here for exactly one job: the window between the
 * click and the response. The POST is fired when the tour closes, the cached
 * session is patched optimistically, and the session is then refetched — and
 * if that POST fails, or the tab is closed mid-flight, the next load would
 * otherwise show the tour to someone who just dismissed it. The local record
 * closes that gap. It never OVERRIDES the server: a non-null timestamp wins
 * regardless of what this browser remembers, and the record is only consulted
 * when the server says "never".
 *
 * Every access is wrapped, because `localStorage` does not merely come back
 * empty in a private window or with site data blocked: THE ACCESSOR ITSELF
 * THROWS. An unguarded read here would take down the whole app shell for anyone
 * browsing privately.
 */

const STORAGE_KEY = 'hookubit.tour.v1';

export type TourRecord = 'completed' | 'skipped';

/**
 * What this browser remembers the user doing with the tour, or `null` if
 * nothing — which is also what a throw or a cleared store looks like.
 *
 * Treating "cannot tell" as "never seen" is the safe direction: the tour is
 * skippable and re-openable, so the cost of showing it once more is a
 * keystroke, whereas the cost of wrongly suppressing it is a new user with no
 * orientation at all.
 */
export function readTourRecord(): TourRecord | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'completed' || raw === 'skipped' ? raw : null;
  } catch {
    return null;
  }
}

export function writeTourRecord(record: TourRecord): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, record);
  } catch {
    // Storage denied. The server record still covers the next load; only the
    // in-flight window is unprotected, and nothing else depends on this value.
  }
}

/**
 * Auto-open only for someone the server has no completion for AND this
 * browser has no record for. Server first: a timestamp means done, whatever
 * this browser remembers. The local record decides only when the server says
 * `null`, which covers the request that has not landed yet and the one that
 * failed.
 */
export function shouldAutoOpenTour(onboardingCompletedAt: string | null): boolean {
  if (onboardingCompletedAt !== null) return false;
  return readTourRecord() === null;
}
