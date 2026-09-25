package failure_test

import (
	"net/http"
	"testing"
	"time"
)

// assertRetryScheduledByPolicy checks that a delivery was rescheduled by the
// fixture's retry policy - constant, 60s, no jitter - and not by anything else.
//
// The comparison uses the SERVER clock on both sides. advanceSQL writes
// `next_attempt_at = now() + interval` and the claim predicate compares against
// `now()`, so a bound taken from the test process's clock would be measuring
// the skew between two machines. The window is deliberately wide (±10s): the
// column is timestamp(3), now() rounds, and an assertion tight enough to notice
// that is an assertion that fails for the wrong reason.
func assertRetryScheduledByPolicy(t *testing.T, state deliveryState, serverNow time.Time) {
	t.Helper()
	if state.NextAttemptAt == nil {
		t.Fatal("next_attempt_at is null on a retrying delivery: the column is NOT NULL (20260911000000), " +
			"so either this database is missing that migration or the retry was never scheduled")
	}
	delay := state.NextAttemptAt.Sub(serverNow)
	if delay < retryDelay-10*time.Second || delay > retryDelay+10*time.Second {
		t.Fatalf("next_attempt_at is %s away, want about %s (the endpoint's constant retry policy)",
			delay, retryDelay)
	}
}

// ---------------------------------------------------------------------------
// scenario 10
// ---------------------------------------------------------------------------

// TestScenario10_CustomerEndpointTimesOut covers ARCHITECTURE.md 57 case 10.
//
// Scenario: the customer's endpoint accepts the connection and never answers.
// endpoints.timeout_ms is 300ms here; the receiver takes three seconds.
//
// Recovery strategy asserted:
//   - the attempt IS recorded, classified as `timeout` with error_code
//     "timeout" and no HTTP status, because we never got one. A gap in the
//     ledger is not an acceptable answer to "what happened to this event".
//   - the delivery moves to `retrying` with next_attempt_at in the future, set
//     by the endpoint's own retry policy.
//   - the retry budget is decremented by EXACTLY one: attempt_count goes 0 -> 1
//     and precisely one delivery_attempts row exists.
//
// What a regression looks like in production: classify a timeout as `error`
// (an operator can no longer tell "slow" from "unreachable" on a dashboard), or
// let the endpoint's timeout_ms extend rather than shorten the platform's own
// ceiling. The second one is the dangerous one: a customer sets timeout_ms to
// 300000 and one endpoint holds worker slots for five minutes at a time.
func TestScenario10_CustomerEndpointTimesOut(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpoint.setDelay(3 * time.Second)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL(), timeoutMS: 300})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 5})

	rig := newRig(t, pool, rigOpts{workerID: "wrk_timeout"})
	stop := rig.start(t)
	eventually(t, 20*time.Second, "the timed-out delivery to be rescheduled", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "retrying"
	})
	stop()

	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 {
		t.Fatalf("attempt rows = %d, want exactly 1", len(attempts))
	}
	a := attempts[0]
	if a.Status != "timeout" {
		t.Fatalf("attempt status = %q, want timeout: the endpoint never answered", a.Status)
	}
	if a.HTTPStatus != nil {
		t.Fatalf("attempt recorded http_status %v; there was no response to have a status", *a.HTTPStatus)
	}
	if a.ErrorCode == nil || *a.ErrorCode != "timeout" {
		t.Fatalf("error_code = %v, want \"timeout\"", a.ErrorCode)
	}
	if a.ErrorMessage == nil || *a.ErrorMessage == "" {
		t.Fatal("a timed-out attempt carried no error message")
	}

	state := readDelivery(t, pool, deliveryID)
	if state.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want exactly 1: one request, one unit of budget", state.AttemptCount)
	}
	if state.LastError == nil || *state.LastError != "retry_scheduled" {
		t.Fatalf("last_error = %v, want retry_scheduled", state.LastError)
	}
	assertRetryScheduledByPolicy(t, state, dbNow(t, pool))
}

// ---------------------------------------------------------------------------
// scenario 11
// ---------------------------------------------------------------------------

