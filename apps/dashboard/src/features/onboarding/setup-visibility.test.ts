import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSetupCompleteness,
  rememberSetupCheckFailed,
  rememberSetupCompleteness,
  resolveSetupAffordance,
  setupMemory,
} from './setup-visibility';

const RESOLVED_COMPLETE = { isPending: false, isError: false, isComplete: true };
const RESOLVED_INCOMPLETE = { isPending: false, isError: false, isComplete: false };
/*
 * `isComplete` is deliberately FALSE in both unresolved fixtures, because that is
 * what the real derivation returns when the inputs are empty. Every "does it
 * guess?" assertion below is only meaningful against that value: a resolver that
 * read it while unresolved would report a fully operating project as 2/6.
 */
const PENDING = { isPending: true, isError: false, isComplete: false };
const ERRORED = { isPending: false, isError: true, isComplete: false };

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
      resolveSetupAffordance({ isPending: true, isError: true, isComplete: false }, NOTHING),
    ).toBe('show');
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
