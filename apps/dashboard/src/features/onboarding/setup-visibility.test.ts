import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSetupCompleteness,
  rememberSetupCheckFailed,
  rememberSetupCompleteness,
  resolveOverviewSurface,
  resolveSetupAffordance,
  setupMemory,
} from './setup-visibility';

const RESOLVED_COMPLETE = {
  isPending: false,
  isError: false,
  isUndetermined: false,
  isComplete: true,
};
const RESOLVED_INCOMPLETE = {
  isPending: false,
  isError: false,
  isUndetermined: false,
  isComplete: false,
};
/*
 * `isComplete` is deliberately FALSE in both unresolved fixtures, because that is
 * what the real derivation returns when the inputs are empty. Every "does it
 * guess?" assertion below is only meaningful against that value: a resolver that
 * read it while unresolved would report a fully operating project as 2/6.
 */
const PENDING = { isPending: true, isError: false, isUndetermined: false, isComplete: false };
const ERRORED = { isPending: false, isError: true, isUndetermined: false, isComplete: false };
/*
 * A SUCCESSFUL read that does not contain the answer: page one of the endpoints
 * held no deliverable row and `has_more` is true. `isComplete` is false because
 * the derivation can only read the page it was given — which is precisely why
 * this must not resolve as "incomplete".
 */
const UNDETERMINED = {
  isPending: false,
  isError: false,
  isUndetermined: true,
  isComplete: false,
};

const NOTHING = { complete: null, failed: false };

describe('resolveSetupAffordance', () => {
  it('hides the affordance on a project measurably complete, and shows it on one that is not', () => {
    expect(resolveSetupAffordance(RESOLVED_COMPLETE, NOTHING)).toBe('hide');
    expect(resolveSetupAffordance(RESOLVED_INCOMPLETE, NOTHING)).toBe('show');
  });

  it('answers "unknown" while the first check is in flight rather than guessing either way', () => {
    // The whole cold-load problem in one assertion. `show` here would flash a
    // Setup item onto every operating project on every load; `hide` would claim
    // an unread project is done. Neither is knowledge, so neither is rendered.
    expect(resolveSetupAffordance(PENDING, NOTHING)).toBe('unknown');
  });

  it('renders the last resolved value while a later check is in flight', () => {
    expect(resolveSetupAffordance(PENDING, { complete: true, failed: false })).toBe('hide');
    expect(resolveSetupAffordance(PENDING, { complete: false, failed: false })).toBe('show');
  });

  it('never hides on an errored check with nothing to fall back on', () => {
    /*
     * The trap this module exists for. An error is not an answer, and unlike a
     * pending check it will not become one — so staying quiet would leave an
     * incomplete project with no route to its checklist for as long as the outage
     * lasts, and hiding would assert the project is ready. Showing is the only
     * honest side to err on.
     */
    expect(resolveSetupAffordance(ERRORED, NOTHING)).toBe('show');
  });

  it('prefers a resolved memory to erring, in both directions', () => {
    expect(resolveSetupAffordance(ERRORED, { complete: true, failed: true })).toBe('hide');
    expect(resolveSetupAffordance(ERRORED, { complete: false, failed: true })).toBe('show');
  });

  it('keeps showing while a failed check is being retried, so it cannot blink', () => {
    // The retry reports as pending with no data. Nothing has been confirmed, but
    // "we asked and were refused" is still the last thing that happened.
    expect(resolveSetupAffordance(PENDING, { complete: null, failed: true })).toBe('show');
  });

  it('treats a partly-failed check as errored rather than as still loading', () => {
    // One of the six inputs failed while another is still in flight. The failure
    // is the fact that matters: nothing is going to resolve it.
    expect(
      resolveSetupAffordance(
        { isPending: true, isError: true, isUndetermined: false, isComplete: false },
        NOTHING,
      ),
    ).toBe('show');
  });

  it('claims nothing from a page that did not contain the answer', () => {
    /*
     * >50 endpoints, the first fifty all paused, `has_more` true. Counting that
     * page as "nothing is delivering" puts a permanent Setup item on a project
     * that is delivering fine — the same false claim as an errored check, reached
     * through a 200. It is not an error either, so it does not err towards
     * showing: it simply is not knowledge.
     */
    expect(resolveSetupAffordance(UNDETERMINED, NOTHING)).toBe('unknown');
  });

  it('falls back to what the project last resolved to, when a page cannot answer', () => {
    expect(resolveSetupAffordance(UNDETERMINED, { complete: true, failed: false })).toBe('hide');
    expect(resolveSetupAffordance(UNDETERMINED, { complete: false, failed: false })).toBe('show');
  });

  it('still shows when a page cannot answer and an earlier check failed', () => {
    expect(resolveSetupAffordance(UNDETERMINED, { complete: null, failed: true })).toBe('show');
    expect(
      resolveSetupAffordance({ ...UNDETERMINED, isError: true }, { complete: null, failed: false }),
    ).toBe('show');
  });
});

