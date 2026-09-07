import { DeliveryStatus } from '@prisma/client';

/**
 * The most deliveries one replay request may create.
 *
 * Replay is the only route in this API that manufactures outbound HTTP traffic
 * to a customer's own infrastructure, so the blast radius has to be a number
 * somebody chose rather than "however many rows matched". Two separate reasons
 * for the same ceiling:
 *
 *  - **Egress.** `POST /events/:id/replay` with no `endpoint_id` re-sends one
 *    event to every endpoint it originally reached. At 10,000 subscribers that
 *    is 10,000 real HTTP calls from one request.
 *  - **Transaction cost.** Every insert goes through `ScopedRepository.create`,
 *    which proves four foreign keys (`event_id`, `endpoint_id`,
 *    `subscription_id`, `replay_of_delivery_id`) through their own scoped
 *    repositories first. That is five statements per delivery inside a
 *    SERIALIZABLE transaction, and a long SERIALIZABLE transaction is the thing
 *    most likely to abort everything else writing to `deliveries`.
 *
 * An operator who genuinely needs to replay to more endpoints than this replays
 * per endpoint; the error says so and names the count.
 */
export const MAX_REPLAY_FAN_OUT = 50;

/**
 * How many attempts `GET /deliveries/:id` inlines.
 *
 * The attempt history is the single most useful response in the product, so it
 * is inlined rather than made a second round trip - but `delivery_attempts` is
 * unbounded in principle (a policy with a large `max_attempts`, plus lease
 * reclaims after worker crashes), and an unbounded array inside a single-object
 * response is the same memory vector `MAX_PAGE_SIZE` exists to stop. Past this,
 * `attempts_truncated` is true and `GET /deliveries/:id/attempts` pages the
 * rest.
 */
export const MAX_INLINE_ATTEMPTS = 100;

/**
 * "Failing now", as an operator means it.
 *
 * Not a guess: these are the three states in which the last thing that happened
 * to a delivery was a failure. `retrying` is still trying, `exhausted` ran out
 * of budget, `failed` hit something a retry cannot fix. `pending`, `scheduled`,
 * `queued` and `processing` are excluded because nothing has gone wrong yet -
 * a slow queue is a different question and has a different answer.
 *
 * Index-supported: `deliveries_project_id_status_created_at_idx` is
 * `(project_id, status, created_at DESC)`, and an `IN` list on the second
 * column is three index scans, not a sequential one.
 */
export const FAILING_NOW_STATUSES: readonly DeliveryStatus[] = Object.freeze([
  DeliveryStatus.retrying,
  DeliveryStatus.failed,
  DeliveryStatus.exhausted,
]);

/**
 * Request headers whose VALUE never reaches a delivery response.
 *
 * `delivery_attempts.request_headers` is what we sent, and what we sent
 * includes an endpoint's `custom_headers` - which is where a customer puts the
 * bearer token or API key their own consumer requires. `deliveries.read` is
 * held by `viewer`, while `endpoint-secrets.read` is owner/admin only, so
 * rendering those values verbatim would hand a viewer a credential the
 * permission matrix deliberately withholds one table over.
 *
 * The KEY is kept and the value replaced, so the answer to "did we send the
 * Authorization header?" is still yes/no - which is the debugging question -
 * without the answer to "what was it?".
 *
 * The signature header is deliberately NOT here: it is an HMAC OVER the
 * payload, not the key, it is what a consumer compares against when
 * verification fails, and hiding it would make the most common support ticket
 * unanswerable.
 */
const REDACTED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

export const HEADER_REDACTED = '[redacted]';

export function isRedactedRequestHeader(name: string): boolean {
  return REDACTED_REQUEST_HEADERS.has(name.toLowerCase());
}
