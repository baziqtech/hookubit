package router

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
)

// ErrLeaseLost reports that an outbox row this router believed it held is no
// longer its own. It is not a transport failure and retrying will not recover
// the lease: another router owns the row and will do the work.
var ErrLeaseLost = errors.New("router: outbox lease is no longer held by this router")

// Defaults. Every one of these is a bound, and every bound is here rather than
// implicit (engineering rule 11).
const (
	// DefaultBatchSize is how many outbox rows one poll leases.
	DefaultBatchSize = 200
	// DefaultConcurrency is how many events are fanned out at once. Each holds
	// one pooled connection for the length of its transaction, so this must
	// stay well under DATABASE_MAX_CONNECTIONS.
	DefaultConcurrency = 4
	// DefaultLease is how long a claimed row is ours. It bounds how long a
	// crashed router's rows are stuck, so it should be a small multiple of the
	// worst-case fan-out transaction, not of the poll interval.
	DefaultLease = 60 * time.Second
	// DefaultMaxSubscriptionsPerEvent bounds both the subscriptions examined
	// and the deliveries created for one event. Materialised fan-out is cheap
	// at 10 subscribers and expensive at 10,000; this is the ceiling that keeps
	// one misconfigured project from writing an unbounded batch inside a single
	// transaction.
	DefaultMaxSubscriptionsPerEvent = 2000
	// DefaultMaxOutboxAttempts is the poison bound. A row that has been claimed
	// this many times without ever committing is parked rather than left to
	// cycle: a queue that a single bad row can block forever is a queue that
	// stops during exactly the incident you need it for.
	DefaultMaxOutboxAttempts = 5
	// DefaultLagInterval throttles the outbox-lag gauge. The poll interval is
	// 250ms by default and the lag query is an aggregate; refreshing it every
	// poll would cost more than the work it measures.
	DefaultLagInterval = time.Second
)

// Options configures a Router.
type Options struct {
	Store    Store
	RouterID string
	Logger   *slog.Logger

	BatchSize                int
	Concurrency              int
	Lease                    time.Duration
	MaxSubscriptionsPerEvent int
	MaxOutboxAttempts        int
	LagInterval              time.Duration

	// RetryBackoff schedules a released row's next attempt. It reuses
	// retry.Policy so the outbox and the delivery loop back off the same way,
	// including the overflow clamping that policy already got right.
	RetryBackoff retry.Policy
}

// Router drains event_outbox and materialises the fan-out (ARCHITECTURE.md 18).
//
// It is safe to run many of these concurrently, in one process or across
// several: rows are leased with FOR UPDATE SKIP LOCKED, and every write is
// guarded on still holding that lease.
type Router struct {
	opts Options

	// rng is not goroutine-safe and backoff is computed from worker goroutines.
	rngMu sync.Mutex
	rng   *rand.Rand

	lagMu   sync.Mutex
	lastLag time.Time
}

// New builds a Router, filling in defaults for anything unset.
func New(opts Options) (*Router, error) {
	if opts.Store == nil {
		return nil, fmt.Errorf("router: Store is required")
	}
	if opts.RouterID == "" {
		return nil, fmt.Errorf("router: RouterID is required; it is the lease owner")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = DefaultBatchSize
	}
	if opts.Concurrency <= 0 {
		opts.Concurrency = DefaultConcurrency
	}
	if opts.Lease <= 0 {
		opts.Lease = DefaultLease
	}
	if opts.MaxSubscriptionsPerEvent <= 0 {
		opts.MaxSubscriptionsPerEvent = DefaultMaxSubscriptionsPerEvent
	}
	if opts.MaxOutboxAttempts <= 0 {
		opts.MaxOutboxAttempts = DefaultMaxOutboxAttempts
	}
	if opts.LagInterval <= 0 {
		opts.LagInterval = DefaultLagInterval
	}
	if opts.RetryBackoff.MaxAttempts == 0 && opts.RetryBackoff.InitialDelay == 0 {
		opts.RetryBackoff = DefaultOutboxBackoff()
	}
	return &Router{
		opts: opts,
		rng:  rand.New(rand.NewSource(time.Now().UnixNano())),
	}, nil
}

// DefaultOutboxBackoff is the release schedule for a transiently failing outbox
// row: seconds, not the hours a delivery retry may wait. The failures this
// backs off from are database-side (a lock wait, a failover, an exhausted
// pool), and they resolve on a human-visible timescale.
func DefaultOutboxBackoff() retry.Policy {
	return retry.Policy{
		Strategy:     "exponential",
		MaxAttempts:  DefaultMaxOutboxAttempts,
		InitialDelay: time.Second,
		MaxDelay:     time.Minute,
		Multiplier:   2,
		JitterRatio:  0.2,
	}
}

