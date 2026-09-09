package retention

import (
	"fmt"
	"strings"
)

// TerminalStatuses is the delivery ledger's definition of "nothing will ever
// happen to this row again", and it is the ONLY set retention is allowed to
// touch.
//
// It mirrors worker.State.Terminal() exactly (internal/worker/state.go). The
// two lists must agree: a status that is terminal there and missing here simply
// never gets pruned, which is a leak; a status that is NOT terminal there and
// present here is a delivery deleted out from under a worker that is still
// retrying it, which is data loss with a 202 already returned for it. That
// asymmetry is why the list is spelled out rather than inferred from "not in
// the claim predicate".
//
// TestTerminalStatusesMatchTheWorker pins the agreement.
var TerminalStatuses = []string{"succeeded", "failed", "exhausted", "cancelled"}

// terminalPredicate is the status test, rendered as a LITERAL IN list rather
// than passed as a parameter, and that is a planner requirement rather than a
// style choice.
//
// Both candidate scans are served by PARTIAL indexes whose predicate is
// `status IN ('succeeded','failed','exhausted','cancelled')`. PostgreSQL will
// only choose a partial index when it can PROVE the query's WHERE clause
// implies the index predicate, and it performs that proof at planning time. A
// bound parameter - `status = ANY($1)` - carries no value at plan time, so the
// proof fails, the index is rejected and every retention batch becomes a
// sequential scan of the largest table in the system. Rendering the list into
// the statement makes the implication trivially provable.
//
// It is safe to interpolate for the same reason it has to be: the values come
// from the constant above and never from anything a request can reach.
var terminalPredicate = func() string {
	quoted := make([]string, len(TerminalStatuses))
	for i, s := range TerminalStatuses {
		quoted[i] = "'" + s + "'"
	}
	return "status IN (" + strings.Join(quoted, ", ") + ")"
}()

// pruneAttemptsSQL removes the per-attempt DETAIL of old terminal deliveries and
// marks the delivery so the sweep never considers it again.
//
// # Why the marker column exists
//
// `deliveries.attempts_pruned_at` is what makes this statement self-terminating.
// Deleting rows from delivery_attempts does not change anything the CANDIDATE
// query can see, so without a marker every run would re-select the same
// deliveries forever, delete nothing, and grow more expensive every day. The
// marker takes a pruned delivery out of the partial index the candidate scan
// reads, so the working set is exactly "terminal deliveries past the horizon
// whose attempts are still here" and it drains to empty.
//
// It is also the honest answer in the operator UI. Without it a delivery reads
// `attempt_count: 5, attempts: []` - which looks exactly like "the platform
// never tried", the single worst thing this ledger can say. With it the row can
// say "the attempt detail was pruned on <date>".
//
// # Why it is resumable, and why there is no cursor
//
// There is no saved position, because the predicate IS the position. Every
// delivery this statement touches leaves the candidate set in the same
// transaction that touched it. A sweep killed halfway through - SIGTERM, a
// failover, a batch timeout - loses nothing but the batch that was in flight
// and rolled back; the next run selects exactly the rows the previous one did
// not reach. A stored cursor would be a second piece of state that can be wrong.
//
// # Why FOR UPDATE SKIP LOCKED
//
// A retention pass must never be the reason live traffic waits. Terminal rows
// are not claimed by workers, but they are read and written by replay and by
// the operator API, and a row locked by one of those is simply skipped here and
// collected on the next pass. Without SKIP LOCKED this statement would queue
// behind a customer's transaction while holding locks of its own - which is the
// shape of the incident retention is supposed to prevent, not cause.
//
// # Why the DELETE is a data-modifying CTE
//
// PostgreSQL executes every data-modifying statement in a WITH clause exactly
// once and to completion, whether or not the primary query reads its output, and
// all of them see the same snapshot. So `gone` really deletes and `marked`
// really updates, both against the row set `doomed` fixed - there is no window
// in which a delivery is marked pruned while its attempts survive.
var pruneAttemptsSQL = fmt.Sprintf(`
WITH doomed AS (
    SELECT id
    FROM deliveries
    WHERE %s
      AND attempts_pruned_at IS NULL
      AND created_at < now() - $1::interval
    ORDER BY created_at
    LIMIT $2
    FOR UPDATE SKIP LOCKED
), gone AS (
    DELETE FROM delivery_attempts a
    USING doomed d
    WHERE a.delivery_id = d.id
    RETURNING 1
), marked AS (
    UPDATE deliveries
    SET attempts_pruned_at = now()
    WHERE id IN (SELECT id FROM doomed)
    RETURNING 1
)
SELECT (SELECT count(*) FROM gone)::bigint,
       (SELECT count(*) FROM marked)::bigint
`, terminalPredicate)

// pruneDeliveriesSQL removes the delivery rows themselves, past the longer
// horizon.
//
// delivery_attempts.delivery_id is ON DELETE CASCADE, so any attempt rows the
// shorter sweep has not already taken go with the row. That is why BatchSize
// bounds this statement too: one delivery can carry `max_attempts` attempt rows,
// so a batch of 1,000 deliveries is up to 1,000 x max_attempts cascaded deletes.
//
// deliveries.event_id and deliveries.endpoint_id are ON DELETE RESTRICT in the
// other direction (an endpoint cannot be hard-deleted while its ledger exists);
// nothing points AT a delivery except its attempts, so this delete cannot fail
// on a constraint.
//
// ONE KNOWN CONSEQUENCE, accepted rather than solved: `replay_of_delivery_id` is
// a plain column with no foreign key. A replay created shortly before its
// original crossed the horizon keeps a pointer to a row that is now gone, and
// the operator UI following that pointer gets a 404. Enforcing it would need a
// correlated NOT EXISTS on every candidate plus an index on
// replay_of_delivery_id, on the hottest table in the system, to preserve a
// provenance link whose own delivery row, event row and attempt history all
// survive. The trade is not worth the write cost; it is documented here so the
// 404 is a known answer rather than a mystery.
var pruneDeliveriesSQL = fmt.Sprintf(`
WITH doomed AS (
    SELECT id
    FROM deliveries
    WHERE %s
      AND created_at < now() - $1::interval
    ORDER BY created_at
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
DELETE FROM deliveries d
USING doomed x
WHERE d.id = x.id
`, terminalPredicate)
