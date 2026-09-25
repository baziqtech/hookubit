package failure_test

import (
	"testing"
	"time"
)

// TestDeliveryDeferredForeverEventuallyExhaustsItsRetryDuration is the
// highest-severity gap this suite did not previously cover: a delivery that is
// never ATTEMPTED still has to be able to end.
//
// Scenario: an endpoint has been dead long enough that its circuit breaker is
// open with a long cooldown, and a delivery has been sitting behind it for
// longer than the policy's max_retry_duration (24h on the fixture policy).
//
// Recovery strategy asserted: the delivery goes TERMINAL - `exhausted`, reason
// `retry_duration_exhausted`, completed_at set - without an attempt row and
// without attempt_count moving, and the endpoint is never contacted.
//
// Both halves of that matter and they pull in opposite directions:
//
//   - it must END, because the wall clock ran out. retry.Policy.Exhausted used
//     to be reachable only from Decide, which runs when an attempt COMPLETES,
//     and a breaker refusal defers before any attempt is made. So a permanently
//     dead endpoint accumulated deliveries at ingest rate, each re-claimed every
//     cooldown forever. Under the shipped CLAIM_STRATEGY=fifo - a strict global
//     ordering with no tenant predicate - those ever-older rows sort AHEAD of
//     live traffic, so one dead endpoint degrades the whole queue for every
//     tenant. There is no reaper in either plane that would have caught them.
//   - it must end WITHOUT spending an attempt, because none was made. The
//     attempt budget answers "how many times did we ask"; charging it for a
//     refusal we issued ourselves would make the ledger lie, and would exhaust
//     deliveries that were never actually tried.
//
// What a regression looks like in production: the delivery goes back to
// `scheduled` (the queue fills with rows nothing will ever deliver), or it ends
// as `failed`/`attempts_exhausted` with attempt_count advanced (an operator
// reads it as the customer's endpoint rejecting the webhook, and raises
// max_attempts to fix a wall-clock problem).
func TestDeliveryDeferredForeverEventuallyExhaustsItsRetryDuration(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})

	// The breaker is open with a cooldown that will not elapse during this
	// test, so every claim of this delivery is refused before any request.
	mustExec(t, pool, `INSERT INTO endpoint_health
	                     (endpoint_id, state, consecutive_failures, consecutive_successes,
	                      last_failure_at, opened_at, probe_after, updated_at)
	                   VALUES ($1, 'open', 40, 0, now(), now() - interval '25 hours',
	                           now() + interval '10 minutes', now())`,
		endpointID)

	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 5})
	// first_attempt_at is COALESCE(MIN(delivery_attempts.started_at),
	// deliveries.created_at) - and this delivery has no attempts, which is the
	// whole point - so backdating creation is how "it has been waiting for more
	// than a day" is expressed. The fixture policy's max_retry_duration_ms is
	// 24h.
	mustExec(t, pool,
		`UPDATE deliveries SET created_at = now() - interval '25 hours' WHERE id = $1`, deliveryID)

	rig := newRig(t, pool, rigOpts{workerID: "wrk_budget"})
	stop := rig.start(t)
	eventually(t, 20*time.Second, "the out-of-budget delivery to go terminal", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "exhausted"
	})
	stop()

	state := readDelivery(t, pool, deliveryID)
	if state.LastError == nil || *state.LastError != "retry_duration_exhausted" {
		t.Fatalf("last_error = %v, want retry_duration_exhausted: it was the CLOCK that ran out, and "+
			"naming the wrong budget sends an operator to the wrong knob", state.LastError)
	}
	if state.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d, want 0: no request was ever made, so no attempt may be charged",
			state.AttemptCount)
	}
	if state.CompletedAt == nil {
		t.Fatal("completed_at is null on a terminal delivery; nothing downstream can tell it has stopped")
	}
	if state.LockedBy != nil {
		t.Fatalf("the delivery is still locked by %q after going terminal", *state.LockedBy)
	}
	if got := readAttempts(t, pool, deliveryID); len(got) != 0 {
		t.Fatalf("%d attempt rows were written for a delivery that was never attempted: %+v", len(got), got)
	}
	if n := endpoint.Requests(); n != 0 {
		t.Fatalf("the endpoint received %d requests despite an open breaker", n)
	}

	// The breaker is untouched: expiring OUR delivery says nothing about the
	// endpoint's health, and must not count against it.
	state2, failures, _, _, found := readHealth(t, pool, endpointID)
	if !found {
		t.Fatal("the endpoint_health row disappeared")
	}
	if state2 != "open" || failures != 40 {
		t.Fatalf("endpoint health = (%s, %d failures), want it untouched (open, 40)", state2, failures)
	}
}

// The control: a delivery behind the same open breaker with budget still left
// is DEFERRED, not terminated. An expiry rule that fires early destroys
// deliveries that were still perfectly good.
func TestDeliveryDeferredInsideItsBudgetIsRescheduledNotTerminated(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})
	mustExec(t, pool, `INSERT INTO endpoint_health
	                     (endpoint_id, state, consecutive_failures, consecutive_successes,
	                      last_failure_at, opened_at, probe_after, updated_at)
	                   VALUES ($1, 'open', 5, 0, now(), now(), now() + interval '10 minutes', now())`,
		endpointID)

	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 5})
	// An hour old against a 24h budget: plenty left.
	mustExec(t, pool,
		`UPDATE deliveries SET created_at = now() - interval '1 hour' WHERE id = $1`, deliveryID)

	rig := newRig(t, pool, rigOpts{workerID: "wrk_budget_left"})
	stop := rig.start(t)
	eventually(t, 20*time.Second, "the delivery to be deferred behind the breaker", func() bool {
		s := readDelivery(t, pool, deliveryID)
		return s.Status == "scheduled" && s.LastError != nil && *s.LastError == "circuit_breaker_open"
	})
	stop()

	state := readDelivery(t, pool, deliveryID)
	if state.CompletedAt != nil {
		t.Fatal("a delivery with 23 hours of budget left was completed")
	}
	if state.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d, want 0", state.AttemptCount)
	}
	if state.NextAttemptAt == nil || !state.NextAttemptAt.After(dbNow(t, pool)) {
		t.Fatal("a deferred delivery must carry a future next_attempt_at, or the next poll re-claims it " +
			"immediately and the breaker's cooldown means nothing")
	}
	if n := endpoint.Requests(); n != 0 {
		t.Fatalf("the endpoint received %d requests despite an open breaker", n)
	}
}
