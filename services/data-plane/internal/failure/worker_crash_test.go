package failure_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/worker"
)

// crashOnCompleteStore is a worker.Store that performs every read faithfully
// and then dies at the one instant that is hardest to recover from: after the
// HTTP response has been received and before the result reaches the database.
//
// The abandoned write is the whole simulation. A process killed there leaves
// exactly this: a delivery row still `processing`, still leased, with no
// attempt row and an endpoint that has already been called.
type crashOnCompleteStore struct {
	inner worker.Store
	crash atomic.Bool
	calls atomic.Int64
}

var errSimulatedCrash = errors.New("simulated crash: the process died before the delivery result was written")

func (s *crashOnCompleteStore) Load(ctx context.Context, deliveryID string) (*worker.Job, error) {
	return s.inner.Load(ctx, deliveryID)
}

func (s *crashOnCompleteStore) Complete(
	ctx context.Context, workerID, deliveryID string, a *worker.AttemptRecord, next worker.Transition,
) error {
	s.calls.Add(1)
	if s.crash.Load() {
		return errSimulatedCrash
	}
	return s.inner.Complete(ctx, workerID, deliveryID, a, next)
}

func (s *crashOnCompleteStore) Defer(
	ctx context.Context, workerID, deliveryID string, next worker.Transition,
) error {
	return s.inner.Defer(ctx, workerID, deliveryID, next)
}

func (s *crashOnCompleteStore) LoadBudget(ctx context.Context, deliveryID string) (worker.Budget, error) {
	return s.inner.LoadBudget(ctx, deliveryID)
}

// claimOne polls until the given delivery becomes claimable by workerID, which
// is how "the lease expired and somebody else picked it up" is observed without
// any privileged database surgery.
func claimOne(t *testing.T, q *queue.PostgresQueue, workerID, deliveryID string, timeout time.Duration) queue.Lease {
	t.Helper()
	var got queue.Lease
	eventually(t, timeout, "delivery "+deliveryID+" to become claimable by "+workerID, func() bool {
		leases, err := q.Claim(context.Background(), workerID, 10, time.Minute)
		if err != nil {
			t.Fatalf("claim: %v", err)
		}
		for _, l := range leases {
			if l.Job.DeliveryID == deliveryID {
				got = l
				return true
			}
		}
		return false
	})
	return got
}

// ---------------------------------------------------------------------------
// scenario 3
// ---------------------------------------------------------------------------

// TestScenario03_WorkerCrashesBeforeDelivery covers ARCHITECTURE.md 57 case 3.
//
// Scenario: a worker claims a delivery and dies before it makes the HTTP call.
// The row is left `processing`, leased to a process that no longer exists.
//
// Recovery strategy asserted: the lease lapses and the ORDINARY claim query
// takes the row back - no scheduler, no repair job. Because no request was
// made, nothing may be charged for it: no delivery_attempts row exists and
// attempt_count is untouched, so the redelivery is attempt 1 with the full
// retry budget intact.
//
// What a regression looks like in production: increment attempt_count at claim
// time instead of at completion, or drop `processing` from the claim predicate.
// The first silently burns a customer's retry budget every time a worker pod is
// rescheduled; the second strands every delivery a crashed worker was holding
// in `processing` forever - never retried, never exhausted, never surfaced as
// failed.
func TestScenario03_WorkerCrashesBeforeDelivery(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})

	// The state a worker killed between claim and request leaves behind.
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{
		status:      "processing",
		lockedBy:    "wrk_crashed_before_request",
		lockedUntil: -time.Second,
		due:         -time.Second,
	})

	if got := readAttempts(t, pool, deliveryID); len(got) != 0 {
		t.Fatalf("precondition: %d attempt rows, want 0", len(got))
	}

	// --- the ordinary claim reclaims it, with no scheduler involved -------
	q := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	lease := claimOne(t, q, "wrk_reclaimer", deliveryID, 5*time.Second)
	if lease.Job.Attempt != 0 {
		t.Fatalf("reclaimed delivery reports attempt_count %d, want 0: the crashed worker never "+
			"made a request, so nothing may have been charged to the retry budget", lease.Job.Attempt)
	}
	state := readDelivery(t, pool, deliveryID)
	if state.LockedBy == nil || *state.LockedBy != "wrk_reclaimer" {
		t.Fatalf("locked_by = %v, want wrk_reclaimer", state.LockedBy)
	}
	if state.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d after reclaim, want 0", state.AttemptCount)
	}
	if got := readAttempts(t, pool, deliveryID); len(got) != 0 {
		t.Fatalf("reclaiming wrote %d attempt rows, want 0", len(got))
	}

	// Hand it back the way a worker that decides not to run it does.
	if err := q.Release(context.Background(), "wrk_reclaimer", deliveryID); err != nil {
		t.Fatalf("release: %v", err)
	}

	// --- and a real worker then delivers it as attempt 1 ------------------
	rig := newRig(t, pool, rigOpts{workerID: "wrk_recovery"})
	stop := rig.start(t)
	eventually(t, 15*time.Second, "the reclaimed delivery to succeed", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "succeeded"
	})
	stop()

	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 {
		t.Fatalf("attempt rows = %d, want exactly 1", len(attempts))
	}
	if attempts[0].Number != 1 {
		t.Fatalf("attempt number = %d, want 1: a crash before the request must not consume an attempt",
			attempts[0].Number)
	}
	if attempts[0].Status != "success" {
		t.Fatalf("attempt status = %q, want success", attempts[0].Status)
	}
	if n := endpoint.Requests(); n != 1 {
		t.Fatalf("the endpoint saw %d requests, want 1: the crash happened before any was made", n)
	}
	if final := readDelivery(t, pool, deliveryID); final.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want 1", final.AttemptCount)
	}
}

