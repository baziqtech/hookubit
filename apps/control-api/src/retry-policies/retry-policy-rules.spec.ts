import { AppError } from '../common/errors';
import { RETRY_POLICY_LIMITS, RETRY_STRATEGIES, RetryStrategy } from './retry-policy-limits';
import {
  DEFAULT_RETRY_SETTINGS,
  RetrySettings,
  assertRetrySettings,
  delayMsForAttempt,
} from './retry-policy-rules';

const GOOD: RetrySettings = { ...DEFAULT_RETRY_SETTINGS };

function withSettings(patch: Partial<RetrySettings>): RetrySettings {
  return { ...GOOD, ...patch };
}

function rejection(patch: Partial<RetrySettings>): AppError {
  try {
    assertRetrySettings(withSettings(patch));
  } catch (err) {
    return err as AppError;
  }
  throw new Error(`expected ${JSON.stringify(patch)} to be refused, but it was accepted`);
}

describe('per-field bounds', () => {
  it('accepts the schema defaults', () => {
    expect(() => assertRetrySettings(GOOD)).not.toThrow();
  });

  it.each([
    ['max_delay_ms', { maxDelayMs: 0 }],
    ['max_delay_ms', { maxDelayMs: -1 }],
    ['initial_delay_ms', { initialDelayMs: 0 }],
    ['initial_delay_ms', { initialDelayMs: -5 }],
    ['max_attempts', { maxAttempts: 0 }],
    ['max_attempts', { maxAttempts: -3 }],
    ['max_attempts', { maxAttempts: RETRY_POLICY_LIMITS.maxAttempts.max + 1 }],
    ['max_retry_duration_ms', { maxRetryDurationMs: 0 }],
    ['max_retry_duration_ms', { maxRetryDurationMs: -1 }],
    ['multiplier', { multiplier: 0 }],
    ['multiplier', { multiplier: 0.5 }],
    ['multiplier', { multiplier: -2 }],
    ['jitter_ratio', { jitterRatio: -0.1 }],
    ['jitter_ratio', { jitterRatio: 1.5 }],
  ])('refuses %s with a message naming the field: %j', (field, patch) => {
    const error = rejection(patch as Partial<RetrySettings>);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain(field);
    expect(error.details).toMatchObject({ field });
  });

  it.each([
    ['multiplier', { multiplier: Number.NaN }],
    ['multiplier', { multiplier: Number.POSITIVE_INFINITY }],
    ['jitter_ratio', { jitterRatio: Number.NaN }],
  ])('refuses a non-finite %s', (field, patch) => {
    const error = rejection(patch as Partial<RetrySettings>);
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field });
  });

  it('refuses a fractional millisecond count', () => {
    expect(rejection({ initialDelayMs: 1500.5 }).message).toContain('whole number');
  });

  it('accepts the extremes of every range', () => {
    expect(() =>
      assertRetrySettings({
        strategy: 'constant',
        maxAttempts: RETRY_POLICY_LIMITS.maxAttempts.min,
        initialDelayMs: RETRY_POLICY_LIMITS.initialDelayMs.min,
        maxDelayMs: RETRY_POLICY_LIMITS.maxDelayMs.max,
        multiplier: RETRY_POLICY_LIMITS.multiplier.min,
        jitterRatio: RETRY_POLICY_LIMITS.jitterRatio.min,
        maxRetryDurationMs: RETRY_POLICY_LIMITS.maxRetryDurationMs.max,
      }),
    ).not.toThrow();
    expect(() =>
      assertRetrySettings({
        strategy: 'exponential',
        maxAttempts: RETRY_POLICY_LIMITS.maxAttempts.max,
        initialDelayMs: 1,
        maxDelayMs: RETRY_POLICY_LIMITS.maxDelayMs.max,
        multiplier: RETRY_POLICY_LIMITS.multiplier.max,
        jitterRatio: RETRY_POLICY_LIMITS.jitterRatio.max,
        maxRetryDurationMs: RETRY_POLICY_LIMITS.maxRetryDurationMs.max,
      }),
    ).not.toThrow();
  });

  /**
   * `max_retry_duration_ms` is a PostgreSQL `integer`. A "30 day" budget is
   * 2_592_000_000, past int4's 2_147_483_647, so it is not a long retry window —
   * it is an insert that fails or wraps depending on the driver.
   */
  it('keeps every ceiling inside int4', () => {
    for (const bounds of Object.values(RETRY_POLICY_LIMITS)) {
      expect(bounds.max).toBeLessThanOrEqual(2_147_483_647);
    }
  });
});

