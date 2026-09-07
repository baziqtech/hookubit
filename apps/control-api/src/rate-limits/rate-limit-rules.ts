import { AppError } from '../common/errors';
import { RATE_LIMIT_LIMITS } from './rate-limit-limits';

/** The numeric half of a rate-limit policy — everything the bucket is sized from. */
export interface RateLimitSettings {
  limit: number;
  windowSeconds: number;
  burst: number | null;
}

function invalid(field: string, message: string): AppError {
  return new AppError('invalid_request', message, { field });
}

/**
 * Validate a COMPLETE settings object (current row merged with any patch).
 *
 * Same argument as the retry policies: the DTO decorators are the fast path
 * that names a field, but a PATCH is validated against a row that may predate
 * these bounds, and `burst >= limit` is a cross-field rule a per-field
 * decorator cannot express at all. Raising `limit` above a stored `burst` with
 * one PATCH is the obvious way in.
 *
 * `rate_limit_policies` has no CHECK constraints either — a migration is
 * requested in HANDOFF.md — so this is the only thing between a typo and a
 * bucket that either never fills or divides by zero.
 */
export function assertRateLimitSettings(settings: RateLimitSettings): RateLimitSettings {
  const { limit, windowSeconds, burst } = settings;

  for (const [value, bounds, wire] of [
    [limit, RATE_LIMIT_LIMITS.limit, 'limit'],
    [windowSeconds, RATE_LIMIT_LIMITS.windowSeconds, 'window_seconds'],
  ] as const) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw invalid(wire, `${wire} must be a whole number.`);
    }
    if (value < bounds.min || value > bounds.max) {
      throw invalid(wire, `${wire} must be between ${bounds.min} and ${bounds.max}; got ${value}.`);
    }
  }

  if (burst !== null) {
    if (typeof burst !== 'number' || !Number.isInteger(burst)) {
      throw invalid('burst', 'burst must be a whole number, or null for no burst allowance.');
    }
    if (burst < RATE_LIMIT_LIMITS.burst.min || burst > RATE_LIMIT_LIMITS.burst.max) {
      throw invalid(
        'burst',
        `burst must be between ${RATE_LIMIT_LIMITS.burst.min} and ` +
          `${RATE_LIMIT_LIMITS.burst.max}; got ${burst}.`,
      );
    }
    // The cross-field rule. A bucket whose capacity is below one window's worth
    // of tokens can never issue `limit` in a window, so the configured limit is
    // unreachable and the effective rate is `burst`-shaped instead — a limit
    // that reads as one number and behaves as another.
    if (burst < limit) {
      throw invalid(
        'burst',
        `burst (${burst}) must be at least limit (${limit}): the bucket would never hold one ` +
          'window’s worth of tokens, so the configured limit could never actually be reached.',
      );
    }
  }

  return settings;
}