// ---------------------------------------------------------------------------
// scenario 4
// ---------------------------------------------------------------------------

// TestScenario04_WorkerCrashesDuringDelivery covers ARCHITECTURE.md 57 case 4.
//
// Scenario: a worker is mid-POST when it stops renewing - it hung, it was
// OOM-killed, its database round trips started failing. The lease lapses, a
// second worker reclaims the row and delivers, and only THEN does the first
// worker's request come back.
//
// Recovery strategy asserted, and it is two separate promises:
//   - the delivery is not lost. Another worker owns it and it reaches
//     `succeeded`.
//   - the delivery is not delivered twice IN THE LEDGER. queue.Renew reports
//     the lost id, LeaseKeeper cancels that attempt's context with cause
//     ErrLeaseLost, and the abandoned worker writes NOTHING - no attempt row,
//     no status transition.
//
// The endpoint genuinely sees two requests. That is at-least-once working as
// designed (ARCHITECTURE.md 20), and the Webhook-Delivery-Id header is what
// makes the duplicate detectable by an idempotent consumer.
//
// What a regression looks like in production: have Renew return only an error
// or a count instead of the lost ids, or let an attempt run on a context the
// keeper does not own. The abandoned worker then writes its own attempt row and
// its own terminal status, and whichever process commits last decides whether
// the customer's delivery "succeeded" - a delivery marked failed that the
// endpoint accepted, or the reverse, with no way to tell from the ledger.
func TestScenario04_WorkerCrashesDuringDelivery(t *testing.T) {
	pool := requirePool(t)
	other := separatePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	release := endpoint.blockUntil()
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL(), timeoutMS: 20000})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second})

	// Worker A, with a keeper the test can drive. Driving it explicitly is not
	// a shortcut around the ticker: it is how the renewal round that discovers
	// the loss is made to happen at a known instant instead of a random one.
	queueA := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	keeperA := queue.NewLeaseKeeper(queueA, "wrk_a", 30*time.Second, discardLogger())
	rigA := newRig(t, pool, rigOpts{workerID: "wrk_a", queue: queueA, keeper: keeperA, lease: 30 * time.Second})
	stopA := rigA.start(t)

	endpoint.waitForRequest(t, 15*time.Second)

	// --- worker A stops renewing; the lease lapses; worker B takes over ---
	expireLease(t, pool, deliveryID)
	queueB := queue.NewPostgresQueue(other, queue.StrategyFIFO)
	leases, err := queueB.Claim(context.Background(), "wrk_b", 5, time.Minute)
	if err != nil {
		t.Fatalf("worker B claim: %v", err)
	}
	if len(leases) != 1 || leases[0].Job.DeliveryID != deliveryID {
		t.Fatalf("worker B claimed %d rows, want the one delivery whose lease lapsed", len(leases))
	}

	// A's next renewal round is the moment it finds out.
	keeperA.RenewOnce(context.Background())
	release() // A's request would have completed here; its context is already dead

	eventually(t, 10*time.Second, "worker A to abandon its in-flight attempt", func() bool {
		return rigA.worker.InFlight() == 0
	})
	stopA()

	// --- the abandoned worker wrote nothing -------------------------------
	if got := readAttempts(t, pool, deliveryID); len(got) != 0 {
		t.Fatalf("the worker that lost its lease wrote %d attempt rows, want 0: recording them "+
			"races the new owner over the terminal status", len(got))
	}
	state := readDelivery(t, pool, deliveryID)
	if state.Status == "succeeded" {
		t.Fatal("the delivery was marked succeeded by a worker that no longer held its lease")
	}
	if state.LockedBy == nil || *state.LockedBy != "wrk_b" {
		t.Fatalf("locked_by = %v, want wrk_b: the row must belong to whoever reclaimed it", state.LockedBy)
	}
	if state.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d, want 0", state.AttemptCount)
	}
	if n := endpoint.Requests(); n != 1 {
		t.Fatalf("the endpoint saw %d requests before the redelivery, want 1", n)
	}

	// --- and the delivery is not lost: the new owner completes it ---------
	if err := queueB.Release(context.Background(), "wrk_b", deliveryID); err != nil {
		t.Fatalf("worker B release: %v", err)
	}
	rigC := newRig(t, pool, rigOpts{workerID: "wrk_c"})
	stopC := rigC.start(t)
	eventually(t, 15*time.Second, "the reclaimed delivery to succeed", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "succeeded"
	})
	stopC()

	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 || attempts[0].Number != 1 {
		t.Fatalf("attempt rows = %+v, want exactly one numbered 1", attempts)
	}
	if n := endpoint.Requests(); n != 2 {
		t.Fatalf("the endpoint saw %d requests, want 2: at-least-once means the aborted attempt "+
			"and the redelivery both reach it", n)
	}
}

