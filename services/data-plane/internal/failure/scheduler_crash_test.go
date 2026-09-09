package failure_test

import (
	"context"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
)

// runSchedulerSweep mirrors the body of runScheduler in cmd/webhookd/roles.go:
// a ticker whose only job is to call ReclaimExpired. It is reproduced here
// rather than imported because roles.go lives in package main; the statement it
// runs is the production one, on the production type.
func runSchedulerSweep(ctx context.Context, q *queue.PostgresQueue, interval time.Duration, swept chan<- int64) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n, err := q.ReclaimExpired(ctx)
			if err != nil {
				return
			}
			select {
			case swept <- n:
			default:
			}
		}
	}
}

// TestScenario06_SchedulerCrashes covers ARCHITECTURE.md 57 case 6.
//
// Scenario: the scheduler process dies. It is a singleton (ADR-0005), so there
// is no second one to take over.
//
// Recovery strategy asserted, in three parts:
//   - nothing is lost while it is down. The scheduler holds no state of its
//     own; every row it would have touched is still in PostgreSQL, unchanged.
//   - deliveries keep moving without it. queue.Claim treats an expired lease as
//     ready, so a worker recovers an abandoned delivery with no sweep at all -
//     the scheduler is an efficiency and observability role, not a correctness
//     dependency.
//   - a restart resumes. A brand-new PostgresQueue, with none of the dead
//     process's memory, sweeps the backlog on its first tick.
//
// What a regression looks like in production: make ReclaimExpired the ONLY path
// back into the ready set - which is what happens the moment `processing` is
// dropped from claimStatuses - and a scheduler outage stops being an
// inconvenience. Every delivery held by a worker that restarts during the
// outage sits in `processing` until a human notices, which they will not,
// because a stuck delivery raises no error and completes no metric.
func TestScenario06_SchedulerCrashes(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpointID := f.newEndpoint(t, endpointOpts{noSecret: true})

	const abandoned = 5
	deliveryIDs := make([]string, 0, abandoned)
	for i := 0; i < abandoned; i++ {
		deliveryIDs = append(deliveryIDs, f.newDelivery(t, endpointID, deliveryOpts{
			status:      "processing",
			lockedBy:    "wrk_dead",
			lockedUntil: -time.Second,
			due:         -time.Second,
		}))
	}

	// --- the scheduler dies before its first sweep ------------------------
	q := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	ctx, cancel := context.WithCancel(context.Background())
	swept := make(chan int64, 4)
	done := make(chan struct{})
	go func() { defer close(done); runSchedulerSweep(ctx, q, time.Hour, swept) }()
	cancel()
	<-done

	for _, id := range deliveryIDs {
		state := readDelivery(t, pool, id)
		if state.Status != "processing" || state.LockedBy == nil || *state.LockedBy != "wrk_dead" {
			t.Fatalf("delivery %s = %q locked_by %v; a dead scheduler must change nothing",
				id, state.Status, state.LockedBy)
		}
		if state.AttemptCount != 0 {
			t.Fatalf("delivery %s attempt_count = %d, want 0", id, state.AttemptCount)
		}
	}
	if got := countRows(t, pool, `SELECT count(*) FROM deliveries WHERE project_id = $1`, f.projectID); got != abandoned {
		t.Fatalf("deliveries = %d, want %d: nothing may be lost while the scheduler is down", got, abandoned)
	}

	// --- work still moves with no scheduler at all ------------------------
	workerQueue := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	leases, err := workerQueue.Claim(context.Background(), "wrk_live", 1, time.Minute)
	if err != nil {
		t.Fatalf("claim while the scheduler is down: %v", err)
	}
	if len(leases) != 1 {
		t.Fatalf("claimed %d deliveries with the scheduler down, want 1: the sweep is not on the "+
			"critical path, the claim predicate is", len(leases))
	}
	recovered := leases[0].Job.DeliveryID
	if err := workerQueue.Release(context.Background(), "wrk_live", recovered); err != nil {
		t.Fatalf("release: %v", err)
	}

	// --- restart: a fresh process sweeps the rest -------------------------
	restarted := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	n, err := restarted.ReclaimExpired(context.Background())
	if err != nil {
		t.Fatalf("ReclaimExpired after restart: %v", err)
	}
	if n != abandoned-1 {
		t.Fatalf("reclaimed %d rows on restart, want %d (one had already been recovered by a worker)",
			n, abandoned-1)
	}

	for _, id := range deliveryIDs {
		state := readDelivery(t, pool, id)
		if state.Status != "pending" {
			t.Fatalf("delivery %s status = %q after the restart sweep, want pending", id, state.Status)
		}
		if state.LockedBy != nil || state.LockedUntil != nil {
			t.Fatalf("delivery %s still carries a lease (%v / %v) after being reclaimed",
				id, state.LockedBy, state.LockedUntil)
		}
		if state.AttemptCount != 0 {
			t.Fatalf("delivery %s attempt_count = %d, want 0: a sweep must not spend retry budget",
				id, state.AttemptCount)
		}
		if got := readAttempts(t, pool, id); len(got) != 0 {
			t.Fatalf("delivery %s gained %d attempt rows from a sweep", id, len(got))
		}
	}
}
