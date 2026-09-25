/**
 * Whether to offer a setup affordance at all.
 *
 * `deriveSetupSteps` answers "what is left to do". This answers the question
 * one level up, and it is the harder one: SHOULD THE CHECKLIST BE ON SCREEN.
 * Once a project is fully set up the answer is no — a checklist that can never
 * change again is noise in the primary nav — and the moment visibility depends
 * on completeness, "we could not find out" stops being a harmless state.
 *
 * ## Three values, not two
 *
 * Completeness is derived from six live queries. Those queries can be in
 * flight, and they can fail, so the honest answer has three cases and not two:
 *
 * - `show`    — this project is measurably incomplete. Offer the checklist.
 * - `hide`    — this project is measurably complete. Offer nothing.
 * - `unknown` — we do not know yet, and will not guess.
 *
 * `unknown` renders NOTHING, which is the same thing `hide` renders. That
 * equivalence is what resolves the cold-load tension: a project that is
 * operating shows no Setup item while the first check is in flight and no Setup
 * item after it resolves, so there is nothing to flicker. The cost is borne by
 * the incomplete project instead — its Setup item appears a beat late — and
 * that is the right way round, because appearing late is recoverable and
 * claiming a project is ready when it is not is not.
 *
 * ## Why an errored check shows rather than hides
 *
 * Hiding the affordance is a positive claim: "this project is done." A failed
 * check is not entitled to make it, and unlike an in-flight check it will not
 * resolve itself a moment later — so `unknown` would leave an incomplete
 * project with no path to its checklist for as long as the outage lasts. An
 * error therefore falls back to the last value we actually observed for that
 * project, and shows the affordance when there is none.
 */

export type SetupAffordance = 'show' | 'hide' | 'unknown';

export interface SetupCheck {
  /** No answer yet — the first load of this project's inputs. */
  isPending: boolean;
  /** At least one input could not be read. */
  isError: boolean;
  /**
   * Derived from live project state. Only meaningful when the check has
   * resolved: an unread project derives as incomplete simply because its
   * inputs are empty, which is exactly the false "2/6" this module exists to
   * keep off the screen.
   */
  isComplete: boolean;
}

/** What this session has learned about one project's setup state. */
export interface SetupMemory {
  /**
   * Completeness as of the last check that actually RESOLVED, or `null` if none
   * ever has for this project in this session.
   */
  complete: boolean | null;
  /**
   * Whether a check for this project has ever failed here.
   *
   * Sticky, and load-bearing: a failed query is refetched on remount, and while
   * that retry is in flight the query reports pending with no data — so without
   * this, navigating around during an outage would make the Setup item vanish
   * and return on every page. "We asked and were refused" does not stop being
   * true because we are asking again.
   */
  failed: boolean;
}

/** Frozen: it is handed out for every project nothing is known about. */
const NOTHING_KNOWN: SetupMemory = Object.freeze({ complete: null, failed: false });

/**
 * The decision, as a pure function of the live check and what is remembered.
 */
export function resolveSetupAffordance(check: SetupCheck, memory: SetupMemory): SetupAffordance {
  // Resolved. The only branch entitled to an opinion of its own.
  if (!check.isPending && !check.isError) return check.isComplete ? 'hide' : 'show';

  // Unresolved, but this project has resolved before. Render what was true then
  // rather than a guess — stale is honest, invented is not.
  if (memory.complete !== null) return memory.complete ? 'hide' : 'show';

  /*
   * Unresolved, nothing ever confirmed, and at least one attempt has failed.
   * Show it. The error is checked BEFORE pending and beats it when both are true
   * (one input failed while another is still loading), because a failure does
   * not clear itself: staying quiet would be indistinguishable from concluding
   * that the project is done.
   */
  if (check.isError || memory.failed) return 'show';

  // A first load, in flight. Nothing is known, so nothing is claimed.
  return 'unknown';
}

/**
 * What this session has learned, per project.
 *
 * Deliberately in memory and not in `localStorage`. Persisting it would make it
 * a stored completion flag by another name: a project whose last endpoint was
 * deleted from another tab, or by a script, would come back from a reload with
 * "complete" on disk, and a check that then failed would hide the checklist on
 * the strength of a fact that had stopped being true days ago. In memory, the
 * fallback is never older than the tab, and a reload re-derives from the API.
 *
 * Keyed by project because setup state belongs to a project: switching projects
 * must recompute from scratch, never inherit.
 */
const memories = new Map<string, SetupMemory>();

function entry(projectId: string): SetupMemory {
  const existing = memories.get(projectId);
  if (existing) return existing;
  const fresh: SetupMemory = { complete: null, failed: false };
  memories.set(projectId, fresh);
  return fresh;
}

/** Record a RESOLVED answer. Only this is knowledge. */
export function rememberSetupCompleteness(projectId: string, isComplete: boolean): void {
  if (!projectId) return;
  entry(projectId).complete = isComplete;
}

/** Record that a check for this project failed. */
export function rememberSetupCheckFailed(projectId: string): void {
  if (!projectId) return;
  entry(projectId).failed = true;
}

export function setupMemory(projectId: string): SetupMemory {
  if (!projectId) return NOTHING_KNOWN;
  return memories.get(projectId) ?? NOTHING_KNOWN;
}

/** Test seam, and the reset a sign-out would want. */
export function forgetSetupCompleteness(projectId?: string): void {
  if (projectId === undefined) memories.clear();
  else memories.delete(projectId);
}
