/**
 * Telling "slow down" apart from "you have hit a limit".
 *
 * Every write route on the control API now carries a `@Throttle`, and creates
 * can additionally fail on a RESOURCE CEILING — organizations per user,
 * projects per organization, endpoints and API keys per project. These are
 * different problems with different remedies and they must not share a message:
 *
 *   - A 429 `rate_limited` is transient. Waiting fixes it. The guard sets a
 *     `Retry-After` header and puts `retry_after_seconds` in `error.details`.
 *   - A ceiling is permanent until the user deletes something or an operator
 *     raises the configured maximum. Waiting does nothing.
 *
 * The awkward part, and the reason this file is a heuristic rather than a
 * switch: THE CONTROL API HAS NO DISTINCT CODE FOR A CEILING. It throws
 * `AppError('conflict', …)`, so a ceiling is a 409 that is indistinguishable
 * on `code` alone from "that slug is already taken". Two of the four ceilings
 * (projects, API keys) attach `details: { limit, current }`; the other two
 * (endpoints, organizations) attach nothing but prose. So:
 *
 *   1. `details.limit` present on a 409  → ceiling, with numbers. Exact.
 *   2. otherwise a 409 whose message matches the ceiling wording → ceiling,
 *      without numbers. Inexact, and tracked in HANDOFF.md as a backend ask.
 *   3. anything else 409 → an ordinary conflict, e.g. a duplicate slug.
 *
 * When the API grows a `limit_exceeded` code, delete rule 2 and match on it.
 */
import { ApiRequestError } from './api';

export type WriteFailure =
  | { kind: 'throttled'; retryAfterSeconds: number | null; message: string }
  | { kind: 'ceiling'; limit: number | null; current: number | null; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'other'; message: string };

/**
 * Wording the control API uses for its four ceilings, all of which are 409s:
 *
 *   projects       "…already has N projects, which is its limit of M."
 *   api keys       "…already holds N un-revoked API keys, which is its limit of M."
 *   endpoints      "…already has 500 endpoints, which is the maximum."
 *   organizations  "You already own N organizations, which is the limit."
 *
 * Matching prose is fragile by construction — it breaks if someone rewords a
 * message, and it is why rule 1 is preferred and why the backend is being asked
 * for a real code.
 */
const CEILING_PROSE = /which is (its limit|the limit|the maximum)/i;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function classifyWriteError(error: unknown): WriteFailure {
  if (!(error instanceof ApiRequestError)) {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    return { kind: 'other', message };
  }

  const { code, message, details } = error.body;

  // A 429 is always transient, whatever else is going on.
  if (error.status === 429 || code === 'rate_limited') {
    return {
      kind: 'throttled',
      retryAfterSeconds: numberOrNull(details?.retry_after_seconds),
      message,
    };
  }

  if (error.status === 409 || code === 'conflict') {
    const limit = numberOrNull(details?.limit);
    const current = numberOrNull(details?.current);
    if (limit !== null || CEILING_PROSE.test(message)) {
      return { kind: 'ceiling', limit, current, message };
    }
    return { kind: 'conflict', message };
  }

  if (code === 'forbidden' || error.status === 403) return { kind: 'forbidden', message };
  if (code === 'invalid_request' || error.status === 400) return { kind: 'invalid', message };
  return { kind: 'other', message };
}

/** Short, actionable headline per failure kind. The remedy differs; so does the copy. */
export function writeFailureTitle(failure: WriteFailure): string {
  switch (failure.kind) {
    case 'throttled':
      return 'Too many requests — slow down';
    case 'ceiling':
      return 'You have reached a limit';
    case 'conflict':
      return 'That conflicts with something that already exists';
    case 'forbidden':
      return 'You do not have permission to do this';
    case 'invalid':
      return 'Check the details and try again';
    default:
      return 'Request failed';
  }
}

/**
 * What the user should DO. A throttle resolves itself; a ceiling never does,
 * so its copy must not say "try again".
 */
export function writeFailureRemedy(failure: WriteFailure): string {
  switch (failure.kind) {
    case 'throttled': {
      const seconds = failure.retryAfterSeconds;
      if (seconds === null) return 'Wait a moment, then try again. Nothing was created.';
      const unit = seconds === 1 ? 'second' : 'seconds';
      return `Wait about ${seconds} ${unit}, then try again. Nothing was created.`;
    }
    case 'ceiling': {
      const counts =
        failure.limit !== null && failure.current !== null
          ? ` You are at ${failure.current} of ${failure.limit}.`
          : '';
      return (
        `Waiting will not help — this limit does not reset.${counts} ` +
        'Delete something you no longer need, or ask an operator to raise the limit.'
      );
    }
    default:
      return failure.message;
  }
}
