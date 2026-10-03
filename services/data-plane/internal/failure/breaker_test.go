package failure_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/worker"
)

// breakerConfig opens fast and cools down for long enough that nothing reopens
// underneath an assertion. Zero jitter, so "when does the probe become due" has
// one answer rather than a range.
func breakerConfig() worker.BreakerConfig {
	return worker.BreakerConfig{
		DegradedThreshold: 2,
		OpenThreshold:     2,
		BaseCooldown:      30 * time.Second,
		MaxCooldown:       time.Minute,
		HalfOpenSuccesses: 1,
		HalfOpenTTL:       5 * time.Second,
		JitterRatio:       0,
	}
}

// openTheProbeWindow makes the breaker's cooldown look expired. It stands in
// for waiting out BaseCooldown, which is the one thing in this scenario that is
// pure elapsed time and carries no information.
func openTheProbeWindow(t *testing.T, pool *pgxpool.Pool, endpointID string) {
	t.Helper()
	mustExec(t, pool,
		`UPDATE endpoint_health SET probe_after = now() - interval '1 second' WHERE endpoint_id = $1`,
		endpointID)
}

// TestScenario20_EndpointBecomesPermanentlyUnhealthy covers ARCHITECTURE.md 57
// case 20.
//
// Scenario: one endpoint in a project stops working entirely. Another endpoint
// in the SAME project is fine.
//
// Recovery strategy asserted, in four parts:
//   - the breaker opens once consecutive failures reach the threshold, and
//     endpoint_health records it.
//   - delivery pressure is then actually removed: the next delivery to that
//     endpoint is DEFERRED without an HTTP request and without an attempt row,
//     so an open breaker costs the customer no retry budget. The reason is
//     written to deliveries.last_error, because "why is this delivery not
//     moving" is the question the operator UI exists to answer.
//   - a neighbouring endpoint in the same project is unaffected throughout.
//   - once the cooldown has passed, the half-open probe admits one delivery,
//     and a successful probe closes the breaker back to healthy.
//
// What a regression looks like in production: record the breaker refusal as a
// failed ATTEMPT rather than a deferral, and a dead endpoint burns each
// delivery's whole retry budget in a few seconds of refusals - every delivery
// queued behind it goes to `exhausted` without a single request having been
// made, and the customer is told their endpoint rejected traffic it never saw.
func TestScenario20_EndpointBecomesPermanentlyUnhealthy(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	bad := newTestEndpoint(t)
	bad.setStatus(http.StatusInternalServerError)
	badID := f.newEndpoint(t, endpointOpts{url: bad.URL()})

	good := newTestEndpoint(t)
	goodID := f.newEndpoint(t, endpointOpts{url: good.URL()})

	first := f.newDelivery(t, badID, deliveryOpts{due: -time.Second, maxAttempts: 9})
	second := f.newDelivery(t, badID, deliveryOpts{due: -time.Second, maxAttempts: 9})

	rig := newRig(t, pool, rigOpts{workerID: "wrk_breaker", breaker: breakerConfig()})
	stop := rig.start(t)
	t.Cleanup(stop)

	// --- the breaker opens ------------------------------------------------
	eventually(t, 25*time.Second, "both failing deliveries to be recorded", func() bool {
		return readDelivery(t, pool, first).Status == "retrying" &&
			readDelivery(t, pool, second).Status == "retrying"
	})
	eventually(t, 10*time.Second, "the circuit breaker to open", func() bool {
		state, _, _, _, found := readHealth(t, pool, badID)
		return found && state == "open"
	})
	_, failures, _, probeAfter, _ := readHealth(t, pool, badID)
	if failures != 2 {
		t.Fatalf("consecutive_failures = %d, want 2 (the open threshold)", failures)
	}
	if probeAfter == nil {
		t.Fatal("an open breaker with no probe_after is an endpoint that never recovers")
	}
	requestsWhenOpen := bad.Requests()
	if requestsWhenOpen != 2 {
		t.Fatalf("the failing endpoint saw %d requests before the breaker opened, want 2", requestsWhenOpen)
	}

	// --- pressure is removed, and it costs no retry budget ----------------
	third := f.newDelivery(t, badID, deliveryOpts{due: -time.Second, maxAttempts: 9})
	eventually(t, 20*time.Second, "the delivery behind an open breaker to be deferred", func() bool {
		s := readDelivery(t, pool, third)
		return s.Status == "scheduled" && s.LastError != nil
	})
	deferred := readDelivery(t, pool, third)
	if deferred.LastError == nil || *deferred.LastError != "circuit_breaker_open" {
		t.Fatalf("last_error = %v, want circuit_breaker_open", deferred.LastError)
	}
	if deferred.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d after a breaker refusal, want 0: no request was made, "+
			"so nothing may be charged against the retry budget", deferred.AttemptCount)
	}
	if got := readAttempts(t, pool, third); len(got) != 0 {
		t.Fatalf("a breaker refusal wrote %d attempt rows, want 0", len(got))
	}
	if n := bad.Requests(); n != requestsWhenOpen {
		t.Fatalf("the failing endpoint saw %d requests while its breaker was open, want %d",
			n, requestsWhenOpen)
	}

	// --- the neighbour is untouched ---------------------------------------
	neighbour := f.newDelivery(t, goodID, deliveryOpts{due: -time.Second, maxAttempts: 9})
	eventually(t, 20*time.Second, "the healthy endpoint in the same project to be delivered to", func() bool {
		return readDelivery(t, pool, neighbour).Status == "succeeded"
	})
	if n := good.Requests(); n != 1 {
		t.Fatalf("the healthy endpoint saw %d requests, want 1", n)
	}
	if state, _, _, _, found := readHealth(t, pool, goodID); found && state != "healthy" {
		t.Fatalf("the healthy endpoint's breaker state = %q; one endpoint's failure must not "+
			"open another's", state)
	}

	// --- half open: one probe, and success closes it ----------------------
	bad.setStatus(http.StatusOK)
	openTheProbeWindow(t, pool, badID)
	makeDue(t, pool, third)

	eventually(t, 25*time.Second, "the half-open probe to deliver and close the breaker", func() bool {
		return readDelivery(t, pool, third).Status == "succeeded"
	})
	if n := bad.Requests(); n != requestsWhenOpen+1 {
		t.Fatalf("the endpoint saw %d requests after the probe, want %d: half-open admits ONE",
			n, requestsWhenOpen+1)
	}
	eventually(t, 10*time.Second, "the breaker to close", func() bool {
		state, _, _, _, found := readHealth(t, pool, badID)
		return found && state == "healthy"
	})
	state, failures, _, probe, _ := readHealth(t, pool, badID)
	if failures != 0 {
		t.Fatalf("consecutive_failures = %d after recovery, want 0", failures)
	}
	if probe != nil {
		t.Fatalf("a closed breaker still has probe_after = %v", probe)
	}
	if state != "healthy" {
		t.Fatalf("breaker state = %q, want healthy", state)
	}
	if got := readAttempts(t, pool, third); len(got) != 1 {
		t.Fatalf("the probed delivery has %d attempt rows, want 1: the deferrals before it "+
			"were not attempts", len(got))
	}
}