// TestScenario11_CustomerEndpointReturns500 covers ARCHITECTURE.md 57 case 11.
//
// Scenario: the endpoint is up and answering 500 - a deploy gone wrong, a
// dependency of theirs that is down.
//
// Recovery strategy asserted: a 5xx is retryable, so the delivery is retried on
// the endpoint's policy, one attempt row per request, until the budget frozen
// onto the delivery (deliveries.max_attempts, 2 here) runs out - at which point
// it is `exhausted` with reason attempts_exhausted, NOT `failed`. The
// distinction matters to an operator: `failed` means the endpoint rejected it
// permanently, `exhausted` means we gave up.
//
// What a regression looks like in production: treat 5xx as permanent (a
// customer's 30-second deploy blip becomes permanent data loss), or let the
// endpoint's CURRENT policy override the budget frozen onto the delivery
// (editing a retry policy retroactively truncates or extends deliveries already
// in flight, and the ledger stops matching what the customer was promised).
func TestScenario11_CustomerEndpointReturns500(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpoint.setStatus(http.StatusInternalServerError)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 2})

	rig := newRig(t, pool, rigOpts{workerID: "wrk_500"})
	stop := rig.start(t)

	// --- first failure: retried on the policy -----------------------------
	eventually(t, 20*time.Second, "the 500 to be scheduled for retry", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "retrying"
	})
	state := readDelivery(t, pool, deliveryID)
	if state.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d after one 500, want 1", state.AttemptCount)
	}
	assertRetryScheduledByPolicy(t, state, dbNow(t, pool))

	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 || attempts[0].Status != "failure" {
		t.Fatalf("attempts = %+v, want one row with status failure", attempts)
	}
	if attempts[0].HTTPStatus == nil || *attempts[0].HTTPStatus != 500 {
		t.Fatalf("http_status = %v, want 500", attempts[0].HTTPStatus)
	}
	if attempts[0].ErrorCode == nil || *attempts[0].ErrorCode != "http_500" {
		t.Fatalf("error_code = %v, want http_500", attempts[0].ErrorCode)
	}

	// --- the retry actually happens, and the budget ends it ----------------
	makeDue(t, pool, deliveryID)
	eventually(t, 20*time.Second, "the retry budget to run out", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "exhausted"
	})
	stop()

	final := readDelivery(t, pool, deliveryID)
	if final.AttemptCount != 2 {
		t.Fatalf("attempt_count = %d, want 2 (max_attempts)", final.AttemptCount)
	}
	if final.LastError == nil || *final.LastError != "attempts_exhausted" {
		t.Fatalf("last_error = %v, want attempts_exhausted", final.LastError)
	}
	if final.CompletedAt == nil {
		t.Fatal("completed_at is null on an exhausted delivery")
	}
	if got := readAttempts(t, pool, deliveryID); len(got) != 2 {
		t.Fatalf("attempt rows = %d, want 2: one per request, append-only", len(got))
	}
	if n := endpoint.Requests(); n != 2 {
		t.Fatalf("the endpoint saw %d requests, want 2", n)
	}
}

// ---------------------------------------------------------------------------
// scenario 12
// ---------------------------------------------------------------------------

