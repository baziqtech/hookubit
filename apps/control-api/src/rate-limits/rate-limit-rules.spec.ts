import { AppError } from '../common/errors';
import { RATE_LIMIT_LIMITS } from './rate-limit-limits';
import { RateLimitSettings, assertRateLimitSettings } from './rate-limit-rules';

const GOOD: RateLimitSettings = { limit: 100, windowSeconds: 60, burst: null };

function rejection(patch: Partial<RateLimitSettings>): AppError {
  try {
    assertRateLimitSettings({ ...GOOD, ...patch });
  } catch (err) {
    return err as AppError;
  }
  throw new Error(`expected ${JSON.stringify(patch)} to be refused, but it was accepted`);
}

describe('rate-limit bounds', () => {
  it('accepts a sensible policy, with and without a burst', () => {
    expect(() => assertRateLimitSettings(GOOD)).not.toThrow();
    expect(() => assertRateLimitSettings({ ...GOOD, burst: 100 })).not.toThrow();
    expect(() => assertRateLimitSettings({ ...GOOD, burst: 1_000 })).not.toThrow();
  });

  /**
   * `limit = 0` is not "a very small limit". It disables delivery or ingestion
   * entirely for whatever the policy covers — a customer-visible outage
   * configured through a normal-looking write.
   */
  it.each([
    ['limit', { limit: 0 }],
    ['limit', { limit: -1 }],
    ['limit', { limit: RATE_LIMIT_LIMITS.limit.max + 1 }],
    ['limit', { limit: 1.5 }],
    ['window_seconds', { windowSeconds: 0 }],
    ['window_seconds', { windowSeconds: -60 }],
    ['window_seconds', { windowSeconds: RATE_LIMIT_LIMITS.windowSeconds.max + 1 }],
    ['burst', { burst: 0 }],
    ['burst', { burst: -1 }],
    ['burst', { burst: 2.5 }],
  ])('refuses %s: %j', (field, patch) => {
    const error = rejection(patch as Partial<RateLimitSettings>);
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field });
    expect(error.message).toContain(field);
  });

  it('refuses a burst below the limit and explains why it would be unreachable', () => {
    const error = rejection({ limit: 100, burst: 99 });
    expect(error.details).toMatchObject({ field: 'burst' });
    expect(error.message).toContain('at least limit');
  });

  it('accepts a burst exactly equal to the limit', () => {
    expect(() => assertRateLimitSettings({ ...GOOD, limit: 100, burst: 100 })).not.toThrow();
  });

  it('keeps every ceiling inside int4', () => {
    for (const bounds of Object.values(RATE_LIMIT_LIMITS)) {
      expect(bounds.max).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  /**
   * The refill rate downstream is `limit / window_seconds`. Every accepted
   * policy must produce a finite, positive one — a zero window is the division
   * by zero this floor exists to prevent.
   */
  it('every accepted policy yields a finite positive refill rate', () => {
    for (const limit of [1, 10, 1_000, RATE_LIMIT_LIMITS.limit.max]) {
      for (const windowSeconds of [1, 60, RATE_LIMIT_LIMITS.windowSeconds.max]) {
        const settings = assertRateLimitSettings({ limit, windowSeconds, burst: null });
        const rate = settings.limit / settings.windowSeconds;
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThan(0);
      }
    }
  });
});
