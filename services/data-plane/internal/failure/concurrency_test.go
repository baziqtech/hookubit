package failure_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
)

// TestScenario17_TwoWorkersAttemptTheSameDelivery covers ARCHITECTURE.md 57
// case 17.
//
// Scenario: several workers poll the same ready set at the same instant. In a
// real deployment that is not an edge case, it is every 250ms of every day
// across eight worker pods (ADR-0005).
//
// Recovery strategy asserted: SELECT ... FOR UPDATE SKIP LOCKED inside the
// claiming UPDATE, plus the `locked_until IS NULL OR locked_until < now()`
// predicate, means a row is handed to exactly one worker. The test runs
// genuinely concurrent claimers on separate connection pools - separate pools
// because two goroutines sharing one pool can be serialised by the pool itself,
// which would make the test pass for a reason that has nothing to do with the
// query - and asserts that no delivery id is ever returned to two claimers.
//
// It is written to run under -race: the claimers share the result set through a
// mutex, so a torn read of the bookkeeping would be reported rather than
// silently making the assertion weaker.
//
// What a regression looks like in production: drop SKIP LOCKED (claims start
// blocking on each other and throughput collapses), or split the SELECT from
// the UPDATE into two statements (two workers read the same row and both
// deliver it, doubling every webhook under load). The second failure is the
// dangerous one - it looks like a customer's endpoint bug, and it only appears
// when there is enough traffic for the window to matter.
func TestScenario17_TwoWorkersAttemptTheSameDelivery(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)
	endpointID := f.newEndpoint(t, endpointOpts{noSecret: true})

	t.Run("eight claimers race for one delivery", func(t *testing.T) {
		resetQueue(t, pool)
		deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second})

		const claimers = 8
		pools := make([]*pgxpool.Pool, claimers)
		for i := range pools {
			pools[i] = separatePool(t)
		}

		var (
			mu      sync.Mutex
			winners []string
			start   = make(chan struct{})
			wg      sync.WaitGroup
		)
		for i := 0; i < claimers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				q := queue.NewPostgresQueue(pools[i], queue.StrategyFIFO)
				<-start
				leases, err := q.Claim(context.Background(), workerName(i), 5, time.Minute)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					t.Errorf("claimer %d: %v", i, err)
					return
				}
				for _, l := range leases {
					winners = append(winners, workerName(i)+"/"+l.Job.DeliveryID)
				}
			}(i)
		}
		close(start)
		wg.Wait()

		if len(winners) != 1 {
			t.Fatalf("%d claimers came back with the delivery (%v), want exactly 1: FOR UPDATE "+
				"SKIP LOCKED plus the lease predicate is what makes a claim exclusive", len(winners), winners)
		}
		state := readDelivery(t, pool, deliveryID)
		if state.Status != "processing" || state.LockedBy == nil {
			t.Fatalf("delivery = %q locked_by %v, want processing with an owner", state.Status, state.LockedBy)
		}
	})

	t.Run("concurrent claimers partition a backlog with no overlap", func(t *testing.T) {
		resetQueue(t, pool)

		const (
			backlog  = 60
			claimers = 6
		)
		want := make(map[string]bool, backlog)
		for i := 0; i < backlog; i++ {
			want[f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second})] = true
		}

		pools := make([]*pgxpool.Pool, claimers)
		for i := range pools {
			pools[i] = separatePool(t)
		}

		var (
			mu    sync.Mutex
			owner = make(map[string]string, backlog)
			wg    sync.WaitGroup
			start = make(chan struct{})
		)
		deadline := time.Now().Add(20 * time.Second)
		for i := 0; i < claimers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				q := queue.NewPostgresQueue(pools[i], queue.StrategyFIFO)
				id := workerName(i)
				<-start
				for time.Now().Before(deadline) {
					leases, err := q.Claim(context.Background(), id, 4, time.Minute)
					if err != nil {
						mu.Lock()
						t.Errorf("claimer %s: %v", id, err)
						mu.Unlock()
						return
					}
					mu.Lock()
					for _, l := range leases {
						if prev, seen := owner[l.Job.DeliveryID]; seen {
							t.Errorf("delivery %s was claimed twice: by %s and by %s",
								l.Job.DeliveryID, prev, id)
						}
						owner[l.Job.DeliveryID] = id
					}
					drained := len(owner) == backlog
					mu.Unlock()
					if drained {
						return
					}
				}
			}(i)
		}
		close(start)
		wg.Wait()

		mu.Lock()
		defer mu.Unlock()
		if len(owner) != backlog {
			t.Fatalf("claimed %d of %d deliveries; the ready set must drain completely", len(owner), backlog)
		}
		for id := range owner {
			if !want[id] {
				t.Fatalf("claimed a delivery this test never created: %s", id)
			}
		}
	})
}

func workerName(i int) string {
	return "wrk_racer_" + string(rune('a'+i))
}
