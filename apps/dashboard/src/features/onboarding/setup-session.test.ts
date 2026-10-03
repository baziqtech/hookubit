import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSetupCompleteness,
  recordSetupCheck,
  resolveOverviewSurface,
  resolveSetupAffordance,
  setupMemory,
  type SetupAffordance,
  type SetupCheck,
} from './setup-visibility';

/**
 * The affordance over TIME, which is the only way this rule is ever wrong.
 *
 * Every other test here asks the resolver one question. This one plays a whole
 * session: a cold load, an outage, a retry, a recovery, a navigation, a project
 * switch — because each of the rule's parts exists to stop a transition, and a
 * single snapshot cannot catch a transition.
 *
 * It exists because the WRITING half had no coverage at all.
 * `renderToStaticMarkup` does not run effects and this workspace has no jsdom
 * (HANDOFF.md), so `useSetupAffordance`'s effect bodies were never executed by
 * the suite: every memory test seeded the map by hand, `rememberSetupCheckFailed`
 * was never reached through the hook, and deleting either effect left the suite
 * green — including the sticky-failure wiring the whole rule rests on. The hook's
 * effect is now one call to `recordSetupCheck`, so what runs in the browser is
 * what runs here, with no React in sight.
 */

const PROJECT = 'proj_live';
const OTHER = 'proj_sibling';

/** One render of the hook: record what was observed, then read the answer. */
function observe(projectId: string, check: SetupCheck): SetupAffordance {
  recordSetupCheck(projectId, check);
  return resolveSetupAffordance(check, setupMemory(projectId));
}

const COLD: SetupCheck = {
  isPending: true,
  isError: false,
  isUndetermined: false,
  isComplete: false,
};
const FAILED: SetupCheck = {
  isPending: false,
  isError: true,
  isUndetermined: false,
  isComplete: false,
};
const COMPLETE: SetupCheck = {
  isPending: false,
  isError: false,
  isUndetermined: false,
  isComplete: true,
};
const INCOMPLETE: SetupCheck = {
  isPending: false,
  isError: false,
  isUndetermined: false,
  isComplete: false,
};
const TRUNCATED: SetupCheck = {
  isPending: false,
  isError: false,
  isUndetermined: true,
  isComplete: false,
};

describe('one project, across a session', () => {
  beforeEach(() => forgetSetupCompleteness());

  it('goes cold load → outage → retry → recovery → navigation without ever lying', () => {
    // 1. First paint. Nothing is known, so nothing is claimed — and an operating
    //    project therefore cannot flicker a Setup item.
    expect(observe(PROJECT, COLD)).toBe('unknown');
    expect(setupMemory(PROJECT)).toEqual({ complete: null, failed: false });

    // 2. An input fails. Hiding would be indistinguishable from "this project is
    //    done", and an error does not resolve itself the way a pending check does.
    expect(observe(PROJECT, FAILED)).toBe('show');
    expect(setupMemory(PROJECT)).toEqual({ complete: null, failed: true });

    // 3. The failed query is refetched on the next mount and reports as PENDING
    //    with no data. This is the transition the sticky flag exists for: without
    //    it the item would vanish here and come back on the next navigation.
    expect(observe(PROJECT, COLD)).toBe('show');

    // 4. The retry lands, and the project is in fact fully set up. A resolved
    //    answer overrides the failure — in this direction too.
    expect(observe(PROJECT, COMPLETE)).toBe('hide');
    expect(setupMemory(PROJECT)).toEqual({ complete: true, failed: true });

    // 5. Navigating elsewhere remounts the queries: pending again, with the same
    //    failure still on the record. The last RESOLVED answer wins over it, so
    //    the item does not reappear on a project that is finished.
    expect(observe(PROJECT, COLD)).toBe('hide');

    // 6. The last endpoint is paused. Derivation is live, so the affordance comes
    //    back on its own — no re-onboarding path, no dismissal to respect.
    expect(observe(PROJECT, INCOMPLETE)).toBe('show');
    expect(setupMemory(PROJECT)).toEqual({ complete: false, failed: true });

    // 7. And an outage now falls back to "incomplete", not to silence.
    expect(observe(PROJECT, FAILED)).toBe('show');
  });

  it('records nothing from a check that could not determine an input', () => {
    /*
     * A 200 whose page did not contain the answer (fifty paused endpoints and
     * `has_more`). It must not be written down in either direction: as
     * "incomplete" it would pin a Setup item onto a delivering project for the
     * rest of the session, and as "complete" it would claim something nobody read.
     */
    expect(observe(PROJECT, TRUNCATED)).toBe('unknown');
    expect(setupMemory(PROJECT)).toEqual({ complete: null, failed: false });

    // And it is not a failure either, so it leaves no sticky flag behind: once a
    // real answer arrives it is the only thing on the record.
    expect(observe(PROJECT, COMPLETE)).toBe('hide');
    expect(setupMemory(PROJECT)).toEqual({ complete: true, failed: false });

    // A later truncated read then reads the remembered answer rather than blinking.
    expect(observe(PROJECT, TRUNCATED)).toBe('hide');
  });

  it('carries the overview through the same sequence, one surface behind the rail', () => {
    const surfaces: string[] = [];
    for (const check of [COLD, FAILED, COLD, COMPLETE, COLD, INCOMPLETE]) {
      surfaces.push(resolveOverviewSurface(observe(PROJECT, check), check.isError));
    }

    /*
     * The two surfaces agree everywhere except on the errored check, where the
     * overview stays on the health page (frame 07b) while the rail shows its item.
     * Nowhere in this sequence does the overview paint the health block on an
     * unresolved check, which is the flash it was doing before.
     */
    expect(surfaces).toEqual([
      'waiting', // cold: neither branch
      'health', // errored: instruments stay up, per 07b
      'checklist', // retry in flight, remembered as failed
      'health', // resolved complete
      'health', // remembered complete through a remount
      'checklist', // regressed below six
    ]);
  });
});

describe('two projects in one session', () => {
  beforeEach(() => forgetSetupCompleteness());

  it('inherits nothing across a project switch, in either direction', () => {
    expect(observe(PROJECT, COMPLETE)).toBe('hide');

    // The sibling is a different project. Hiding its checklist because its
    // neighbour is finished is the exact shape of a stored completion flag.
    expect(observe(OTHER, COLD)).toBe('unknown');
    expect(setupMemory(OTHER)).toEqual({ complete: null, failed: false });

    // Its own outage is its own, and does not touch what the first project knows.
    expect(observe(OTHER, FAILED)).toBe('show');
    expect(setupMemory(PROJECT)).toEqual({ complete: true, failed: false });

    // Coming back to the first project reads its own record, not the sibling's.
    expect(observe(PROJECT, COLD)).toBe('hide');
  });

  it('holds nothing at all for a shell with no project in the route', () => {
    // `AppLayout` renders the rail on organization-level screens too, where the
    // id is empty. Nothing may be recorded under that key, or every project in
    // the organization would share one answer.
    expect(observe('', COMPLETE)).toBe('hide');
    expect(setupMemory('')).toEqual({ complete: null, failed: false });
    expect(observe('', FAILED)).toBe('show');
    expect(setupMemory('')).toEqual({ complete: null, failed: false });
  });
});
