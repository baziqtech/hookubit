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

/**
 * How many live endpoints one project may hold.
 *
 * Endpoint creation is a write that costs more than its row: each one mints and
 * encrypts a signing secret, and each one is a destination the data plane holds
 * per-endpoint concurrency and rate-limit state for (ARCHITECTURE.md, "the hard
 * part" #1 and #3). Without a ceiling, one `endpoints.write` holder - a
 * developer, the weakest role that has it - can enumerate a project into tens of
 * thousands of endpoints and take the whole data plane's per-endpoint bookkeeping
 * with it. The rate limit on the route bounds the SPEED of that; this bounds the
 * TOTAL, which is the part that does not decay.
 *
 * Soft-deleted endpoints do not count: the rows are kept forever so the delivery
 * ledger stays readable, and counting them would eventually make a long-lived
 * project uncreatable.
 */
export const MAX_ENDPOINTS_PER_PROJECT = 500;
