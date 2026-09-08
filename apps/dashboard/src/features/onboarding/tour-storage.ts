/**
 * "Has this person seen the tour?" — per browser, because there is nowhere else
 * to put it yet.
 *
 * There is NO field on the user record for this. `localStorage` is the
 * pragmatic answer, and it is worth being explicit about what that costs: the
 * record is per-browser and per-device, so the same person gets the tour again
 * on their phone and loses it when they clear site data. That is an acceptable
 * failure — showing an orientation tour twice is mild — but it is a stand-in,
 * not the design. See HANDOFF.md for the field the control API should grow.
 *
 * Every access is wrapped, because `localStorage` does not merely come back
 * empty in a private window or with site data blocked: THE ACCESSOR ITSELF
 * THROWS. An unguarded read here would take down the whole app shell for anyone
 * browsing privately.
 */

const STORAGE_KEY = 'hookubit.tour.v1';

export type TourRecord = 'completed' | 'skipped';

/**
 * What the user did with the tour, or `null` if they have never seen it — which
 * is also what a throw or a cleared store looks like.
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
    // Storage denied. The tour simply reappears next session; nothing else
    // depends on this value, so there is no state to reconcile.
  }
}

/** Auto-open only for someone with no record at all. A returning user is left alone. */
export function shouldAutoOpenTour(): boolean {
  return readTourRecord() === null;
}
