package queue

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
)

// LeaseKeeper holds a worker's leases open while attempts are in flight, and -
// the part that matters - tears an attempt down the moment its lease is gone.
//
// The failure this exists for is not "a slow endpoint". It is this:
//
//	worker A claims delivery D and starts a 30s POST
//	a database failover eats A's renewal round
//	D's lease expires; the scheduler reclaims it; worker B claims and delivers
//	A's POST finally returns
//
// If A now writes its delivery_attempts row and its status transition, the
// endpoint has received the webhook twice and the terminal status of D is
// whichever of A and B committed last. Renew reporting the lost id is what lets
// A find out; cancelling the attempt context is what makes A act on it.
//
// Cancellation is delivered as context cancellation with ErrLeaseLost as the
// cause, so the attempt aborts wherever it happens to be - mid-dial, mid-read -
// and the bookkeeping that follows can distinguish "lost the lease" from "the
// endpoint timed out" by checking context.Cause.
type LeaseKeeper struct {
	queue    Queue
	workerID string
	lease    time.Duration
	interval time.Duration
	log      *slog.Logger

	mu      sync.Mutex
	tracked map[string]context.CancelCauseFunc
}

// NewLeaseKeeper builds a keeper for one worker process. The renewal interval
// is a third of the lease, so a single missed round is recoverable and two are
// not fatal until the lease genuinely lapses.
func NewLeaseKeeper(q Queue, workerID string, lease time.Duration, log *slog.Logger) *LeaseKeeper {
	interval := lease / 3
	if interval <= 0 {
		interval = time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &LeaseKeeper{
		queue:    q,
		workerID: workerID,
		lease:    lease,
		interval: interval,
		log:      log,
		tracked:  make(map[string]context.CancelCauseFunc),
	}
}

// Track registers an in-flight delivery and returns the context its attempt
// must run under, plus a done func to call when the attempt finishes. The
// returned context is cancelled with cause ErrLeaseLost if the lease is lost.
//
// Callers must run every part of the attempt under this context - the HTTP
// request and the writes that follow it - or cancellation buys nothing.
func (k *LeaseKeeper) Track(parent context.Context, deliveryID string) (context.Context, func()) {
	ctx, cancel := context.WithCancelCause(parent)

	k.mu.Lock()
	k.tracked[deliveryID] = cancel
	k.mu.Unlock()

	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			k.mu.Lock()
			delete(k.tracked, deliveryID)
			k.mu.Unlock()
			cancel(context.Canceled)
		})
	}
}

// Tracked reports how many attempts are currently held open.
func (k *LeaseKeeper) Tracked() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.tracked)
}

// Run renews on a ticker until ctx is cancelled. Every tracked attempt is
// cancelled on the way out so a shutdown does not leave a goroutine believing
// it still holds a lease nobody is renewing.
//
// The cancellation cause is INHERITED from ctx rather than hard-coded, and that
// matters: the worker passes the same context here that it uses as the parent of
// every tracked attempt, so on shutdown two goroutines race to cancel the same
// children - the worker with ErrWorkerShutdown, and this defer as Run unwinds.
// context.CancelFunc is first-writer-wins, so a hard-coded context.Canceled
// here silently won a fraction of those races, and the delivery was then charged
// an attempt and a health failure for OUR restart. Inheriting means both racers
// set the same cause and the winner stops mattering.
func (k *LeaseKeeper) Run(ctx context.Context) error {
	ticker := time.NewTicker(k.interval)
	defer ticker.Stop()
	defer func() {
		cause := context.Cause(ctx)
		if cause == nil {
			// Run returned for a reason other than ctx: there is no inherited
			// cause to pass on.
			cause = context.Canceled
		}
		k.cancelAll(cause)
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			k.RenewOnce(ctx)
		}
	}
}

// RenewOnce performs a single renewal round. Exported so the worker loop can
// force one at a decision point, and so this is testable without a clock.
func (k *LeaseKeeper) RenewOnce(ctx context.Context) {
	k.mu.Lock()
	ids := make([]string, 0, len(k.tracked))
	for id := range k.tracked {
		ids = append(ids, id)
	}
	k.mu.Unlock()

	if len(ids) == 0 {
		return
	}

	lost, err := k.queue.Renew(ctx, k.workerID, ids, k.lease)
	if err != nil {
		// A failed renewal is not a lost lease: we do not know either way, and
		// the lease has not expired yet. Keep the attempts running and try
		// again next tick - if the database really is gone, the lease lapses on
		// its own and the next round returns them as lost.
		k.log.Warn("renew leases failed", "worker_id", k.workerID, "count", len(ids), "error", err)
		return
	}
	for _, id := range lost {
		k.Abandon(id)
	}
}

// Abandon cancels one in-flight attempt because its lease is no longer ours.
// Safe to call for an id that is not tracked.
func (k *LeaseKeeper) Abandon(deliveryID string) {
	k.mu.Lock()
	cancel, ok := k.tracked[deliveryID]
	delete(k.tracked, deliveryID)
	k.mu.Unlock()
	if !ok {
		return
	}

	metrics.LeasesLost.WithLabelValues("renew").Inc()
	k.log.Warn("lease lost; abandoning in-flight attempt",
		"worker_id", k.workerID,
		"delivery_id", deliveryID,
		"reason", "another worker owns this delivery now; recording an attempt would duplicate it")
	cancel(ErrLeaseLost)
}

func (k *LeaseKeeper) cancelAll(cause error) {
	k.mu.Lock()
	tracked := k.tracked
	k.tracked = make(map[string]context.CancelCauseFunc)
	k.mu.Unlock()
	for _, cancel := range tracked {
		cancel(cause)
	}
}
