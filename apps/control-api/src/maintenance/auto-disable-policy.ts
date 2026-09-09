/**
 * When a dead endpoint stops receiving deliveries at all, and what the customer
 * is told about it.
 *
 * Pure: no Prisma, no clock of its own, no I/O. Everything here is a decision
 * that has to be arguable in review and testable without a database.
 */

/**
 * How long the circuit breaker must have been CONTINUOUSLY open before the
 * endpoint is switched off, in hours.
 *
 * Three days, and the number is chosen against what the breaker already does
 * rather than picked for roundness.
 *
 * The breaker opens after five consecutive qualifying failures and then probes
 * once per cooldown, doubling to a ten-minute ceiling. So by 72 hours an
 * endpoint has been probed on the order of 430 times and answered none of them,
 * and `endpoint_health.opened_at` has not moved once - a single successful probe
 * closes the breaker and resets that column, so "open for three days" means
 * three days without one success, not three days of poor availability.
 *
 * The number has to sit above the two windows that produce a long outage which
 * is NOT a dead endpoint:
 *
 *   - a delivery's own wall-clock budget (`max_retry_duration`, 24h by default),
 *     so an endpoint is never disabled while the first affected deliveries are
 *     still being retried;
 *   - a weekend maintenance window. A customer who takes their consumer down on
 *     Friday evening and brings it back on Monday morning is inside 72 hours
 *     from Friday night, and their endpoint is still enabled when they return.
 *
 * And it has to sit low enough to be worth doing. Every hour past this point is
 * an hour of delivery rows created for an endpoint that will never receive
 * them: claimed, refused by the open breaker, deferred, re-claimed, and
 * eventually expired 24 hours later - permanently, at ingest rate.
 */
export const DEFAULT_AUTO_DISABLE_AFTER_HOURS = 72;

/** How often the sweep looks. */
export const DEFAULT_AUTO_DISABLE_INTERVAL_MINUTES = 15;

/**
 * How many endpoints one pass may disable.
 *
 * It bounds the transaction, and it bounds the blast radius of a mistake. If a
 * shared dependency takes a thousand customer endpoints down at once, this
 * turns "the platform disabled every endpoint you have in one minute" into a
 * gradual, visible, interruptible drain that an operator can stop by setting
 * ENDPOINT_AUTO_DISABLE_ENABLED=false before it finishes.
 */
export const DEFAULT_AUTO_DISABLE_MAX_PER_RUN = 200;

/**
 * The advisory lock the sweep holds for the length of one pass.
 *
 * The control API is horizontally scaled, so every replica would otherwise run
 * this on its own timer. They would not corrupt anything - the update is
 * conditional and the audit row is written only by the replica whose update
 * matched - but they would contend on the same rows and multiply the work by
 * the replica count for nothing. One transaction-scoped advisory lock makes the
 * sweep a singleton without a leader election, and it is released by COMMIT,
 * ROLLBACK or the connection dying, so a replica killed mid-pass cannot hold it.
 *
 * The value is arbitrary and must simply not collide with
 * `BOOTSTRAP_ADVISORY_LOCK_KEY` in src/cli/bootstrap.ts, which is the only
 * other advisory lock in this codebase.
 */
export const AUTO_DISABLE_ADVISORY_LOCK_KEY = 8_244_170_001n;

/** The audit action. `<resource>.<verb>`, past tense, like every other one. */
export const AUTO_DISABLE_AUDIT_ACTION = 'endpoint.auto_disabled';

/**
 * The prefix every automatic `disabled_reason` starts with.
 *
 * `disabled_reason` is rendered verbatim by the dashboard, so the column holds a
 * sentence rather than a code - but the sentence starts with a stable token so
 * that a script, a log search or a support macro can tell an automatic disable
 * from anything a human might one day write there.
 *
 * Note that the column is not the only signal and is not meant to be: an
 * operator pause sets `status = 'paused'` and deliberately leaves
 * `disabled_reason` NULL (see EndpointsService's class docblock), so
 * `status === 'disabled' && disabled_reason !== null` already distinguishes the
 * two without parsing anything.
 */
export const AUTO_DISABLE_REASON_PREFIX = 'auto-disabled';

/** The facts an auto-disable decision is made from. */
export interface BreakerSnapshot {
  /** When the breaker last went from closed to open. Null is never eligible. */
  openedAt: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
}

/**
 * Whether this endpoint has been dark long enough to switch off.
 *
 * The candidate query has already filtered on `state = 'open'` and on the
 * endpoint being active and enabled; this is the same test re-applied in
 * process, so the decision is expressible as a function and the boundary is
 * testable without seeding a database.
 *
 * `state = 'half_open'` deliberately does NOT qualify, and that is not an
 * oversight: half-open means a worker is holding the probe slot right now. The
 * window is one `HalfOpenTTL` wide and the row goes back to `open` when the
 * probe fails, so a genuinely dead endpoint is caught on the next pass and a
 * recovering one is never disabled a second before its probe is answered.
 */
export function hasBeenOpenLongEnough(
  snapshot: BreakerSnapshot,
  now: Date,
  afterHours: number,
): boolean {
  if (!snapshot.openedAt) return false;
  return now.getTime() - snapshot.openedAt.getTime() >= afterHours * 3_600_000;
}

/**
 * The sentence written into `disabled_reason`.
 *
 * It carries three things on purpose: what happened, the evidence, and what to
 * do about it. An endpoint that stops receiving webhooks with no explanation is
 * a support ticket; one whose own record says why and how to undo it is not.
 */
export function autoDisableReason(snapshot: BreakerSnapshot, now: Date): string {
  const openFor = snapshot.openedAt
    ? humaniseDuration(now.getTime() - snapshot.openedAt.getTime())
    : 'an unknown period';
  const lastSuccess = snapshot.lastSuccessAt
    ? snapshot.lastSuccessAt.toISOString()
    : 'never';
  return (
    `${AUTO_DISABLE_REASON_PREFIX}: the circuit breaker had been open for ${openFor} ` +
    `(${snapshot.consecutiveFailures} consecutive failures, last successful delivery: ${lastSuccess}). ` +
    'New events are no longer queued for this endpoint. Re-enable it once the endpoint is answering.'
  );
}

/** Whole days and hours; this is read by a human, not parsed. */
function humaniseDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) {
    const remainder = hours - days * 24;
    return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
  }
  return `${hours}h`;
}
