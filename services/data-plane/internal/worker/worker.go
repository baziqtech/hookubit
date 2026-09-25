package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/egress"
	"github.com/shaq/hookubit/services/data-plane/internal/metrics"
	"github.com/shaq/hookubit/services/data-plane/internal/payloadstore"
	"github.com/shaq/hookubit/services/data-plane/internal/queue"
)

// DrainTimeout is how long in-flight attempts are given to finish on shutdown
// before their contexts are cancelled (ARCHITECTURE.md 47). It must stay at or
// below the role-drain share of config.ShutdownGrace, or the process is killed
// mid-write with attempts unrecorded.
const DrainTimeout = 15 * time.Second

// DefaultMaxStoredResponseBytes bounds what of a response body reaches the
// ledger. The egress client already caps what is read from the wire; this caps
// what is kept forever.
const DefaultMaxStoredResponseBytes = 8 << 10

// occupancySampleInterval is how often the concurrency gauges are refreshed.
//
// A constant rather than a knob, for the same reason queueDepthInterval is one:
// the cost is a handful of mutex acquisitions and is the same for every
// deployment, and five seconds is well inside any useful scrape interval while
// still being short enough to catch the burst the gauges exist to show.
//
// It is sampled on a ticker rather than written on the acquire path on purpose.
// Setting a labelled gauge is a map lookup plus an atomic; doing that four
// times per acquire and four times per release puts metric bookkeeping on the
// hottest path in the process to gain resolution nothing scrapes.
const occupancySampleInterval = 5 * time.Second

// HTTPDoer is the egress client, as an interface so the delivery path can be
// tested against an httptest server without the real transport, and so a future
// per-endpoint client (different timeouts) is a substitution rather than a
// rewrite. *egress.Client satisfies it.
type HTTPDoer interface {
	Do(ctx context.Context, method, rawURL string, headers http.Header, body []byte) (*egress.Response, error)
}

// Options configures a Worker. Everything with a sensible default has one;
// everything that cannot have one is validated in New.
type Options struct {
	Queue   queue.Queue
	Store   Store
	Health  HealthStore
	Client  HTTPDoer
	Keyring *Keyring

	// Payloads reads offloaded payloads (ARCHITECTURE.md 32). Nil is legal and
	// means this deployment stores every payload inline; a delivery that then
	// meets a payload_location DEFERS rather than failing, because the fix is
	// a configuration change and the delivery is still perfectly good.
	Payloads PayloadFetcher

	// Limiter defaults to an in-process token bucket. Swap in the Redis
	// implementation when it exists; it must fail open.
	Limiter RateLimiter
	// Gate defaults to one built from Limits.
	Gate   *Gate
	Limits GateLimits

	Breaker BreakerConfig

	WorkerID     string
	Concurrency  int
	ClaimBatch   int
	PollInterval time.Duration
	Lease        time.Duration
	DBTimeout    time.Duration
	// PayloadTimeout bounds ONE object-storage fetch, including the store's own
	// internal retries. It is SEPARATE from DBTimeout on purpose: the two are
	// configured by different knobs (PAYLOAD_DOWNLOAD_TIMEOUT_MS and
	// INGEST_DB_TIMEOUT_MS) and bound different resources, and running the
	// object fetch on the database budget silently truncated any download
	// timeout an operator set above it.
	PayloadTimeout time.Duration

	MaxStoredResponseBytes int

	Logger *slog.Logger
	Now    func() time.Time
	// Seed fixes the jitter source for tests. Zero seeds from the clock.
	Seed int64
	// Keeper is injectable for tests. Nil builds one over Queue.
	Keeper *queue.LeaseKeeper
}

// Worker leases deliveries and performs them.
//
// Its shape is dictated by one requirement (ARCHITECTURE.md 24): a slow
// endpoint must never consume the pool. Two things enforce it and they are
// easy to break by accident.
//
//  1. The pool is BOUNDED and the claim is sized to the free slots. The worker
//     never claims work it has nowhere to run - claiming 100 rows into 4 free
//     slots would leave 96 leases held by a process that will not touch them
//     for minutes.
//  2. Every ceiling is checked with a NON-BLOCKING acquire and a refusal DEFERS
//     the delivery. Blocking on a full endpoint semaphore would park goroutines
//     in front of the slow endpoint, which is the starvation this design exists
//     to prevent, reintroduced one `<-ch` at a time.
type Worker struct {
	queue    queue.Queue
	store    Store
	client   HTTPDoer
	breaker  *Breaker
	limiter  RateLimiter
	gate     *Gate
	keyring  *Keyring
	keeper   *queue.LeaseKeeper
	payloads PayloadFetcher

	workerID        string
	concurrency     int
	claimBatch      int
	pollInterval    time.Duration
	lease           time.Duration
	dbTimeout       time.Duration
	payloadTimeout  time.Duration
	endpointCeiling int
	maxStoredBody   int

	// gateWatch decides when a delivery that keeps losing at the tenant
	// concurrency gate has earned a budget read. See tenantGateWatch.
	gateWatch *tenantGateWatch

	log *slog.Logger
	now func() time.Time
	rng *lockedRand

	inFlight atomic.Int64
}