// Run polls until ctx is cancelled. A failed poll is logged and retried on the
// next tick rather than killing the role: the outbox is durable, so falling
// behind costs time, not data.
func (r *Router) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	r.opts.Logger.Info("router started",
		"router_id", r.opts.RouterID,
		"batch_size", r.opts.BatchSize,
		"concurrency", r.opts.Concurrency,
		"lease", r.opts.Lease.String(),
		"max_subscriptions_per_event", r.opts.MaxSubscriptionsPerEvent,
		"max_outbox_attempts", r.opts.MaxOutboxAttempts)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if _, err := r.RunOnce(ctx); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				r.opts.Logger.Error("outbox poll failed", "error", err)
			}
		}
	}
}

// RunOnce claims one batch and fans it out. It returns the number of outbox
// rows processed, which lets a caller drain eagerly (keep calling while the
// count equals the batch size) instead of waiting a tick per batch.
func (r *Router) RunOnce(ctx context.Context) (int, error) {
	rows, err := r.opts.Store.ClaimOutbox(ctx, r.opts.RouterID, r.opts.BatchSize, r.opts.Lease)
	if err != nil {
		return 0, err
	}
	r.observeLag(ctx)
	if len(rows) == 0 {
		return 0, nil
	}
	OutboxClaimed.Add(float64(len(rows)))

	sem := make(chan struct{}, r.opts.Concurrency)
	var wg sync.WaitGroup
	for _, row := range rows {
		if ctx.Err() != nil {
			// Shutting down. Rows already claimed are left leased; the lease
			// lapses and another router - or this one after a restart - reclaims
			// them. Nothing is lost because nothing was committed.
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(row OutboxRow) {
			defer wg.Done()
			defer func() { <-sem }()
			r.process(ctx, row)
		}(row)
	}
	wg.Wait()
	return len(rows), nil
}

// process resolves one claimed outbox row.
func (r *Router) process(ctx context.Context, row OutboxRow) {
	log := r.opts.Logger.With(
		"outbox_id", row.ID,
		"event_id", row.EventID,
		"attempts", row.Attempts,
	)

	if row.Type != OutboxTypeEventCreated {
		// Not ours. Parking rather than releasing: another consumer may exist
		// one day, but silently re-claiming a row forever is how a queue stops.
		log.Error("outbox row has an unhandled type; parking",
			"outbox_type", row.Type, "handled_type", OutboxTypeEventCreated)
		r.park(ctx, row, "unknown_outbox_type",
			fmt.Sprintf("outbox type %q is not handled by the router", row.Type), log)
		return
	}

	if row.Attempts > r.opts.MaxOutboxAttempts {
		// The poison bound. attempts was incremented by the committed claim, so
		// this fires even for a row that crashes the process before any failure
		// handler runs.
		log.Error("outbox row exceeded its attempt bound; parking",
			"max_outbox_attempts", r.opts.MaxOutboxAttempts,
			"consequence", "this event will not be delivered until an operator replays it")
		r.park(ctx, row, "attempts_exhausted",
			fmt.Sprintf("claimed %d times without completing (bound %d)",
				row.Attempts, r.opts.MaxOutboxAttempts), log)
		return
	}

	started := time.Now()
	res, err := r.opts.Store.Route(ctx, RouteRequest{
		RouterID:  r.opts.RouterID,
		Row:       row,
		FanOutCap: r.opts.MaxSubscriptionsPerEvent,
	})
	RouteDuration.Observe(time.Since(started).Seconds())

	if err != nil {
		if ctx.Err() != nil {
			// Shutdown cancelled the transaction. Leave the lease to lapse
			// rather than issuing another statement on a dead context.
			return
		}
		r.release(ctx, row, err, log)
		return
	}

	switch res.Outcome {
	case OutcomeEventMissing:
		// event_outbox -> events is ON DELETE CASCADE, so this should be
		// unreachable; it is handled because "should be unreachable" is not a
		// recovery strategy, and a retention job that ever bypasses the FK
		// would otherwise wedge the queue.
		log.Warn("outbox row points at an event that no longer exists; parking")
		r.park(ctx, row, "event_missing", "event row no longer exists", log)

	case OutcomeLeaseLost:
		// Another router owns the row. Its transaction was rolled back,
		// deliveries included, so there is nothing to undo.
		EventsRouted.WithLabelValues(string(OutcomeLeaseLost)).Inc()
		log.Warn("outbox lease lost before commit; another router owns this event",
			"router_id", r.opts.RouterID)

	case OutcomeNoSubscriptions:
		EventsRouted.WithLabelValues(string(OutcomeNoSubscriptions)).Inc()
		FanOutSize.Observe(0)
		r.recordSkips(res.Plan)
		// Not an error, but never silent: "we published it and nothing
		// happened" is a configuration question an operator must be able to
		// answer from logs alone.
		log.Info("event matched no subscriptions",
			"event_type", res.Event.EventType,
			"project_id", res.Event.ProjectID,
			"candidates_considered", candidateCount(res.Plan),
			"skipped", res.Plan.Skipped)

	case OutcomeRouted:
		EventsRouted.WithLabelValues(string(OutcomeRouted)).Inc()
		metrics.DeliveriesCreated.Add(float64(res.Created))
		FanOutSize.Observe(float64(res.Created))
		r.recordSkips(res.Plan)

		if res.Created < len(res.Plan.Targets) {
			// The idempotency guarantee doing its job: this row had already
			// been fanned out by a run that died before retiring the outbox
			// row. Informational, not an error.
			log.Info("fan-out was already materialised; no duplicate deliveries created",
				"planned", len(res.Plan.Targets), "created", res.Created)
		}
		log.Debug("event routed",
			"event_type", res.Event.EventType,
			"deliveries_created", res.Created,
			"planned", len(res.Plan.Targets))
	}

	if res.Plan.Truncated > 0 || res.CandidatesTruncated {
		// Loud on purpose. Some endpoints did NOT receive this event and never
		// will without a replay.
		log.Error("subscription fan-out cap exceeded; some subscriptions did not receive this event",
			"cap", r.opts.MaxSubscriptionsPerEvent,
			"dropped", res.Plan.Truncated,
			"candidates_truncated", res.CandidatesTruncated,
			"project_id", res.Event.ProjectID,
			"remedy", "raise MaxSubscriptionsPerEvent or split the project")
	}
}

func (r *Router) park(ctx context.Context, row OutboxRow, reason, detail string, log *slog.Logger) {
	if ctx.Err() != nil {
		return
	}
	OutboxParked.WithLabelValues(reason).Inc()
	EventsRouted.WithLabelValues("parked").Inc()
	if err := r.opts.Store.ParkOutbox(ctx, r.opts.RouterID, row.ID, row.EventID,
		reason+": "+detail); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			log.Warn("could not park outbox row; lease already lost", "reason", reason)
			return
		}
		log.Error("failed to park outbox row", "reason", reason, "error", err)
	}
}

