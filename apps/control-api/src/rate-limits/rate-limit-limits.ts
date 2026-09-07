import { RateLimitScope } from '@prisma/client';

/**
 * Bounds on a rate-limit policy.
 *
 * Every one of these is a number that ends up in a token bucket in the data
 * plane, so the failure modes are arithmetic rather than aesthetic:
 *
 * - `limit <= 0` is not "a very small limit". Zero disables delivery or
 *   ingestion entirely for whatever the policy covers — a customer-visible
 *   outage configured through a normal-looking write — and a negative one is
 *   the same thing with a sign bit. Floored at 1.
 * - `window_seconds <= 0` is a division by zero in whatever computes the refill
 *   rate (`limit / window`). Floored at 1 and capped at a day: a window longer
 *   than that stops being a rate limit and becomes a quota, which is what
 *   `usage_records` is for.
 * - `burst < limit` means the bucket cannot hold one window's worth of tokens,
 *   so the endpoint can never actually reach the limit the operator configured.
 *   The stated limit becomes a lie in the safe direction, which is still a lie —
 *   and it is the shape a "burst is a small extra allowance" misreading
 *   produces. Refused; see `assertRateLimitSettings`.
 *
 * `limit` and `burst` share a ceiling because both are `integer` columns and
 * both are counts of the same thing; ten million per window is far past any
 * real ingest rate and comfortably inside int4.
 */
export const RATE_LIMIT_LIMITS = {
  limit: { min: 1, max: 10_000_000 },
  windowSeconds: { min: 1, max: 86_400, default: 1 },
  burst: { min: 1, max: 10_000_000 },
} as const;

/** The four `rate_limit_policies.scope` values, from the Prisma enum. */
export const RATE_LIMIT_SCOPES = [
  'organization',
  'project',
  'endpoint',
  'ingest',
] as const satisfies readonly RateLimitScope[];

/**
 * How many rate-limit policies one project may hold.
 *
 * The unique index already bounds the meaningful combinations for the singular
 * scopes (one org row, one project row, one ingest-wide row), so this really
 * bounds per-endpoint and per-key rows. It sits above
 * `MAX_ENDPOINTS_PER_PROJECT / 2` deliberately: a project that genuinely gives
 * a hundred endpoints their own budget should not hit a ceiling designed for a
 * runaway loop, and the throttle on the write routes is what bounds the rate.
 */
export const MAX_RATE_LIMIT_POLICIES_PER_PROJECT = 300;

/** Per-address write budget. Compile-time: `@Throttle` is decorator metadata. */
export const RATE_LIMIT_WRITE_THROTTLE = {
  name: 'rate-limits.write',
  limit: 60,
  windowMs: 5 * 60_000,
} as const;