// New validates the options and builds a worker.
func New(opts Options) (*Worker, error) {
	switch {
	case opts.Queue == nil:
		return nil, errors.New("worker: a queue is required")
	case opts.Store == nil:
		return nil, errors.New("worker: a store is required")
	case opts.Health == nil:
		return nil, errors.New("worker: a health store is required")
	case opts.Client == nil:
		return nil, errors.New("worker: an egress client is required")
	case opts.Keyring == nil:
		// Without the keyring no secret can be decrypted, so every delivery
		// would fail to sign - and fail closed, one recorded attempt at a
		// time. Refusing to start is the honest failure.
		return nil, errors.New("worker: an encryption keyring is required to read endpoint signing secrets")
	case opts.WorkerID == "":
		return nil, errors.New("worker: a worker id is required; it is what a lease is held by")
	}

	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		// config.Load already refuses a non-positive WORKER_CONCURRENCY;
		// this is the belt to that braces, because an unbounded pool is the
		// one thing engineering rule 29 will not tolerate.
		concurrency = 1
	}
	claimBatch := opts.ClaimBatch
	if claimBatch <= 0 {
		claimBatch = concurrency
	}
	pollInterval := opts.PollInterval
	if pollInterval <= 0 {
		pollInterval = 250 * time.Millisecond
	}
	lease := opts.Lease
	if lease <= 0 {
		lease = 2 * time.Minute
	}
	dbTimeout := opts.DBTimeout
	if dbTimeout <= 0 {
		dbTimeout = 10 * time.Second
	}
	payloadTimeout := opts.PayloadTimeout
	if payloadTimeout <= 0 {
		payloadTimeout = payloadstore.DefaultDownloadTimeout
	}
	maxBody := opts.MaxStoredResponseBytes
	if maxBody <= 0 {
		maxBody = DefaultMaxStoredResponseBytes
	}
	limits := opts.Limits
	if limits.Global <= 0 {
		limits.Global = concurrency
	}
	gate := opts.Gate
	if gate == nil {
		gate = NewGate(limits)
	}
	limiter := opts.Limiter
	if limiter == nil {
		limiter = NewTokenBucket(now)
	}
	keeper := opts.Keeper
	if keeper == nil {
		keeper = queue.NewLeaseKeeper(opts.Queue, opts.WorkerID, lease, log)
	}
	rng := newLockedRand(opts.Seed)

	return &Worker{
		queue:           opts.Queue,
		store:           opts.Store,
		client:          opts.Client,
		breaker:         NewBreaker(opts.Health, opts.Breaker, now, rng, log),
		limiter:         limiter,
		gate:            gate,
		keyring:         opts.Keyring,
		keeper:          keeper,
		payloads:        opts.Payloads,
		workerID:        opts.WorkerID,
		concurrency:     concurrency,
		claimBatch:      claimBatch,
		pollInterval:    pollInterval,
		lease:           lease,
		dbTimeout:       dbTimeout,
		payloadTimeout:  payloadTimeout,
		endpointCeiling: limits.Endpoint,
		maxStoredBody:   maxBody,
		gateWatch:       newTenantGateWatch(tenantGateBudgetCheckAfter, tenantGateWatchCapacity),
		log:             log,
		now:             now,
		rng:             rng,
	}, nil
}

// Run polls, claims and delivers until ctx is cancelled.
//
// Shutdown is a drain, not a kill (ARCHITECTURE.md 47). On cancellation the
// worker stops CLAIMING immediately but lets in-flight attempts finish, and the
// lease keeper keeps renewing their leases while they do - so a delivery that
// is mid-flight when SIGTERM lands is completed and recorded rather than
// abandoned to a lease expiry and re-delivered by the next pod. Attempts still
// running when the drain window closes are cancelled; their bookkeeping runs on
// a detached context so the ledger still learns what happened.
func (w *Worker) Run(ctx context.Context) error {
	// Attempts hang off a context this function owns, NOT off ctx, so that
	// cancelling ctx stops the claim loop without instantly killing work in
	// flight. The keeper runs on it too: it must keep renewing during the
	// drain, or the leases of the deliveries we are finishing lapse underneath
	// us and another pod re-delivers them.
	//
	// The cancellation carries a CAUSE (ErrWorkerShutdown). Without one an
	// attempt cut short by the drain window closing fails with a bare
	// context.Canceled, which is indistinguishable from any other transport
	// fault: it is classified as a retryable network error, written to
	// delivery_attempts with the message "context canceled", and charged to the
	// customer's endpoint as a failed attempt. Our restart is not their outage.
	attemptRoot, cancelAttempts := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancelAttempts(ErrWorkerShutdown)

	// The pool ceiling is published once and never changes: it is the REAL
	// bound on in-flight attempts in this process, and at the shipped defaults
	// it sits eight times BELOW MAX_CONCURRENCY_GLOBAL - so the gate that reads
	// as the process ceiling can never bind and this is the number to alarm on.
	// See docs/FAILURE_RECOVERY.md, G13.
	metrics.WorkerPoolSlotsCapacity.Set(float64(w.concurrency))
	w.publishOccupancy()

	var keeperWG sync.WaitGroup
	keeperWG.Add(1)
	go func() {
		defer keeperWG.Done()
		if err := w.keeper.Run(attemptRoot); err != nil && attemptRoot.Err() == nil {
			w.log.Error("lease keeper stopped", "error", err)
		}
	}()

	w.log.Info("delivery worker started",
		"worker_id", w.workerID,
		"concurrency", w.concurrency,
		"claim_batch", w.claimBatch,
		"poll_interval", w.pollInterval,
		"lease", w.lease,
		"encryption_key_ids", w.keyring.KeyIDs(),
	)

	var wg sync.WaitGroup
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	occupancy := time.NewTicker(occupancySampleInterval)
	defer occupancy.Stop()

	for {
		select {
		case <-ctx.Done():
			w.drain(&wg, cancelAttempts)
			keeperWG.Wait()
			// One last reading, after the drain, so the gauges settle at the
			// truth rather than freezing at whatever the last sample said and
			// leaving a dashboard showing a dead pod holding slots.
			w.publishOccupancy()
			return ctx.Err()
		case <-occupancy.C:
			w.publishOccupancy()
		case <-ticker.C:
			w.poll(ctx, attemptRoot, &wg)
		}
	}
}

