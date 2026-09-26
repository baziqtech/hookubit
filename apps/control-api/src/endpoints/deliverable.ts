import { Endpoint, EndpointStatus, Prisma } from '@prisma/client';

/**
 * The ONE definition of "a delivery queued to this endpoint would actually be
 * attempted", in both the forms this API needs it: a predicate over a row, and
 * a `where` fragment PostgreSQL can count with.
 *
 * ## Why both halves are load-bearing
 *
 * `enabled` is OPERATOR INTENT and `status` is the CIRCUIT BREAKER'S VERDICT,
 * and neither implies the other:
 *
 *  - an endpoint the breaker auto-disabled after its failure window still reads
 *    `enabled: true` — the operator never asked for it to stop, and clearing
 *    `enabled` would lose the fact that they want it back;
 *  - an endpoint a developer created without a signing secret is left
 *    `status: 'paused', enabled: false` on purpose, because signing fails closed
 *    and an enabled endpoint with nothing to sign with delivers nothing;
 *  - `status: 'deleted'` is a soft delete: the row lives forever so the delivery
 *    ledger stays readable, and nothing is ever sent to it again.
 *
 * So `status === 'active'` alone over-counts by every endpoint the breaker has
 * taken out, and `enabled` alone over-counts by every endpoint that is down.
 *
 * ## Why it is a shared constant rather than three inline conditions
 *
 * It was three: `assertReplayable` (which refuses a replay the worker would
 * abandon), the dashboard's onboarding checklist, and now a per-project count on
 * the Usage screen. Three copies of a two-clause predicate is how one of them
 * ends up counting endpoints the data plane will never call — and the number
 * that is wrong is the one a customer reads, not the one a test reads.
 *
 * This is the control plane's statement of what the data plane does. The
 * authority is the worker: `services/data-plane` abandons a delivery whose
 * endpoint is not active-and-enabled at pickup. If that rule ever changes, this
 * is the file that has to change with it.
 */
export function isDeliverable(endpoint: Pick<Endpoint, 'status' | 'enabled'>): boolean {
  return endpoint.enabled && endpoint.status === EndpointStatus.active;
}

/**
 * `isDeliverable` as a `where` fragment, for counting IN THE DATABASE.
 *
 * Spread it into a scoped query (`{ ...DELIVERABLE_ENDPOINT_WHERE, projectId }`);
 * never fetch rows and filter them in JavaScript. A page is bounded by
 * `MAX_PAGE_SIZE`, so a count taken over rows is a count over the first 200
 * endpoints of up to 500 — right until the project that needed the number grows.
 */
export const DELIVERABLE_ENDPOINT_WHERE = {
  status: EndpointStatus.active,
  enabled: true,
} satisfies Prisma.EndpointWhereInput;
