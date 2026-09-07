import { AppError } from '../common/errors';
import { RETRY_POLICY_LIMITS, RetryStrategy } from './retry-policy-limits';

/**
 * The tunable half of a retry policy: everything `retry.Policy` in the data
 * plane reads. `name` and `isDefault` are not here — they are catalogue
 * metadata and have nothing to do with whether the backoff is computable.
 */
export interface RetrySettings {
  strategy: RetryStrategy;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxRetryDurationMs: number;
}

/** The schema defaults, restated so a PATCH can be merged against something. */
export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  strategy: 'exponential',
  maxAttempts: RETRY_POLICY_LIMITS.maxAttempts.default,
  initialDelayMs: RETRY_POLICY_LIMITS.initialDelayMs.default,
  maxDelayMs: RETRY_POLICY_LIMITS.maxDelayMs.default,
  multiplier: RETRY_POLICY_LIMITS.multiplier.default,
  jitterRatio: RETRY_POLICY_LIMITS.jitterRatio.default,
  maxRetryDurationMs: RETRY_POLICY_LIMITS.maxRetryDurationMs.default,
};

function invalid(field: string, message: string): AppError {
  return new AppError('invalid_request', message, { field });
}

/**
 * Per-field bounds, enforced again here rather than only at the DTO edge.
 *
 * The DTO decorators are the fast path that gives a caller a 400 with a field
 * name. This is the one that has to hold: `update` merges a partial body onto a
 * row that was written before these bounds existed (or by the CLI, or by a
 * migration), so the value being validated is not always a value the DTO ever
 * saw. Validating the MERGED settings is what makes "a stored policy is always
 * one the data plane can consume" true rather than aspirational.
 */
function assertBounds(settings: RetrySettings): void {
  const numeric: Array<[keyof RetrySettings, { min: number; max: number }, string]> = [
    ['maxAttempts', RETRY_POLICY_LIMITS.maxAttempts, 'max_attempts'],
    ['initialDelayMs', RETRY_POLICY_LIMITS.initialDelayMs, 'initial_delay_ms'],
    ['maxDelayMs', RETRY_POLICY_LIMITS.maxDelayMs, 'max_delay_ms'],
    ['multiplier', RETRY_POLICY_LIMITS.multiplier, 'multiplier'],
    ['jitterRatio', RETRY_POLICY_LIMITS.jitterRatio, 'jitter_ratio'],
    ['maxRetryDurationMs', RETRY_POLICY_LIMITS.maxRetryDurationMs, 'max_retry_duration_ms'],
  ];

  for (const [key, bounds, wire] of numeric) {
    const value = settings[key] as number;
    // NaN and ±Infinity first: `multiplier` and `jitter_ratio` are float8
    // columns, JSON can carry neither, but a CLI or a test can, and
    // `math.Pow(NaN, n)` is NaN all the way to `clampDelay`, which turns the
    // whole policy into "retry immediately, forever".
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid(wire, `${wire} must be a finite number.`);
    }
    if (value < bounds.min || value > bounds.max) {
      throw invalid(
        wire,
        `${wire} must be between ${bounds.min} and ${bounds.max}; got ${value}.`,
      );
    }
  }

  for (const [key, wire] of [
    ['maxAttempts', 'max_attempts'],
    ['initialDelayMs', 'initial_delay_ms'],
    ['maxDelayMs', 'max_delay_ms'],
    ['maxRetryDurationMs', 'max_retry_duration_ms'],
  ] as const) {
    if (!Number.isInteger(settings[key] as number)) {
      throw invalid(wire, `${wire} must be a whole number of ${wire.endsWith('ms') ? 'milliseconds' : 'attempts'}.`);
    }
  }
}

/**
 * The cross-field rules. Each one is a policy the database would accept and the
 * data plane would then either refuse to honour or honour in a way the operator
 * did not ask for.
 */
