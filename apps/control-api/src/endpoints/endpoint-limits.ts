/**
 * Bounds on the per-endpoint delivery knobs.
 *
 * These are not cosmetic validation. Every one of them is a lever a tenant
 * could otherwise pull on the shared data plane:
 *
 * - `timeoutMs` is how long a worker slot is held by ONE customer's endpoint.
 *   `timeout_ms = 600000` on a black-holing URL parks a worker for ten minutes
 *   per attempt. The ceiling is what makes per-endpoint isolation
 *   (ARCHITECTURE.md, "the hard part" #1) bounded rather than best-effort.
 * - `maxConcurrency` is how many of those slots the endpoint may hold at once.
 * - `rateLimit` / `rateLimitWindowSeconds` size the token bucket. A window of
 *   zero is a division by zero in whatever computes the refill rate.
 *
 * The floors matter as much as the ceilings: `timeout_ms = 1` fails every
 * delivery before the TCP handshake finishes and then burns the whole retry
 * budget doing it, which looks like a platform outage in the delivery log.
 */
export const ENDPOINT_LIMITS = {
  timeoutMs: { min: 1_000, max: 120_000, default: 30_000 },
  maxConcurrency: { min: 1, max: 256, default: 16 },
  rateLimit: { min: 1, max: 100_000 },
  rateLimitWindowSeconds: { min: 1, max: 3_600, default: 1 },
} as const;

export const MAX_ENDPOINT_NAME_LENGTH = 200;
export const MAX_ENDPOINT_DESCRIPTION_LENGTH = 1_000;