// TestScenario12_CustomerEndpointReturns429 covers ARCHITECTURE.md 57 case 12.
//
// Scenario: the endpoint answers 429 and asks, via Retry-After, to be left
// alone for an hour.
//
// Recovery strategy asserted: a 429 is retryable (retry.ShouldRetry) and the
// delivery is rescheduled with an attempt recorded as http_429.
//
// The endpoint's OWN schedule is honoured, within bounds it does not choose.
//
// This test used to pin the opposite, as a gap asserted rather than invented
// away: nothing read the header, worker.Decide computed the next attempt purely
// from retry.Policy, and an endpoint asking for 3600 seconds was retried on the
// policy's 60 anyway - burning the delivery's budget on requests the endpoint
// had told us in advance it would refuse. It said that if Retry-After was ever
// implemented this test SHOULD fail, and that the fix was to assert the new
// behaviour rather than widen the window. That is what the assertions below now
// do.
//
// The bound matters as much as the honouring. The fixture policy caps
// max_delay_ms at an hour, so 3600s is honoured exactly to that ceiling; an
// endpoint answering `Retry-After: 999999999` gets the same ceiling rather than
// parking the delivery for thirty years in a state that still reads as
// `retrying`. Retry-After may also never push next_attempt_at past
// first_attempt_at + max_retry_duration, because an attempt scheduled beyond
// the wall-clock budget is one that is guaranteed to be judged exhausted the
// moment it runs.
//
// What a regression looks like in production: back to the policy's schedule (a
// burst to a rate-limited endpoint keeps generating 429s), or an unclamped
// header (one hostile endpoint parks its deliveries past any horizon an
// operator can see).
func TestScenario12_CustomerEndpointReturns429(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpoint.setStatus(http.StatusTooManyRequests)
	endpoint.setHeaders(map[string]string{"Retry-After": "3600"})
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 5})

	rig := newRig(t, pool, rigOpts{workerID: "wrk_429"})
	stop := rig.start(t)
	eventually(t, 20*time.Second, "the 429 to be scheduled for retry", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "retrying"
	})
	stop()

	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 {
		t.Fatalf("attempt rows = %d, want 1", len(attempts))
	}
	if attempts[0].HTTPStatus == nil || *attempts[0].HTTPStatus != 429 {
		t.Fatalf("http_status = %v, want 429", attempts[0].HTTPStatus)
	}
	if attempts[0].ErrorCode == nil || *attempts[0].ErrorCode != "http_429" {
		t.Fatalf("error_code = %v, want http_429", attempts[0].ErrorCode)
	}

	state := readDelivery(t, pool, deliveryID)
	if state.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want 1", state.AttemptCount)
	}
	if state.LastError == nil || *state.LastError != "retry_scheduled" {
		t.Fatalf("last_error = %v, want retry_scheduled: honouring Retry-After is still a scheduled "+
			"retry, and inventing a reason value the operator UI does not know is not an improvement",
			state.LastError)
	}
	// The endpoint asked for 3600s. The fixture policy's max_delay_ms is an
	// hour, so the honoured value is the ceiling - and, either way, an order of
	// magnitude away from the policy's 60s backoff, which is what this used to
	// assert.
	if state.NextAttemptAt == nil {
		t.Fatal("next_attempt_at is null on a retrying delivery")
	}
	delay := state.NextAttemptAt.Sub(dbNow(t, pool))
	if delay < 55*time.Minute || delay > time.Hour+10*time.Second {
		t.Fatalf("next_attempt_at is %s away, want about an hour: the endpoint asked to be left alone for "+
			"3600s and the policy caps the delay at 3600s, so anything near the policy's %s backoff means "+
			"the header is being ignored again", delay, retryDelay)
	}

	// The response header is captured on the attempt row too, so an operator
	// can see WHY the gap is an hour rather than a minute.
	var stored *string
	if err := pool.QueryRow(t.Context(),
		`SELECT response_headers->>'Retry-After' FROM delivery_attempts WHERE delivery_id = $1`,
		deliveryID).Scan(&stored); err != nil {
		t.Fatalf("read stored response headers: %v", err)
	}
	if stored == nil || *stored != "3600" {
		t.Fatalf("the attempt row did not preserve the endpoint's Retry-After (%v); "+
			"without it an operator cannot tell an honoured header from a broken backoff", stored)
	}
}

// The clamp, asserted against the real delivery loop rather than against
// Decide alone: an endpoint asking for roughly thirty years gets the policy's
// ceiling, not thirty years.
//
// Without it a single hostile or broken endpoint can move its deliveries out of
// every operational window there is - they stay `retrying`, so nothing alerts,
// and next_attempt_at is past any dashboard's horizon.
func TestScenario12_AbsurdRetryAfterIsClamped(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpoint.setStatus(http.StatusServiceUnavailable)
	endpoint.setHeaders(map[string]string{"Retry-After": "999999999"})
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second, maxAttempts: 5})

	rig := newRig(t, pool, rigOpts{workerID: "wrk_retry_after_absurd"})
	stop := rig.start(t)
	eventually(t, 20*time.Second, "the 503 to be scheduled for retry", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "retrying"
	})
	stop()

	state := readDelivery(t, pool, deliveryID)
	if state.NextAttemptAt == nil {
		t.Fatal("next_attempt_at is null on a retrying delivery")
	}
	// max_delay_ms on the fixture policy is 3600000.
	if delay := state.NextAttemptAt.Sub(dbNow(t, pool)); delay > time.Hour+10*time.Second {
		t.Fatalf("next_attempt_at is %s away; the endpoint set the platform's schedule with no ceiling, "+
			"so one broken producer can park its deliveries beyond any window an operator watches", delay)
	}
	if state.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want 1", state.AttemptCount)
	}
}