func (r *Router) release(ctx context.Context, row OutboxRow, cause error, log *slog.Logger) {
	backoff := r.backoff(row.Attempts)
	EventsRouted.WithLabelValues("retried").Inc()
	log.Warn("fan-out failed; returning outbox row to the queue",
		"error", cause,
		"retry_in", backoff.String(),
		"attempts_remaining", r.opts.MaxOutboxAttempts-row.Attempts)

	if err := r.opts.Store.ReleaseOutbox(ctx, r.opts.RouterID, row.ID, cause.Error(), backoff); err != nil {
		if errors.Is(err, ErrLeaseLost) {
			log.Warn("could not release outbox row; lease already lost")
			return
		}
		// The row stays leased and comes back when the lease lapses. Losing
		// this write costs latency, not correctness.
		log.Error("failed to release outbox row", "error", err)
	}
}

// backoff schedules the next attempt for a released row. attempts is 1-based
// and retry.Policy treats attempt 1 as immediate, so the +1 makes the first
// failure wait InitialDelay rather than nothing.
func (r *Router) backoff(attempts int) time.Duration {
	r.rngMu.Lock()
	defer r.rngMu.Unlock()
	return r.opts.RetryBackoff.Delay(attempts+1, r.rng)
}

func (r *Router) recordSkips(p Plan) {
	for reason, n := range p.Skipped {
		SubscriptionsSkipped.WithLabelValues(reason).Add(float64(n))
	}
}

// observeLag refreshes the outbox-lag gauge, at most once per LagInterval. A
// failure is swallowed: this is observability, and it must never be the reason
// a poll reports an error.
func (r *Router) observeLag(ctx context.Context) {
	r.lagMu.Lock()
	if time.Since(r.lastLag) < r.opts.LagInterval {
		r.lagMu.Unlock()
		return
	}
	r.lastLag = time.Now()
	r.lagMu.Unlock()

	seconds, err := r.opts.Store.OutboxLagSeconds(ctx)
	if err != nil {
		if ctx.Err() == nil {
			r.opts.Logger.Warn("could not measure outbox lag", "error", err)
		}
		return
	}
	metrics.OutboxLag.Set(seconds)
}

func candidateCount(p Plan) int {
	n := len(p.Targets)
	for _, c := range p.Skipped {
		n += c
	}
	return n
}