describe('resolveOverviewSurface', () => {
  it('renders the health page only for a project measurably complete', () => {
    expect(resolveOverviewSurface('hide', false)).toBe('health');
  });

  it('renders the checklist for a project measurably incomplete', () => {
    expect(resolveOverviewSurface('show', false)).toBe('checklist');
  });

  it('renders NEITHER branch while the check is unresolved', () => {
    // The flash this exists to stop: a 0/6 project used to paint the whole health
    // block — skeletons, charts and the analytics requests behind them — and then
    // swap it for the checklist.
    expect(resolveOverviewSurface('unknown', false)).toBe('waiting');
  });

  it('keeps the health page up when the check errored, on every affordance', () => {
    /*
     * The one place the rule differs by surface, per design frame 07b. The rail
     * SHOWS its item on an errored check; this page does not flip an operating
     * project over to a guided setup path because one list request failed.
     */
    expect(resolveOverviewSurface('show', true)).toBe('health');
    expect(resolveOverviewSurface('hide', true)).toBe('health');
    expect(resolveOverviewSurface('unknown', true)).toBe('health');
  });
});

describe('what the session remembers', () => {
  beforeEach(() => forgetSetupCompleteness());

  it('is per project — switching projects inherits nothing', () => {
    rememberSetupCompleteness('proj_done', true);

    expect(setupMemory('proj_done').complete).toBe(true);
    // Setup state belongs to a project. A sibling must be recomputed from
    // scratch, not hidden because its neighbour was finished.
    expect(setupMemory('proj_other')).toEqual(NOTHING);
  });

  it('records completeness dropping back, so a regressed project stops being remembered as done', () => {
    rememberSetupCompleteness('proj_done', true);
    rememberSetupCompleteness('proj_done', false);

    expect(resolveSetupAffordance(ERRORED, setupMemory('proj_done'))).toBe('show');
  });

  it('keeps a failure separate from an answer', () => {
    rememberSetupCheckFailed('proj_down');

    expect(setupMemory('proj_down')).toEqual({ complete: null, failed: true });
    // A failure never becomes a completeness claim, in either direction.
    expect(resolveSetupAffordance(PENDING, setupMemory('proj_down'))).toBe('show');
  });

  it('lets a later resolved answer override an earlier failure', () => {
    rememberSetupCheckFailed('proj_up');
    rememberSetupCompleteness('proj_up', true);

    expect(resolveSetupAffordance(PENDING, setupMemory('proj_up'))).toBe('hide');
  });

  it('holds nothing for a project with no id, so an unrouted shell cannot hide anything', () => {
    rememberSetupCompleteness('', true);
    rememberSetupCheckFailed('');

    expect(setupMemory('')).toEqual(NOTHING);
  });

  it('forgets one project without forgetting the rest', () => {
    rememberSetupCompleteness('proj_a', true);
    rememberSetupCompleteness('proj_b', true);
    forgetSetupCompleteness('proj_a');

    expect(setupMemory('proj_a').complete).toBeNull();
    expect(setupMemory('proj_b').complete).toBe(true);
  });
});
