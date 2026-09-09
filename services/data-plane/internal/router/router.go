package router

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
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
	// DefaultFanOutBatch bounds ONE FAN-OUT TRANSACTION: the subscriptions
	// examined and the deliveries created by a single Route call. Materialised
	// fan-out is cheap at 10 subscribers and expensive at 10,000; this is the
	// ceiling that keeps one misconfigured project from writing an unbounded
	// batch inside a single transaction.
	//
	// It does NOT bound the event. An event with more subscriptions than this
	// is fanned out over several batches, resuming from a durable cursor, and
	// is only marked `processed` once the last one commits. It used to bound
	// the total, and everything past it was dropped, committed as `processed`
	// and unreachable by replay - see the comment on RouteRequest.FanOutBatch.
	DefaultFanOutBatch = 2000
	// DefaultMaxOutboxAttempts is the poison bound, and it is counted against
	// UNACCOUNTED claims - claims that ended with this router writing nothing at
	// all. A row that kills the process this many times is parked rather than
	// left to cycle: a queue that a single bad row can block forever is a queue
	// that stops during exactly the incident you need it for.
	//
	// A claim that observed its failure and recorded it does not count here. It
	// is bounded by DefaultMaxOutboxRetryDuration instead.
	DefaultMaxOutboxAttempts = 5
	// DefaultMaxOutboxRetryDuration bounds RECORDED transient failure, by time
	// rather than by count.
	//
	// The failures on this path are database-side - a lock wait, a failover, an
	// exhausted pool - and no count can distinguish "PostgreSQL was degraded for
	// twenty minutes" from "this row errors every time"; both produce N failures
	// in a row. Elapsed time can: an incident ends, a broken row does not. An
	// hour rides out a real incident without parking a single accepted event,
	// and still surfaces a genuinely stuck row within the same working day, with
	// its whole error history recorded on the row.
	DefaultMaxOutboxRetryDuration = time.Hour
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

	BatchSize   int
	Concurrency int
	Lease       time.Duration
	// MaxSubscriptionsPerEvent is the fan-out BATCH size. The name is kept
	// because ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT configures it; what changed is
	// that it now bounds one transaction rather than one event. See
	// DefaultFanOutBatch.
	MaxSubscriptionsPerEvent int
	// MaxOutboxAttempts bounds UNACCOUNTED claims. See DefaultMaxOutboxAttempts.
	MaxOutboxAttempts int
	// MaxOutboxRetryDuration bounds recorded transient failure. See
	// DefaultMaxOutboxRetryDuration.
	MaxOutboxRetryDuration time.Duration
	LagInterval            time.Duration

	// RetryBackoff schedules a released row's next attempt. It reuses
	// retry.Policy so the outbox and the delivery loop back off the same way,
	// including the overflow clamping that policy already got right - but its
	// MaxDelay is clamped to the outbox ceiling; see New.
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
		opts.MaxSubscriptionsPerEvent = DefaultFanOutBatch
	}
	if opts.MaxOutboxAttempts <= 0 {
		opts.MaxOutboxAttempts = DefaultMaxOutboxAttempts
	}
	if opts.MaxOutboxRetryDuration <= 0 {
		opts.MaxOutboxRetryDuration = DefaultMaxOutboxRetryDuration
	}
	if opts.LagInterval <= 0 {
		opts.LagInterval = DefaultLagInterval
	}
	if opts.RetryBackoff.MaxAttempts == 0 && opts.RetryBackoff.InitialDelay == 0 {
		opts.RetryBackoff = DefaultOutboxBackoff()
	}
	// THE OUTBOX BACKS OFF ON ITS OWN SCHEDULE, NOT THE DELIVERY SCHEDULE.
	//
	// Why the outbox needs its own schedule: the failures it backs off from are
	// database-side (a lock wait, a failover, an exhausted pool) and resolve in
	// seconds, whereas the delivery policy is built for customer endpoints and
	// caps at one hour. An hour-long backoff against a one-hour
	// MaxOutboxRetryDuration would park an accepted event after one or two
	// retries - the row is still there, but nothing will move it again without
	// an operator requeue.
	//
	// Production passes the right thing: cmd/webhookd/roles.go supplies
	// router.DefaultOutboxBackoff(). This clamp stays as a guard rail for every
	// other caller, because the substitution above only fires on a wholly
	// zero-valued policy - a partially-filled delivery-shaped policy would slip
	// past it. Clamping (rather than refusing to start) is deliberate: a hard
	// error would take the data plane down over a misconfiguration. It is said
	// out loud at WARN, because honouring an over-long ceiling silently is what
	// produced the parked rows in the first place.
	if ceiling := DefaultOutboxBackoff().MaxDelay; opts.RetryBackoff.MaxDelay > ceiling {
		opts.Logger.Warn("outbox retry backoff exceeds the outbox ceiling; clamping",
			"configured_max_delay", opts.RetryBackoff.MaxDelay.String(),
			"clamped_to", ceiling.String(),
			"reason", "the outbox retries database-side failures, not customer endpoints",
			"remedy", "pass router.DefaultOutboxBackoff() as Options.RetryBackoff")
		opts.RetryBackoff.MaxDelay = ceiling
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
//
// MaxAttempts is not consulted by the router - the two bounds are
// MaxOutboxAttempts (unaccounted claims) and MaxOutboxRetryDuration (elapsed
// recorded failure) - but it is set so the policy is internally coherent if it
// is ever read as one.
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
		"fan_out_batch", r.opts.MaxSubscriptionsPerEvent,
		"max_outbox_attempts", r.opts.MaxOutboxAttempts,
		"max_outbox_retry_duration", r.opts.MaxOutboxRetryDuration.String())

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
//
// # The fan-out is a NEW TRACE, linked to the ingest that caused it
//
// The span opened here is a stage ROOT with a link to
// event_outbox.trace_context, never a child of it. The reasoning is in
// internal/tracing/context.go and comes down to three things: the fan-out
// happens an arbitrary time after the 202 - so a parent-child edge reports
// hour-long ingest latencies to every backend that derives one; the ingest's
// sampling decision would otherwise silently decide whether the fan-out is
// recorded at all; and one event can fan out to thousands of deliveries, each
// with its own retry chain, which under parent-child is a single trace no
// backend assembles.
//
// It is opened around `process` rather than around `RunOnce` on purpose. One
// poll claims a BATCH of unrelated events belonging to different tenants;
// making that batch a span would produce a trace that mixes tenants and whose
// duration is "how long the slowest unrelated event took". The unit an operator
// asks about is one event's fan-out, so that is the unit that gets a span. The
// claim itself is left untraced deliberately: it runs four times a second per
// replica and is empty almost every time, and its two real questions - depth
// and lag - are already gauges (outbox_lag_seconds, queue_depth).
func (r *Router) process(ctx context.Context, row OutboxRow) {
	ctx, span := tracing.StartStage(ctx, "webhook.fan_out", tracing.StageOptions{
		Upstream: row.TraceContext,
		// Consumer: this work was produced by another process and picked up
		// here, which is exactly what the kind means.
		Kind: trace.SpanKindConsumer,
		// A re-claim is a row that has already been picked up at least once, so
		// something went wrong the first time. Sampled in at 100%: it is rare
		// on a healthy platform and it is the only shape an operator ever asks
		// about. See internal/tracing/sampler.go.
		Recovery: row.Attempts > 1,
		Attributes: []attribute.KeyValue{
			tracing.AttrOutboxID.String(row.ID),
			tracing.AttrEventID.String(row.EventID),
			tracing.AttrAttempt.Int(row.Attempts),
		},
	})
	defer span.End()

	log := tracing.Logger(ctx, r.opts.Logger).With(
		"outbox_id", row.ID,
		"event_id", row.EventID,
		"attempts", row.Attempts,
		"unaccounted_attempts", row.UnaccountedAttempts,
	)

	if row.Type != OutboxTypeEventCreated {
		// Not ours. Parking rather than releasing: another consumer may exist
		// one day, but silently re-claiming a row forever is how a queue stops.
		log.Error("outbox row has an unhandled type; parking",
			"outbox_type", row.Type, "handled_type", OutboxTypeEventCreated)
		markOutcome(span, "parked", "unknown_outbox_type")
		r.park(ctx, row, "unknown_outbox_type",
			fmt.Sprintf("outbox type %q is not handled by the router", row.Type), log)
		return
	}

	// THE POISON BOUND, and it is counted against UNACCOUNTED claims.
	//
	// Both counters are incremented by the committed claim, so this still fires
	// for a row that crashes the process before any failure handler runs - that
	// is what the increment-on-claim is for and it is unchanged. What no longer
	// fires is the other case: a degraded-Postgres window in which fan-out was
	// never even attempted burned the whole budget on rows that were never at
	// fault, and parked events that had already been answered 202 Accepted. A
	// claim that observes and records its failure hands the increment back
	// (releaseOutboxSQL), so only a claim that vanished silently spends it.
	if row.UnaccountedAttempts > r.opts.MaxOutboxAttempts {
		log.Error("outbox row exceeded its unaccounted-claim bound; parking",
			"max_outbox_attempts", r.opts.MaxOutboxAttempts,
			"meaning", "claimed this many times without the router recording any outcome, which is what a row that kills the process looks like",
			"consequence", "this event will not be delivered until an operator requeues it")
		markOutcome(span, "parked", "attempts_exhausted")
		r.park(ctx, row, "attempts_exhausted",
			fmt.Sprintf("claimed %d times (%d of them leaving no recorded outcome, bound %d)",
				row.Attempts, row.UnaccountedAttempts, r.opts.MaxOutboxAttempts), log)
		return
	}

	// THE TRANSIENT BOUND, by elapsed time rather than by count.
	//
	// failing_since is set by the first recorded failure and cleared by any
	// progress, so this is "how long has this row been failing in a way we
	// understood and wrote down". A count here would be indistinguishable
	// between an outage and a broken row; the clock is not.
	if row.FailingSince != nil {
		if failing := time.Since(*row.FailingSince); failing > r.opts.MaxOutboxRetryDuration {
			log.Error("outbox row has been failing for longer than its retry duration; parking",
				"failing_for", failing.Round(time.Second).String(),
				"max_outbox_retry_duration", r.opts.MaxOutboxRetryDuration.String(),
				"consequence", "this event will not be delivered until an operator requeues it")
			markOutcome(span, "parked", "retry_duration_exceeded")
			r.park(ctx, row, "retry_duration_exceeded",
				fmt.Sprintf("failing since %s (%s, bound %s)",
					row.FailingSince.UTC().Format(time.RFC3339),
					failing.Round(time.Second), r.opts.MaxOutboxRetryDuration), log)
			return
		}
	}

	started := time.Now()
	res, err := r.opts.Store.Route(ctx, RouteRequest{
		RouterID:    r.opts.RouterID,
		Row:         row,
		FanOutBatch: r.opts.MaxSubscriptionsPerEvent,
		// THIS span's context, stamped onto every delivery row the transaction
		// creates. It is written inside that transaction, so a rolled-back
		// fan-out leaves no delivery pointing at a span that describes work
		// which never committed.
		TraceContext: tracing.Encode(ctx),
	})
	RouteDuration.Observe(time.Since(started).Seconds())

	if err != nil {
		if ctx.Err() != nil {
			// Shutdown cancelled the transaction. Leave the lease to lapse
			// rather than issuing another statement on a dead context.
			return
		}
		tracing.RecordError(span, err)
		markOutcome(span, "released", "fan_out_failed")
		r.release(ctx, row, err, log)
		return
	}

	span.SetAttributes(
		tracing.AttrOutcome.String(string(res.Outcome)),
		tracing.AttrDeliveriesMade.Int(res.Created),
		tracing.AttrFanOutPlanned.Int(len(res.Plan.Targets)),
	)
	if res.Event.ProjectID != "" {
		span.SetAttributes(
			tracing.AttrProjectID.String(res.Event.ProjectID),
			tracing.AttrOrganizationID.String(res.Event.OrganizationID),
			tracing.AttrEventType.String(res.Event.EventType),
		)
	}

	switch res.Outcome {
	case OutcomeEventMissing:
		// event_outbox -> events is ON DELETE CASCADE, so this should be
		// unreachable; it is handled because "should be unreachable" is not a
		// recovery strategy, and a retention job that ever bypasses the FK
		// would otherwise wedge the queue.
		log.Warn("outbox row points at an event that no longer exists; parking")
		markOutcome(span, "parked", "event_missing")
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

	case OutcomeFanOutContinued:
		// A wide fan-out, mid-walk. Not an error and not a failure: this batch
		// committed, the cursor advanced, and the row is already back in the
		// ready set. The event stays `processing` until the last batch lands,
		// which is why it is honest to say nothing was lost here.
		EventsRouted.WithLabelValues(string(OutcomeFanOutContinued)).Inc()
		FanOutBatches.Inc()
		metrics.DeliveriesCreated.Add(float64(res.Created))
		FanOutSize.Observe(float64(res.Created))
		r.recordSkips(res.Plan)
		log.Info("fan-out batch committed; more subscriptions remain",
			"event_type", res.Event.EventType,
			"project_id", res.Event.ProjectID,
			"deliveries_created", res.Created,
			"batch_size", r.opts.MaxSubscriptionsPerEvent,
			"resume_after_subscription_id", res.FanOutCursor)

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
			"planned", len(res.Plan.Targets),
			"resumed_from_subscription_id", row.FanOutCursor)
	}
}

// markOutcome records a non-routed resolution on the fan-out span.
//
// A parked row is an ERROR in the span sense: an event that returned 202 and
// will not be delivered without a human. A released one is not - it is going to
// be retried and the platform is behaving as designed - so it gets the
// attributes and no error status, or every transient database blip would show
// up as a red trace.
func markOutcome(span trace.Span, outcome, reason string) {
	if !span.IsRecording() {
		return
	}
	span.SetAttributes(
		tracing.AttrOutcome.String(outcome),
		tracing.AttrDeliveryReason.String(reason),
	)
	if outcome == "parked" {
		span.SetStatus(codes.Error, reason)
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
	// The deadline, not an attempt count. A recorded failure refunds the claim
	// (releaseOutboxSQL), so what actually decides whether this row survives is
	// how long it has been failing - and that is the number an operator watching
	// an incident needs.
	deadline := "now + " + r.opts.MaxOutboxRetryDuration.String()
	if row.FailingSince != nil {
		deadline = row.FailingSince.Add(r.opts.MaxOutboxRetryDuration).UTC().Format(time.RFC3339)
	}
	log.Warn("fan-out failed; returning outbox row to the queue",
		"error", cause,
		"retry_in", backoff.String(),
		"parks_after", deadline)

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