function assertCoherent(settings: RetrySettings): void {
  // 1. A first delay past the ceiling means the ceiling is the ONLY delay: the
  //    clamp fires on the very first retry, `multiplier` never applies, and the
  //    policy the operator wrote is not the policy that runs.
  if (settings.initialDelayMs > settings.maxDelayMs) {
    throw invalid(
      'initial_delay_ms',
      `initial_delay_ms (${settings.initialDelayMs}) must not exceed max_delay_ms ` +
        `(${settings.maxDelayMs}); every retry would be clamped to the ceiling, so the ` +
        'strategy and multiplier would have no effect.',
    );
  }

  // 2. A retry budget shorter than the first retry delay expires before the
  //    first retry is ever attempted. `Policy.Exhausted` compares wall-clock age
  //    against MaxRetryDuration, so `max_attempts` becomes a number that never
  //    happens and the delivery gives up after attempt 1 — indistinguishable,
  //    in the ledger, from an endpoint that permanently rejected the payload.
  if (settings.maxAttempts > 1 && settings.maxRetryDurationMs < settings.initialDelayMs) {
    throw invalid(
      'max_retry_duration_ms',
      `max_retry_duration_ms (${settings.maxRetryDurationMs}) is shorter than ` +
        `initial_delay_ms (${settings.initialDelayMs}), so the retry budget expires before ` +
        `the first retry is due and max_attempts (${settings.maxAttempts}) can never be ` +
        'reached. Raise the budget or lower the first delay.',
    );
  }

  // 3. THE ONE THAT IS NOT OBVIOUS FROM THE SCHEMA.
  //
  //    `retry.Delay`, exponential branch:
  //
  //        mult := p.Multiplier
  //        if mult <= 1 { mult = 2 }
  //
  //    A multiplier of exactly 1 is silently REPLACED with 2 by the delivery
  //    workers. The row says "flat 5s forever"; the endpoint receives
  //    5s, 10s, 20s, 40s. Storing that is storing a policy that does not
  //    describe what happens, and no amount of reading the retry_policies table
  //    afterwards explains the delivery log. An operator who wants a flat delay
  //    has a strategy for it.
  if (settings.strategy === 'exponential' && settings.multiplier <= 1) {
    throw invalid(
      'multiplier',
      'multiplier must be greater than 1 for the exponential strategy: the delivery workers ' +
        'substitute 2 for any multiplier <= 1, so this policy would not behave the way it ' +
        "reads. Use strategy \"constant\" for a flat delay, or \"linear\" for a fixed step.",
    );
  }
}

/**
 * Validate a complete settings object and hand it back.
 *
 * Callers pass MERGED settings (current row + patch) so that a partial update
 * cannot walk a stored policy into an incoherent combination one field at a
 * time — `max_delay_ms` lowered under a stored `initial_delay_ms` is the
 * obvious one, and it is a single PATCH away.
 */
export function assertRetrySettings(settings: RetrySettings): RetrySettings {
  assertBounds(settings);
  assertCoherent(settings);
  return settings;
}

/**
 * The delay the data plane will actually compute for a given attempt, jitter
 * excluded — a faithful port of `retry.Policy.Delay`'s pre-jitter arithmetic.
 *
 * This exists so the tests can assert the property that matters ("no accepted
 * policy produces a non-positive or non-finite delay for any attempt inside its
 * own budget") against the same arithmetic the Go side runs, rather than
 * against a restatement of the bounds that would pass by construction.
 */
export function delayMsForAttempt(settings: RetrySettings, attempt: number): number {
  if (attempt <= 1) return 0;
  const n = attempt - 2;
  let d: number;
  switch (settings.strategy) {
    case 'constant':
      d = settings.initialDelayMs;
      break;
    case 'linear':
      d = settings.initialDelayMs * (n + 1);
      break;
    default: {
      // The substitution the Go side makes; mirrored so the port stays honest
      // even though `assertCoherent` refuses the input that triggers it.
      const mult = settings.multiplier <= 1 ? 2 : settings.multiplier;
      d = settings.initialDelayMs * Math.pow(mult, n);
      break;
    }
  }
  if (Number.isNaN(d) || d < 0) d = 0;
  return Math.min(d, settings.maxDelayMs);
}