// ---------------------------------------------------------------------------
// scenario 5
// ---------------------------------------------------------------------------

// TestScenario05_WorkerCrashesAfterResponseBeforeWrite covers ARCHITECTURE.md
// 57 case 5, the hardest one.
//
// Scenario: the endpoint accepted the webhook and answered 200. Before the
// worker could write the attempt row and the status transition, the process
// died. Nothing in the database knows the delivery happened.
//
// Recovery strategy asserted: there is no way to recover the lost knowledge, so
// the system must not pretend otherwise. What it must do is refuse to strand
// the row. The lease expires ON ITS OWN (this test waits it out rather than
// editing locked_until), the delivery becomes claimable again, and a second
// worker delivers it a SECOND time. The endpoint receives two requests carrying
// the same Webhook-Delivery-Id; the ledger records one attempt, because the
// first one was never written.
//
// The ledger under-reporting the real number of requests is a genuine
// consequence of at-least-once, not a defect: the alternative is writing the
// attempt before the request, which would make the ledger claim deliveries that
// never left the process.
//
// What a regression looks like in production: leave `processing` out of the
// claim predicate, or make the lease effectively infinite, and this delivery is
// stuck forever - the operator UI shows it in flight, no retry is ever made and
// no alert fires, because from the platform's point of view a worker is still
// working on it.
func TestScenario05_WorkerCrashesAfterResponseBeforeWrite(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)

	endpoint := newTestEndpoint(t)
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL()})
	deliveryID := f.newDelivery(t, endpointID, deliveryOpts{due: -time.Second})

	// A short lease so "the lease expires" is a real wait rather than an
	// UPDATE. It is the one place in this suite where waiting is the point.
	const shortLease = 2 * time.Second

	crashStore := &crashOnCompleteStore{inner: worker.NewPostgresStore(pool)}
	crashStore.crash.Store(true)
	rigA := newRig(t, pool, rigOpts{workerID: "wrk_dies_after_response", store: crashStore, lease: shortLease})
	stopA := rigA.start(t)

	endpoint.waitForRequest(t, 15*time.Second)
	eventually(t, 10*time.Second, "the worker to reach its (crashing) database write", func() bool {
		return crashStore.calls.Load() >= 1
	})
	stopA()

	// --- the row is exactly what a killed process leaves ------------------
	state := readDelivery(t, pool, deliveryID)
	if state.Status != "processing" {
		t.Fatalf("status = %q, want processing: the crash happened before any transition", state.Status)
	}
	if state.LockedBy == nil || *state.LockedBy != "wrk_dies_after_response" {
		t.Fatalf("locked_by = %v, want the dead worker", state.LockedBy)
	}
	if state.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d, want 0: the write that would have set it never happened", state.AttemptCount)
	}
	if got := readAttempts(t, pool, deliveryID); len(got) != 0 {
		t.Fatalf("attempt rows = %d, want 0", len(got))
	}
	if n := endpoint.Requests(); n != 1 {
		t.Fatalf("the endpoint saw %d requests, want 1", n)
	}

	// --- not stuck: the lease lapses and the row is claimable again -------
	q := queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	lease := claimOne(t, q, "wrk_after_crash", deliveryID, 4*shortLease)
	if lease.Job.Attempt != 0 {
		t.Fatalf("reclaimed with attempt_count %d, want 0", lease.Job.Attempt)
	}
	if err := q.Release(context.Background(), "wrk_after_crash", deliveryID); err != nil {
		t.Fatalf("release: %v", err)
	}

	// --- at-least-once: the second attempt is a second delivery -----------
	rigB := newRig(t, pool, rigOpts{workerID: "wrk_redelivers"})
	stopB := rigB.start(t)
	eventually(t, 15*time.Second, "the redelivery to succeed", func() bool {
		return readDelivery(t, pool, deliveryID).Status == "succeeded"
	})
	stopB()

	if n := endpoint.Requests(); n != 2 {
		t.Fatalf("the endpoint saw %d requests, want 2: the delivery it already accepted is sent again, "+
			"which is what at-least-once means and why consumers must be idempotent", n)
	}
	attempts := readAttempts(t, pool, deliveryID)
	if len(attempts) != 1 || attempts[0].Number != 1 || attempts[0].Status != "success" {
		t.Fatalf("attempt rows = %+v, want exactly one successful attempt numbered 1", attempts)
	}
	final := readDelivery(t, pool, deliveryID)
	if final.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want 1", final.AttemptCount)
	}
	if final.CompletedAt == nil {
		t.Fatal("completed_at is null on a succeeded delivery")
	}
}
