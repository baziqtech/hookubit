package worker

import (
	"context"
	"sync"
	"testing"
	"time"
)

// The breaker's rules exist twice: once as NextHealth (pure, unit tested) and
// once as the upsert in store.go (atomic, so two workers cannot both read 4 and
// both write 5). Two implementations of one rule set drift silently, so this
// test drives the SQL through the same sequences NextHealth is tested with and
// asserts they agree.
func TestBreakerSQLAgreesWithNextHealth(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()
	cfg := breakerCfg()

	sequences := [][]bool{
		{false},
		{false, false, false},
		{false, false, false, false, false},
		{false, false, false, false, false, false, false},
		{false, false, false, true},
		{false, false, false, false, false, true},
		{true, false, true, false, false},
	}

	for i, sequence := range sequences {
		i, sequence := i, sequence
		t.Run("", func(t *testing.T) {
			mustExec(t, pool, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)

			expected := Health{State: HealthHealthy}
			for step, success := range sequence {
				_, got, err := store.RecordOutcome(ctx, f.endpointID, success, cfg, 1)
				if err != nil {
					t.Fatalf("sequence %d step %d: %v", i, step, err)
				}
				expected = NextHealth(expected, success, cfg, time.Now(), 1)

				if got.State != expected.State {
					t.Fatalf("sequence %d step %d (success=%v): SQL says %s, NextHealth says %s",
						i, step, success, got.State, expected.State)
				}
				if got.ConsecutiveFailures != expected.ConsecutiveFailures {
					t.Fatalf("sequence %d step %d: SQL consecutive_failures = %d, NextHealth = %d",
						i, step, got.ConsecutiveFailures, expected.ConsecutiveFailures)
				}
				if got.ConsecutiveSuccesses != expected.ConsecutiveSuccesses {
					t.Fatalf("sequence %d step %d: SQL consecutive_successes = %d, NextHealth = %d",
						i, step, got.ConsecutiveSuccesses, expected.ConsecutiveSuccesses)
				}
				if expected.State == HealthOpen && got.ProbeAfter.IsZero() {
					t.Fatalf("sequence %d step %d: an open breaker with no probe_after is never probed again", i, step)
				}
				if expected.State == HealthHealthy && !got.ProbeAfter.IsZero() {
					t.Fatalf("sequence %d step %d: a healthy breaker still carries probe_after %s", i, step, got.ProbeAfter)
				}
			}
		})
	}
}

func TestBreakerSQLCooldownGrows(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()
	cfg := breakerCfg()

	mustExec(t, pool, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)

	var previous time.Duration
	for i := 1; i <= 8; i++ {
		_, h, err := store.RecordOutcome(ctx, f.endpointID, false, cfg, 1)
		if err != nil {
			t.Fatalf("failure %d: %v", i, err)
		}
		if h.State != HealthOpen {
			continue
		}
		cooldown := h.ProbeAfter.Sub(time.Now().UTC())
		if i > cfg.OpenThreshold && cooldown <= previous {
			t.Fatalf("failure %d: cooldown %s did not grow beyond %s; a dead endpoint would be probed as often as a flapping one",
				i, cooldown, previous)
		}
		if cooldown > cfg.MaxCooldown+time.Minute {
			t.Fatalf("failure %d: cooldown %s exceeded the cap %s", i, cooldown, cfg.MaxCooldown)
		}
		previous = cooldown
	}
}

// The no-thundering-herd property, against the real conditional UPDATE rather
// than the in-memory fake.
func TestClaimProbeAdmitsExactlyOneWorker(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	mustExec(t, pool, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)
	mustExec(t, pool, `INSERT INTO endpoint_health
	                     (endpoint_id, state, consecutive_failures, consecutive_successes,
	                      last_failure_at, opened_at, probe_after, updated_at)
	                   VALUES ($1, 'open', 5, 0, now(), now(), now() - interval '1 second', now())`,
		f.endpointID)

	const workers = 16
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		claimed int
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := store.ClaimProbe(ctx, f.endpointID, time.Minute)
			if err != nil {
				t.Errorf("claim probe: %v", err)
				return
			}
			if ok {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if claimed != 1 {
		t.Fatalf("%d of %d workers claimed the probe slot; every extra one is a request at an endpoint that just came back up", claimed, workers)
	}

	h, err := store.Health(ctx, f.endpointID)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if h.State != HealthHalfOpen {
		t.Fatalf("state = %s after a claimed probe, want half_open", h.State)
	}
	if !h.ProbeAfter.After(time.Now().UTC().Add(30 * time.Second)) {
		t.Fatalf("probe_after = %s; the slot must be held for its TTL so the next worker does not immediately take it", h.ProbeAfter)
	}
}

// A worker that dies mid-probe must not leave the endpoint permanently
// half_open and permanently undeliverable.
func TestClaimProbeRecoversFromACrashedProber(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	mustExec(t, pool, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)
	mustExec(t, pool, `INSERT INTO endpoint_health
	                     (endpoint_id, state, consecutive_failures, consecutive_successes,
	                      last_failure_at, opened_at, probe_after, updated_at)
	                   VALUES ($1, 'half_open', 5, 0, now(), now(), now() - interval '1 second', now())`,
		f.endpointID)

	ok, err := store.ClaimProbe(ctx, f.endpointID, time.Minute)
	if err != nil {
		t.Fatalf("claim probe: %v", err)
	}
	if !ok {
		t.Fatal("an expired half_open slot was not reclaimable; the endpoint would never be probed again")
	}
}

func TestHealthOfAnEndpointThatHasNeverFailed(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)

	h, err := store.Health(context.Background(), f.endpointID)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if h.State != HealthHealthy {
		t.Fatalf("state = %s with no endpoint_health row, want healthy", h.State)
	}
}
