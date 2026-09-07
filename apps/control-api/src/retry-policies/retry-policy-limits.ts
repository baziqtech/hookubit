/**
 * Bounds on every retry-policy field, derived from what the Go data plane can
 * actually consume — `services/data-plane/internal/retry/retry.go`.
 *
 * This is not cosmetic validation. `retry.Policy.Delay` is a float computation
 * that is converted to an `int64` nanosecond `time.Duration`, and it shipped
 * with a real defect: the max-delay clamp was gated on `MaxDelay > 0`, so a
 * policy stored with `max_delay_ms = 0` let `math.Pow(multiplier, n)` run away.
 * At attempt 40 with a 5s base and multiplier 2 the float is ~1.5e19, which
 * overflows int64, and `time.Duration(d)` becomes `math.MinInt64` — a LARGE
 * NEGATIVE duration. `next_attempt_at` then lands permanently in the past and
 * the 250ms poll loop hammers a dead endpoint forever: precisely the stampede
 * backoff exists to prevent.
 *
 * The Go side now clamps unconditionally (`clampDelay`, which also maps NaN and
 * ±Inf into range), so that specific overflow is closed at the far end. But:
 *
 *  - `retry_policies` has NO check constraints (see HANDOFF.md — a migration is
 *    requested), so the database will happily store `max_delay_ms = 0`,
 *    `multiplier = 0`, `jitter_ratio = 12` or `max_attempts = -1`;
 *  - a defensive clamp downstream means the delivered behaviour stops matching
 *    the policy the customer configured, silently. The control plane is where a
 *    nonsensical policy should be REFUSED, with a message, at save time.
 *
 * So every bound below is stated as "the data plane can consume this sanely",
 * not "this number felt right".
 *
 * ## Why the ceilings are where they are
 *
 * - `maxRetryDurationMs` is capped at **7 days** rather than something larger
 *   because the column is PostgreSQL `integer` (`Int` in schema.prisma), and
 *   int4 tops out at 2_147_483_647 — about 24.8 days. A "30 day" policy is not
 *   a long retry budget, it is an insert that fails or silently wraps depending
 *   on the driver. Seven days leaves an order of magnitude of headroom under
 *   the column's real limit.
 * - `initialDelayMs` and `maxDelayMs` are capped at one day for the same
 *   reason, with room to spare, and floored at 1ms: `retry.Delay` returns the
 *   computed delay unconditionally, so a 0ms initial delay is an immediate
 *   re-attempt on every retry — a tight loop against an endpoint that is
 *   already failing.
 * - `maxAttempts` is floored at 1 (attempt 1 is the first delivery; 0 would
 *   mean "never deliver") and capped at 50. `Exhausted` treats
 *   `MaxAttempts <= 0` as "no attempt cap at all", so a stored 0 removes a
 *   budget the operator believes they set.
 * - `multiplier` is floored at 1 and capped at 100. Above that the sequence
 *   reaches the `maxDelayMs` clamp on the second retry, which makes every field
 *   except `initialDelayMs` decorative.
 * - `jitterRatio` is 0..1 because `retry.Delay` applies SYMMETRIC jitter:
 *   `d += (rand*2-1) * d * ratio`. At ratio 1 the delay can approach zero; above
 *   1 it goes negative and is clamped to zero, which is the hammering behaviour
 *   again by a different route.
 */
export const RETRY_POLICY_LIMITS = {
  maxAttempts: { min: 1, max: 50, default: 8 },
  initialDelayMs: { min: 1, max: 86_400_000, default: 5_000 },
  maxDelayMs: { min: 1, max: 86_400_000, default: 3_600_000 },
  multiplier: { min: 1, max: 100, default: 2 },
  jitterRatio: { min: 0, max: 1, default: 0.2 },
  /** 1s .. 7 days. See the int4 note above for why not 30. */
  maxRetryDurationMs: { min: 1_000, max: 604_800_000, default: 86_400_000 },
} as const;

/** `exponential | linear | constant` — the three `retry.Policy.Delay` switches on. */
export const RETRY_STRATEGIES = ['exponential', 'linear', 'constant'] as const;

export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

export const MAX_RETRY_POLICY_NAME_LENGTH = 200;

/**
 * How many retry policies one project may hold.
 *
 * A policy is a cheap row, but it is a row the data plane loads per endpoint and
 * an operator has to reason about at 2am. Fifty is far past any real topology —
 * most projects want one or two — and short of a number that makes the picker
 * in the operator UI useless or lets one `policies.write` holder enumerate the
 * table. The throttle on the create route bounds the RATE; this bounds the
 * TOTAL, which is the part that does not decay.
 */
export const MAX_RETRY_POLICIES_PER_PROJECT = 50;

/** Per-address create budget. Compile-time: `@Throttle` is decorator metadata. */
export const RETRY_POLICY_WRITE_THROTTLE = {
  name: 'retry-policies.write',
  limit: 60,
  windowMs: 5 * 60_000,
} as const;
