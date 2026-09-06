/**
 * Express `trust proxy` configuration (FIX 1).
 *
 * `req.ip` is the socket address unless `trust proxy` is set; only then does
 * Express derive it from X-Forwarded-For. main.ts never set it, so behind the
 * nginx Ingress this repo ships EVERY request looked like it came from the
 * ingress controller pod - one address, therefore one rate-limit bucket for the
 * whole platform. The throttle guard refuses a request when any bucket is over,
 * so a handful of anonymous attempts an hour locked every user out of login and
 * password reset until the window rolled, over and over.
 *
 * The hop count is exact and comes from configuration. It is deliberately NOT
 * `true`: with `true` Express walks X-Forwarded-For to the left-most entry, so a
 * client sends `X-Forwarded-For: <random>` and gets a fresh bucket per request -
 * which is worse than no rate limiting at all, because it looks like there is
 * some.
 *
 * With a numeric `n`, Express trusts the `n` addresses nearest this process and
 * takes `req.ip` from the entry just beyond them - a client-supplied prefix is
 * never reached.
 */
export interface TrustProxyTarget {
  set(setting: string, value: unknown): unknown;
}

/**
 * Applies the hop count and returns it, so a caller can log what it configured.
 * Anything not a non-negative integer collapses to 0 (trust nothing), because
 * the failure mode of guessing high is header forgery.
 */
export function applyTrustProxy(app: TrustProxyTarget, hops: unknown): number {
  const parsed = typeof hops === 'number' ? hops : Number(hops);
  const safe = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  app.set('trust proxy', safe);
  return safe;
}