// publishOccupancy refreshes the pool and gate gauges (G13).
//
// This is the answer to "who is eating the pool", which nothing could answer
// before: rate_limit_hits_total counts refusals, and a refusal tells you
// something was turned away, not what was holding the capacity. The label set
// is the four gate scopes and nothing else - no endpoint id, no project id, no
// organisation id. An unbounded label set on a busy platform is its own
// outage, and the per-key question is answered by the busiest-key gauge with
// the key left out.
func (w *Worker) publishOccupancy() {
	metrics.WorkerPoolSlotsInUse.Set(float64(w.inFlight.Load()))
	for scope, o := range w.gate.Occupancy() {
		metrics.GateSlotsInUse.WithLabelValues(scope).Set(float64(o.InUse))
		metrics.GateSlotsCapacity.WithLabelValues(scope).Set(float64(o.Capacity))
		metrics.GateKeysActive.WithLabelValues(scope).Set(float64(o.Keys))
		metrics.GateBusiestKeySlots.WithLabelValues(scope).Set(float64(o.BusiestKey))
	}
}

// poll claims at most as many deliveries as there are free slots.
func (w *Worker) poll(claimCtx, attemptRoot context.Context, wg *sync.WaitGroup) {
	free := w.concurrency - int(w.inFlight.Load())
	if free <= 0 {
		return
	}
	limit := w.claimBatch
	if limit > free {
		limit = free
	}

	ctx, cancel := context.WithTimeout(claimCtx, w.dbTimeout)
	leases, err := w.queue.Claim(ctx, w.workerID, limit, w.lease)
	cancel()
	if err != nil {
		if claimCtx.Err() == nil {
			w.log.Error("claim deliveries failed", "error", err)
		}
		return
	}

	for _, lease := range leases {
		w.inFlight.Add(1)
		wg.Add(1)
		go func(l queue.Lease) {
			defer wg.Done()
			defer w.inFlight.Add(-1)
			w.handle(attemptRoot, l)
		}(lease)
	}
}

// drain waits for in-flight attempts, then cancels whatever is left.
func (w *Worker) drain(wg *sync.WaitGroup, cancelAttempts context.CancelCauseFunc) {
	inFlight := int(w.inFlight.Load())
	if inFlight == 0 {
		cancelAttempts(ErrWorkerShutdown)
		return
	}
	w.log.Info("draining in-flight deliveries",
		"worker_id", w.workerID, "in_flight", inFlight, "drain_timeout", DrainTimeout)

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	timer := time.NewTimer(DrainTimeout)
	defer timer.Stop()
	select {
	case <-done:
		w.log.Info("all in-flight deliveries finished", "worker_id", w.workerID)
	case <-timer.C:
		w.log.Warn("drain window expired; cancelling in-flight attempts",
			"worker_id", w.workerID,
			"in_flight", w.inFlight.Load(),
			"reason", "they are put back for another worker without being charged an attempt; the endpoint may see a duplicate")
	}
	cancelAttempts(ErrWorkerShutdown)
	<-done
}

// InFlight reports how many deliveries this worker is currently attempting.
func (w *Worker) InFlight() int { return int(w.inFlight.Load()) }

// decide runs the state machine under the jitter lock.
func (l *lockedRand) decide(in DecisionInput) Decision {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Decide(in, l.r)
}

// String makes a Worker printable in a log without dumping its collaborators.
func (w *Worker) String() string {
	return fmt.Sprintf("worker(%s, concurrency=%d)", w.workerID, w.concurrency)
}
