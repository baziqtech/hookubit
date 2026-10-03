import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Bounds on how fast, and how many, subscriptions a project may hold.
 *
 * Rate and total are separate limits answering different questions; see
 * `projects/project-limits.ts` for the full argument, and for why the throttle
 * is a compile-time constant (`@Throttle` is decorator metadata, evaluated
 * before `ConfigModule` has read a `.env` file) while the ceiling is read from
 * `ConfigService` at call time.
 *
 * The ceiling matters more here than anywhere else in the control plane.
 * Subscriptions are the DELIVERY MULTIPLIER: the router materialises one
 * `deliveries` row per matching subscription per event (ARCHITECTURE.md 18), so
 * a project with N subscriptions matching an event turns one ingest into N
 * durable rows, N HTTP attempts and N retry chains. CLAUDE.md names this
 * directly - "materialised routing is cheap at 10 subscribers and expensive at
 * 10,000". A subscription row is the cheapest write in this API and the most
 * expensive one to have made.
 */
export const SUBSCRIPTION_CREATE_THROTTLE = {
  name: 'subscriptions.create',
  /**
   * Thirty a minute. Wiring up an integration by hand is a handful of creates;
   * a runaway script hits this in two seconds.
   */
  limit: 30,
  windowMs: 60_000,
} as const;

/**
 * Updates, enables, disables and deletes share one bucket, looser than create.
 *
 * These are the operations an operator reaches for under pressure - "disable
 * every subscription pointed at the endpoint that is melting" - often from a
 * script with retries, and all of them are idempotent. A throttle that made
 * that fail partway would be a limit causing the incident it was added to
 * contain. It is here to bound an abusive loop, not to pace an operator.
 */
export const SUBSCRIPTION_MUTATE_THROTTLE = {
  name: 'subscriptions.mutate',
  limit: 120,
  windowMs: 60_000,
} as const;

/** `MAX_SUBSCRIPTIONS_PER_PROJECT`, clamped. */
export const SUBSCRIPTIONS_PER_PROJECT = {
  env: 'MAX_SUBSCRIPTIONS_PER_PROJECT',
  /**
   * Five hundred, matching `MAX_ENDPOINTS_PER_PROJECT`. One subscription per
   * endpoint is the ordinary topology and a handful per endpoint is a rich one;
   * five hundred is far past both and still a routing a single event can afford.
   */
  default: 500,
  min: 1,
  max: 10_000,
} as const;

export const MAX_SUBSCRIPTION_NAME_LENGTH = 200;

const logger = new Logger('SubscriptionLimits');

/**
 * The configured ceiling, or the default.
 *
 * Clamped rather than trusted, and never fatal: `=0` would lock a tenant out of
 * its own product and `=1e9` would be the same as having no ceiling, and both
 * are one typo away in a Helm values file. An unparsable value warns and falls
 * back - refusing to boot over a routing ceiling would be the worse failure.
 */
export function maxSubscriptionsPerProject(config: ConfigService): number {
  const bounds = SUBSCRIPTIONS_PER_PROJECT;
  const raw = config.get<string | number>(bounds.env);
  if (raw === undefined || raw === null || raw === '') return bounds.default;

  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(`${bounds.env}="${String(raw)}" is not a number; using ${bounds.default}.`);
    return bounds.default;
  }
  const floored = Math.floor(parsed);
  if (floored < bounds.min || floored > bounds.max) {
    const clamped = Math.min(Math.max(floored, bounds.min), bounds.max);
    logger.warn(`${bounds.env}=${floored} is outside [${bounds.min}, ${bounds.max}]; using ${clamped}.`);
    return clamped;
  }
  return floored;
}
