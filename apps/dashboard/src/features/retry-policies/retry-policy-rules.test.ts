import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_SETTINGS,
  delayMsForAttempt,
  formatBudget,
  retryPolicyCoherenceIssues,
  retrySchedule,
  type RetrySettings,
} from './retry-policy-rules';

const settings = (over: Partial<RetrySettings> = {}): RetrySettings => ({
  ...DEFAULT_RETRY_SETTINGS,
  ...over,
});

/**
 * These are the three cross-field rules in control-api
 * `retry-policy-rules.ts` `assertCoherent`, mirrored so the form can name the
 * field before the round trip. Each test is one rule; the field named is the
 * one the server names, because the form places the reason under that input.
 */
describe('retryPolicyCoherenceIssues', () => {
  it('accepts the server defaults', () => {
    expect(retryPolicyCoherenceIssues(settings())).toEqual([]);
  });

  it('refuses initial_delay_ms above max_delay_ms, naming initial_delay_ms', () => {
    const issues = retryPolicyCoherenceIssues(
      settings({ initial_delay_ms: 10_000, max_delay_ms: 5_000 }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('initial_delay_ms');
    expect(issues[0].reason).toContain('must not exceed max_delay_ms');
  });

  it('refuses a retry budget shorter than the first delay, naming max_retry_duration_ms', () => {
    const issues = retryPolicyCoherenceIssues(
      settings({ initial_delay_ms: 5_000, max_delay_ms: 5_000, max_retry_duration_ms: 1_000 }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('max_retry_duration_ms');
    expect(issues[0].reason).toContain('can never be reached');
  });

  it('allows a short budget when there is only one attempt — nothing would ever retry', () => {
    expect(
      retryPolicyCoherenceIssues(
        settings({ max_attempts: 1, initial_delay_ms: 5_000, max_retry_duration_ms: 1_000 }),
      ),
    ).toEqual([]);
  });

  it('refuses multiplier <= 1 for exponential, because the workers substitute 2', () => {
    const issues = retryPolicyCoherenceIssues(settings({ multiplier: 1 }));
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('multiplier');
    expect(issues[0].reason).toContain('substitute 2');
  });

  it('allows multiplier 1 for constant and linear — it is not read there', () => {
    expect(retryPolicyCoherenceIssues(settings({ strategy: 'constant', multiplier: 1 }))).toEqual(
      [],
    );
    expect(retryPolicyCoherenceIssues(settings({ strategy: 'linear', multiplier: 1 }))).toEqual(
      [],
    );
  });

  it('reports every broken rule, in the order the server checks them', () => {
    const issues = retryPolicyCoherenceIssues(
      settings({
        initial_delay_ms: 10_000,
        max_delay_ms: 5_000,
        max_retry_duration_ms: 1_000,
        multiplier: 1,
      }),
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      'initial_delay_ms',
      'max_retry_duration_ms',
      'multiplier',
    ]);
  });
});

/**
 * A faithful port of `retry.Policy.Delay` — the preview in the dialog is only
 * worth showing if it is the arithmetic the workers actually run.
 */
describe('delayMsForAttempt', () => {
  it('has no delay before the first attempt', () => {
    expect(delayMsForAttempt(settings(), 1)).toBe(0);
  });

  it('doubles from the initial delay for exponential and clamps at the ceiling', () => {
    const s = settings({ initial_delay_ms: 5_000, max_delay_ms: 30_000, multiplier: 2 });
    expect([2, 3, 4, 5, 6].map((attempt) => delayMsForAttempt(s, attempt))).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000,
    ]);
  });

  it('adds the initial delay each time for linear', () => {
    const s = settings({ strategy: 'linear', initial_delay_ms: 1_000, max_delay_ms: 60_000 });
    expect([2, 3, 4].map((attempt) => delayMsForAttempt(s, attempt))).toEqual([
      1_000, 2_000, 3_000,
    ]);
  });

  it('repeats the initial delay for constant', () => {
    const s = settings({ strategy: 'constant', initial_delay_ms: 30_000, max_delay_ms: 30_000 });
    expect([2, 3, 9].map((attempt) => delayMsForAttempt(s, attempt))).toEqual([
      30_000, 30_000, 30_000,
    ]);
  });

  it('mirrors the substitution the workers make for an exponential multiplier of 1', () => {
    // Refused by the coherence rule, but the preview must still say what
    // WOULD happen if such a row existed — doubling, not a flat delay.
    const s = settings({ initial_delay_ms: 1_000, max_delay_ms: 60_000, multiplier: 1 });
    expect(delayMsForAttempt(s, 3)).toBe(2_000);
  });
});

describe('retrySchedule', () => {
  it('lists one delay per retry and says when the budget runs out first', () => {
    const schedule = retrySchedule(
      settings({
        strategy: 'constant',
        max_attempts: 5,
        initial_delay_ms: 10_000,
        max_delay_ms: 10_000,
        max_retry_duration_ms: 25_000,
      }),
    );
    expect(schedule.delays).toEqual([10_000, 10_000, 10_000, 10_000]);
    // 10s + 10s = 20s fits; the third retry would land at 30s, past 25s.
    expect(schedule.exhaustedAt).toBe(4);
    expect(schedule.truncated).toBe(false);
  });

  it('marks truncation rather than listing fifty delays', () => {
    const schedule = retrySchedule(settings({ max_attempts: 50 }), 8);
    expect(schedule.delays).toHaveLength(8);
    expect(schedule.truncated).toBe(true);
  });
});

describe('formatBudget', () => {
  it('uses the largest unit that divides cleanly', () => {
    expect(formatBudget(86_400_000)).toBe('1d');
    expect(formatBudget(604_800_000)).toBe('7d');
    expect(formatBudget(3_600_000)).toBe('1h');
    expect(formatBudget(300_000)).toBe('5m');
    expect(formatBudget(1_500)).toBe('1500ms');
  });
});
