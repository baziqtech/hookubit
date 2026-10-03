import { describe, expect, it } from 'vitest';
import type { RequeueResult } from '../../types/api';
import {
  canContinue,
  completePass,
  describeRun,
  failPass,
  idleRun,
  passButtonLabel,
  startPass,
  totalRequeued,
  type RequeueRun,
} from './requeue-loop';

const result = (requeued: number, has_more: boolean): RequeueResult => ({
  requeued,
  has_more,
  data: [],
});

/**
 * Drives the state machine the way the dialog does: press, await, apply.
 * The fake API is a queue of responses, so the test controls `has_more`.
 */
async function drive(responses: (RequeueResult | Error)[]): Promise<RequeueRun[]> {
  const history: RequeueRun[] = [];
  let run = idleRun;
  for (const response of responses) {
    if (!canContinue(run)) throw new Error('the dialog would not have allowed another pass');
    run = startPass(run);
    history.push(run);
    run = response instanceof Error ? failPass(run, response) : completePass(run, response);
    history.push(run);
  }
  return history;
}

describe('the bulk requeue loop', () => {
  it('keeps going while has_more is true and stops the moment it is false', async () => {
    const history = await drive([result(100, true), result(100, true), result(4, false)]);
    const final = history[history.length - 1];

    expect(final.status).toBe('drained');
    expect(final.passes).toHaveLength(3);
    expect(totalRequeued(final)).toBe(204);
    expect(canContinue(final)).toBe(false);

    // In between, the run is explicitly "more", never quietly "done".
    const afterFirst = history[1];
    expect(afterFirst.status).toBe('more');
    expect(canContinue(afterFirst)).toBe(true);
    expect(describeRun(afterFirst)).toMatch(/more are still parked/);
    expect(passButtonLabel(afterFirst)).toBe('Requeue the next 100');
  });

  it('reads has_more AS WRITTEN — an absent flag is not "drained"', () => {
    // A proxy that rewrote the body, an older deployment: the loop must not
    // report an incident closed on a missing field.
    const run = completePass(idleRun, { requeued: 100 } as unknown as RequeueResult);
    expect(run.status).toBe('drained');
    // …and yet: the honest reading of a MISSING field is false, and the copy
    // says the words "that was all of them" only for a real `false`. Pin that
    // the value we stored is a boolean, never undefined.
    expect(run.passes[0].has_more).toBe(false);
  });

  it('says in words whether anything is still parked, in every state', () => {
    expect(describeRun(idleRun)).toMatch(/up to 100/);
    expect(describeRun(startPass(idleRun))).toMatch(/first pass/);

    const drained = completePass(idleRun, result(37, false));
    expect(describeRun(drained)).toMatch(/37 rows/);
    expect(describeRun(drained)).toMatch(/That was all of them/);
    expect(describeRun(drained)).not.toMatch(/more/);

    const more = completePass(idleRun, result(100, true));
    expect(describeRun(more)).toMatch(/more are still parked/);
    expect(describeRun(more)).not.toMatch(/all of them/);
  });

  it('reports a zero-row pass honestly rather than as a failure', () => {
    const run = completePass(idleRun, result(0, false));
    expect(run.status).toBe('drained');
    expect(describeRun(run)).toMatch(/Nothing was parked/);
    expect(describeRun(run)).toMatch(/audit log/);
  });

  it('keeps the committed passes when a later one fails', async () => {
    const history = await drive([result(100, true), new Error('429')]);
    const final = history[history.length - 1];

    expect(final.status).toBe('failed');
    expect(totalRequeued(final)).toBe(100);
    // The earlier pass committed on the server. The copy must say so, or the
    // operator sends it again and double-counts the recovery.
    expect(describeRun(final)).toMatch(/100 rows/);
    expect(describeRun(final)).toMatch(/already back in the queue/);
    expect(canContinue(final)).toBe(true);
    expect(passButtonLabel(final)).toBe('Retry the next pass');
  });

  it('labels a first-pass failure differently from a mid-run one', () => {
    const run = failPass(startPass(idleRun), new Error('boom'));
    expect(describeRun(run)).toMatch(/nothing was requeued/);
    expect(passButtonLabel(run)).toBe('Try again');
  });

  it('clears a previous error when the next pass starts', () => {
    const failed = failPass(startPass(idleRun), new Error('boom'));
    expect(startPass(failed).error).toBeNull();
  });
});
