/**
 * How many parked rows one requeue request may put back.
 *
 * The bound exists for the same reason `MAX_REPLAY_DELIVERIES` does, and for one
 * more. Every requeued row becomes a routing, and every routing becomes real
 * outbound HTTP to a customer's infrastructure - so an unbounded requeue is an
 * unbounded self-inflicted burst, aimed at whatever endpoints were already
 * failing when the incident started.
 *
 * The extra reason is that the incident which produced 40,000 parked rows is
 * usually still fresh when someone reaches for this button. Requeueing in
 * bounded passes lets an operator watch the first hundred drain before
 * committing the rest, and `has_more` on the response says whether there is
 * anything left, so "did I get all of them?" is answerable without a count.
 *
 * 100 rather than 50 (`MAX_REPLAY_DELIVERIES`): this is a recovery path, not a
 * routine one, and the page does not cost per-row round trips. `returnToQueue`
 * writes the whole page in two `updateMany` statements and reads it back in one
 * `findPage`, so the transaction the operator is waiting on is four statements
 * wide whether the page holds one row or a hundred. It is bounded here for what
 * happens AFTER the transaction commits - a hundred events entering the
 * router's queue at once - not for the transaction itself.
 */
export const MAX_REQUEUE_BATCH = 100;

/**
 * Outbox statuses an operator may requeue FROM.
 *
 * Only `failed` - the parking bay. Everything else is either already in the
 * queue (`pending`, `processing`) or finished (`processed`), and "requeueing" it
 * would either duplicate work the router is doing right now or re-run a routing
 * that already completed. The router's own idempotency would absorb the second
 * case, but an API that accepts a request it knows is a no-op teaches the
 * operator that the button does nothing.
 */
export const REQUEUEABLE_STATUS = 'failed' as const;