// TestScenario20_OnlyOneWorkerWinsTheHalfOpenProbe is the other half of case 20:
// re-enabling an endpoint without a thundering herd.
//
// Scenario: a thousand deliveries are queued behind a recovering endpoint and
// its cooldown expires. Every worker asks at once whether it may probe.
//
// Recovery strategy asserted: ClaimProbe is a single conditional UPDATE whose
// predicate is also the write that withdraws the invitation, so exactly one
// caller wins however many ask simultaneously. The losers defer.
//
// What a regression looks like in production: split the check and the claim, or
// move the probe decision into a cache, and a recovering endpoint is hit by
// every queued delivery in the same instant - which is what knocked it over in
// the first place, now applied by the mechanism that exists to prevent it.
func TestScenario20_OnlyOneWorkerWinsTheHalfOpenProbe(t *testing.T) {
	pool := requirePool(t)
	f := seedTenant(t, pool)
	endpointID := f.newEndpoint(t, endpointOpts{noSecret: true})

	mustExec(t, pool, `INSERT INTO endpoint_health
	                     (endpoint_id, state, consecutive_failures, consecutive_successes,
	                      last_failure_at, opened_at, probe_after, updated_at)
	                   VALUES ($1, 'open', 5, 0, now(), now(), now() - interval '1 second', now())`,
		endpointID)

	store := worker.NewPostgresStore(pool)

	const askers = 12
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		won   int
		start = make(chan struct{})
	)
	for i := 0; i < askers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			claimed, err := store.ClaimProbe(context.Background(), endpointID, 30*time.Second)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				t.Errorf("ClaimProbe: %v", err)
				return
			}
			if claimed {
				won++
			}
		}()
	}
	close(start)
	wg.Wait()

	if won != 1 {
		t.Fatalf("%d of %d workers were admitted as the half-open probe, want exactly 1", won, askers)
	}
	state, _, _, probeAfter, found := readHealth(t, pool, endpointID)
	if !found || state != "half_open" {
		t.Fatalf("endpoint health = %q (found=%v), want half_open", state, found)
	}
	if probeAfter == nil || !probeAfter.After(time.Now()) {
		t.Fatalf("probe_after = %v; claiming a probe must withdraw the invitation for its TTL", probeAfter)
	}
}
