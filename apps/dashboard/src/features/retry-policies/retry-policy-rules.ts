import { RETRY_POLICY_LIMITS, type RetryPolicy, type RetryStrategy } from '../../types/api';

/**
 * The cross-field rules a retry policy has to satisfy, as pure data.
 *
 * These mirror `assertCoherent` in control-api
 * `src/retry-policies/retry-policy-rules.ts` — same three rules, same order,
 * same sentences — so the form can put the reason under the field BEFORE the
 * round trip, and so the mock refuses exactly what the API refuses. The
 * server stays the authority: a stale mirror here costs one 400, never a
 * stored policy the data plane cannot consume.
 *
 * Each rule is a combination the database would accept and the delivery
 * workers would then either refuse to honour or honour in a way the operator
 * did not ask for. That is what makes them worth showing at edit time rather
 * than discovering in the delivery log.
 */
export interface RetrySettings {
  strategy: RetryStrategy;
  max_attempts: number;
  initial_delay_ms: number;
  max_delay_ms: number;
  multiplier: number;
  jitter_ratio: number;
  max_retry_duration_ms: number;
}

export type RetrySettingsField = keyof RetrySettings;

export interface CoherenceIssue {
  field: RetrySettingsField;
  reason: string;
}

/** The server's defaults, restated so a create form can start somewhere honest. */
export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  strategy: 'exponential',
  max_attempts: RETRY_POLICY_LIMITS.max_attempts.default,
  initial_delay_ms: RETRY_POLICY_LIMITS.initial_delay_ms.default,
  max_delay_ms: RETRY_POLICY_LIMITS.max_delay_ms.default,
  multiplier: RETRY_POLICY_LIMITS.multiplier.default,
  jitter_ratio: RETRY_POLICY_LIMITS.jitter_ratio.default,
  max_retry_duration_ms: RETRY_POLICY_LIMITS.max_retry_duration_ms.default,
};

/**
 * Every cross-field rule the settings break, in the order the server checks
 * them. Empty means coherent. Bounds are NOT checked here — the form does that
 * per field with `min`/`max`, and the mock does it in `writes.ts` — this is
 * only the part a single input cannot know about.
 */
export function retryPolicyCoherenceIssues(settings: RetrySettings): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  // 1. A first delay past the ceiling means the ceiling is the ONLY delay: the
  //    clamp fires on the very first retry and the strategy never applies.
  if (settings.initial_delay_ms > settings.max_delay_ms) {
    issues.push({
      field: 'initial_delay_ms',
      reason:
        `initial_delay_ms (${settings.initial_delay_ms}) must not exceed max_delay_ms ` +
        `(${settings.max_delay_ms}); every retry would be clamped to the ceiling, so the ` +
        'strategy and multiplier would have no effect.',
    });
  }

  // 2. A retry budget shorter than the first retry delay expires before the
  //    first retry is ever attempted — the delivery gives up after attempt 1,
  //    indistinguishable in the ledger from a permanent rejection.
  if (settings.max_attempts > 1 && settings.max_retry_duration_ms < settings.initial_delay_ms) {
    issues.push({
      field: 'max_retry_duration_ms',
      reason:
        `max_retry_duration_ms (${settings.max_retry_duration_ms}) is shorter than ` +
        `initial_delay_ms (${settings.initial_delay_ms}), so the retry budget expires before ` +
        `the first retry is due and max_attempts (${settings.max_attempts}) can never be ` +
        'reached. Raise the budget or lower the first delay.',
    });
  }

  // 3. The one that is not obvious from the schema: the delivery workers
  //    replace any exponential multiplier <= 1 with 2, so a stored 1 is a
  //    policy that does not describe what happens.
  if (settings.strategy === 'exponential' && settings.multiplier <= 1) {
    issues.push({
      field: 'multiplier',
      reason:
        'multiplier must be greater than 1 for the exponential strategy: the delivery workers ' +
        'substitute 2 for any multiplier <= 1, so this policy would not behave the way it ' +
        'reads. Use strategy "constant" for a flat delay, or "linear" for a fixed step.',
    });
  }

  return issues;
}

/**
 * The delay the data plane computes before `attempt`, jitter excluded — a port
 * of `retry.Policy.Delay`'s pre-jitter arithmetic, the same one the control
 * API's tests assert against. Attempt 1 is the first delivery and has no delay.
 *
 * The substitution the Go side makes for a multiplier <= 1 is mirrored so the
 * preview stays honest even for the input `retryPolicyCoherenceIssues` refuses.
 */
export function delayMsForAttempt(settings: RetrySettings, attempt: number): number {
  if (attempt <= 1) return 0;
  const n = attempt - 2;
  let delay: number;
  switch (settings.strategy) {
    case 'constant':
      delay = settings.initial_delay_ms;
      break;
    case 'linear':
      delay = settings.initial_delay_ms * (n + 1);
      break;
    default: {
      const multiplier = settings.multiplier <= 1 ? 2 : settings.multiplier;
      delay = settings.initial_delay_ms * Math.pow(multiplier, n);
      break;
    }
  }
  if (Number.isNaN(delay) || delay < 0) delay = 0;
  return Math.min(delay, settings.max_delay_ms);
}

/**
 * The retry schedule as the operator will experience it: the wait before each
 * retry, and whether the wall-clock budget runs out first.
 *
 * `exhaustedAt` is the attempt number the budget stops before, or null when
 * every attempt fits. This is the fact a "12 attempts over a week" policy
 * exists to state, and it is only knowable by adding the delays up.
 */
export function retrySchedule(
  settings: RetrySettings,
  maxShown = 8,
): { delays: number[]; truncated: boolean; exhaustedAt: number | null } {
  const delays: number[] = [];
  let elapsed = 0;
  let exhaustedAt: number | null = null;
  for (let attempt = 2; attempt <= settings.max_attempts; attempt += 1) {
    const delay = delayMsForAttempt(settings, attempt);
    elapsed += delay;
    if (exhaustedAt === null && elapsed > settings.max_retry_duration_ms) exhaustedAt = attempt;
    if (delays.length < maxShown) delays.push(delay);
  }
  return {
    delays,
    truncated: settings.max_attempts - 1 > maxShown,
    exhaustedAt,
  };
}

/** The tunable half of a stored row, for seeding the edit form. */
export function settingsOf(policy: RetryPolicy): RetrySettings {
  return {
    strategy: policy.strategy,
    max_attempts: policy.max_attempts,
    initial_delay_ms: policy.initial_delay_ms,
    max_delay_ms: policy.max_delay_ms,
    multiplier: policy.multiplier,
    jitter_ratio: policy.jitter_ratio,
    max_retry_duration_ms: policy.max_retry_duration_ms,
  };
}

/**
 * "24h budget" — the wall-clock column for the table. Shown in the largest
 * unit that divides cleanly, because an operator reading "86400000" has to do
 * arithmetic to learn whether a dead endpoint is retried into tomorrow.
 */
export function formatBudget(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