describe('cross-field coherence', () => {
  it('refuses an initial delay above the ceiling', () => {
    const error = rejection({ initialDelayMs: 60_000, maxDelayMs: 30_000 });
    expect(error.message).toContain('must not exceed max_delay_ms');
    expect(error.message).toContain('would have no effect');
  });

  it('accepts an initial delay exactly at the ceiling', () => {
    expect(() =>
      assertRetrySettings(withSettings({ initialDelayMs: 30_000, maxDelayMs: 30_000 })),
    ).not.toThrow();
  });

  it('refuses a retry budget that expires before the first retry is due', () => {
    const error = rejection({ initialDelayMs: 600_000, maxRetryDurationMs: 60_000 });
    expect(error.details).toMatchObject({ field: 'max_retry_duration_ms' });
    expect(error.message).toContain('can never be');
  });

  it('allows a short budget when there are no retries to schedule', () => {
    expect(() =>
      assertRetrySettings(
        withSettings({ maxAttempts: 1, initialDelayMs: 600_000, maxRetryDurationMs: 1_000 }),
      ),
    ).not.toThrow();
  });

  /**
   * The one that is invisible from the schema. `retry.Delay`:
   *
   *     mult := p.Multiplier
   *     if mult <= 1 { mult = 2 }
   *
   * A stored multiplier of 1 with the exponential strategy is silently replaced
   * with 2 by the delivery workers, so the row does not describe what happens.
   */
  it('refuses multiplier 1 with the exponential strategy, because the workers substitute 2', () => {
    const error = rejection({ strategy: 'exponential', multiplier: 1 });
    expect(error.details).toMatchObject({ field: 'multiplier' });
    expect(error.message).toContain('substitute 2');
    // And the substitution really is what would happen.
    expect(delayMsForAttempt(withSettings({ multiplier: 1 }), 3)).toBe(
      delayMsForAttempt(withSettings({ multiplier: 2 }), 3),
    );
  });

  it.each(['linear', 'constant'] as const)(
    'allows multiplier 1 for %s, which never reads it',
    (strategy) => {
      expect(() => assertRetrySettings(withSettings({ strategy, multiplier: 1 }))).not.toThrow();
    },
  );
});

/**
 * The property that actually matters, asserted against a port of the data
 * plane's own arithmetic rather than against a restatement of the bounds (which
 * would pass by construction).
 */
describe('every accepted policy produces a delay the data plane can schedule', () => {
  const accepted: RetrySettings[] = [];
  for (const strategy of RETRY_STRATEGIES) {
    for (const multiplier of [1, 1.5, 2, 10, 100]) {
      for (const initialDelayMs of [1, 250, 5_000, 3_600_000]) {
        for (const maxDelayMs of [1, 1_000, 3_600_000, 86_400_000]) {
          const candidate: RetrySettings = {
            strategy: strategy as RetryStrategy,
            maxAttempts: 50,
            initialDelayMs,
            maxDelayMs,
            multiplier,
            jitterRatio: 1,
            maxRetryDurationMs: RETRY_POLICY_LIMITS.maxRetryDurationMs.max,
          };
          try {
            accepted.push(assertRetrySettings(candidate));
          } catch {
            // Refused policies are the subject of the suites above.
          }
        }
      }
    }
  }

  it('covers a real spread of accepted policies', () => {
    expect(accepted.length).toBeGreaterThan(30);
  });

  it('never yields a negative, NaN or unbounded delay at any attempt in the budget', () => {
    for (const settings of accepted) {
      for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
        const delay = delayMsForAttempt(settings, attempt);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(settings.maxDelayMs);
        if (attempt > 1) expect(delay).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The defect this validation exists for, made concrete.
   *
   * `retry.Delay` converts the computed float to an int64 NANOSECOND
   * `time.Duration`. With the max-delay clamp gated on `MaxDelay > 0` — which is
   * how it shipped — a policy stored with `max_delay_ms = 0` let `math.Pow` run
   * away: at attempt 40 with a 5s base and multiplier 2 the value is past
   * int64's ceiling, `time.Duration(d)` becomes `math.MinInt64`, and
   * `next_attempt_at` lands permanently in the PAST. The 250ms poll loop then
   * hammers a dead endpoint forever.
   *
   * Two assertions: the unclamped arithmetic really does overflow, and the
   * control plane refuses to store the policy that reaches it.
   */
  it('refuses the max_delay_ms = 0 policy that overflowed int64 nanoseconds downstream', () => {
    const runaway = { initialDelayMs: 5_000, multiplier: 2 };
    const unclampedNanosAtAttempt40 = runaway.initialDelayMs * 1e6 * Math.pow(runaway.multiplier, 38);
    // 2**63 rather than the literal 9_223_372_036_854_775_807: that value is
    // not representable as a float64 and the linter is right to refuse it.
    // 2**63 is exact, and is one above int64's ceiling.
    expect(unclampedNanosAtAttempt40).toBeGreaterThan(2 ** 63);

    const error = rejection({ ...runaway, maxDelayMs: 0 });
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'max_delay_ms' });
  });
});
