import { MAX_REQUEUE_BATCH, type RequeueResult } from '../../types/api';

/**
 * The bulk requeue as a state machine, kept out of the component so the
 * `has_more` loop — the part that decides whether an incident is actually
 * closed — is testable without a DOM.
 *
 * ## Why the loop is VISIBLE rather than automatic
 *
 * `POST …/outbox/requeue` returns at most `MAX_REQUEUE_BATCH` rows, oldest
 * first, and says `has_more` when it left some behind. A page that looped
 * silently until `has_more` was false would be doing two things wrong at once:
 *
 *   1. Every requeued row becomes a fan-out, and every fan-out becomes real
 *      HTTP to endpoints that were, very often, already failing when the
 *      incident started. Draining 40,000 parked rows in one click is a
 *      self-inflicted burst. Bounded passes let an operator watch the first
 *      hundred drain before committing the rest.
 *   2. The route is throttled to 10 calls per five minutes, so an automatic
 *      loop over a large incident would hit a 429 on its eleventh pass and the
 *      operator would see a red panel with no idea how far it got.
 *
 * So each pass is an explicit press, the tally of every pass is shown, and
 * "more remain" is stated in words. The operator always knows whether the
 * incident is closed, which is the question `has_more` exists to answer.
 */
export interface RequeuePass {
  requeued: number;
  has_more: boolean;
}

export type RequeueRunStatus =
  /** Nothing has been sent yet. */
  | 'idle'
  /** A pass is in flight. */
  | 'running'
  /** The last pass said `has_more: true`; the next one needs a press. */
  | 'more'
  /** The last pass said `has_more: false`; nothing parked is left. */
  | 'drained'
  /** The last pass failed. Earlier passes still count — they committed. */
  | 'failed';

export interface RequeueRun {
  status: RequeueRunStatus;
  passes: RequeuePass[];
  error: unknown;
}

export const idleRun: RequeueRun = { status: 'idle', passes: [], error: null };

export function startPass(run: RequeueRun): RequeueRun {
  return { ...run, status: 'running', error: null };
}

/**
 * `has_more` is read AS WRITTEN. A truthiness test would turn an absent field
 * into "drained" — and an incident reported closed with rows still parked is
 * precisely the failure this loop exists to prevent.
 */
export function completePass(run: RequeueRun, result: Pick<RequeueResult, 'requeued' | 'has_more'>): RequeueRun {
  const pass: RequeuePass = { requeued: result.requeued, has_more: result.has_more === true };
  return {
    status: pass.has_more ? 'more' : 'drained',
    passes: [...run.passes, pass],
    error: null,
  };
}

export function failPass(run: RequeueRun, error: unknown): RequeueRun {
  return { ...run, status: 'failed', error };
}

/** Rows returned to the queue across every pass so far. */
export function totalRequeued(run: RequeueRun): number {
  return run.passes.reduce((sum, pass) => sum + pass.requeued, 0);
}

/** Whether pressing the button again would send another pass. */
export function canContinue(run: RequeueRun): boolean {
  return run.status === 'idle' || run.status === 'more' || run.status === 'failed';
}

function rows(n: number): string {
  return `${n} row${n === 1 ? '' : 's'}`;
}

function passes(n: number): string {
  return `${n} pass${n === 1 ? '' : 'es'}`;
}

/**
 * The sentence under the button — always says whether there is more.
 *
 * "Requeued 100" on its own is the ambiguous message. "Requeued 100, more
 * remain" and "Requeued 100 — that was all of them" are the two honest ones,
 * and the copy never collapses them.
 */
export function describeRun(run: RequeueRun, batch = MAX_REQUEUE_BATCH): string {
  const total = totalRequeued(run);
  const count = run.passes.length;

  switch (run.status) {
    case 'idle':
      return `Returns up to ${batch} parked rows to the queue, oldest first. If more are parked than one pass allows, you will be told and can send the next pass.`;
    case 'running':
      return count === 0
        ? 'Sending the first pass…'
        : `Sending pass ${count + 1}… ${rows(total)} returned so far.`;
    case 'more':
      return `${rows(total)} returned to the queue across ${passes(count)} — more are still parked. Send the next pass to continue.`;
    case 'drained':
      return total === 0
        ? 'Nothing was parked, so nothing was requeued. The audit log records the attempt.'
        : `${rows(total)} returned to the queue across ${passes(count)}. That was all of them — nothing in this scope is still parked.`;
    case 'failed':
      return count === 0
        ? 'The pass failed and nothing was requeued.'
        : `The last pass failed. The ${rows(total)} from the ${passes(count)} before it are already back in the queue — that work committed and is not lost.`;
  }
}

/** What the primary button should say. */
export function passButtonLabel(run: RequeueRun, batch = MAX_REQUEUE_BATCH): string {
  switch (run.status) {
    case 'idle':
      return `Requeue up to ${batch}`;
    case 'running':
      return 'Requeueing…';
    case 'more':
      return `Requeue the next ${batch}`;
    case 'drained':
      return 'Done';
    case 'failed':
      return run.passes.length === 0 ? 'Try again' : 'Retry the next pass';
  }
}
