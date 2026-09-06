package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/config"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
)

// slogLogger is an alias kept so main.go reads cleanly.
type slogLogger = slog.Logger

// PHASE 3 lands the bodies of these loops (see docs/ROADMAP.md). Phase 1 gives
// every role a real process: configuration, a pool, probes, metrics and a
// shutdown path that is already correct. Filling in the work is then an edit to
// one function rather than a rewrite of the service.

func runIngest(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) error {
	// The order below is fixed by ARCHITECTURE.md 16 and enforced in
	// internal/ingest: authenticate the API key, resolve the project, validate,
	// rate limit, check the idempotency key, then BEGIN; INSERT events; INSERT
	// event_outbox; COMMIT; and only then return 202. Nothing is published to
	// any queue before that COMMIT.
	payloads := ingest.NewUnconfiguredPayloadStore()
	if cfg.S3Bucket == "" {
		// Worth saying out loud: without object storage the effective maximum
		// event size is PAYLOAD_INLINE_MAX_BYTES, not PAYLOAD_MAX_BYTES.
		log.Warn("object storage is not configured; payloads at or above the inline limit will be rejected",
			"payload_inline_max_bytes", cfg.PayloadInlineMaxBytes,
			"payload_max_bytes", cfg.PayloadMaxBytes)
	}

	handler := ingest.New(ingest.Options{
		Store: ingest.NewPostgresStore(pool),
		// PHASE 3: swap in the Redis token bucket (ARCHITECTURE.md 25). The
		// seam is here so ingest does not need Redis to be correct.
		Limiter:  ingest.AllowAll{},
		Payloads: payloads,
		Limits: ingest.PayloadLimits{
			InlineMax: cfg.PayloadInlineMaxBytes,
			Max:       cfg.PayloadMaxBytes,
		},
		Logger:    log,
		DBTimeout: cfg.IngestDBTimeout,
	})

	return ingest.Serve(ctx, cfg.IngestPort, handler, log)
}

func runRouter(ctx context.Context, cfg *config.Config, _ *pgxpool.Pool, log *slog.Logger) error {
	// PHASE 3: claim event_outbox rows with FOR UPDATE SKIP LOCKED, match the
	// event against enabled subscriptions (internal/router.Match), and insert
	// one delivery row per match inside a single transaction with the outbox
	// row's completion. Re-running a partially applied batch must be safe, so
	// delivery insertion is keyed on (event_id, endpoint_id).
	return tick(ctx, cfg.OutboxPollInterval, func(context.Context) {
		metrics.OutboxLag.Set(0)
	}, log)
}

func runScheduler(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) error {
	q := newQueue(cfg, pool, log)
	// The scheduler owns recovery, not timing: Claim already treats a due
	// delivery - including one whose lease has expired - as ready, so losing
	// this role costs efficiency and operator clarity, not deliveries. What it
	// buys is putting abandoned rows back inside the ready-set predicate
	// promptly instead of leaving them as `processing` outliers, and telling an
	// operator, via queue_leases_reclaimed_total, that workers are dying
	// mid-attempt.
	return tick(ctx, time.Second, func(ctx context.Context) {
		reclaimed, err := q.ReclaimExpired(ctx)
		if err != nil {
			log.Error("reclaim expired leases", "error", err)
			return
		}
		if reclaimed > 0 {
			log.Warn("reclaimed abandoned deliveries", "count", reclaimed)
		}
	}, log)
}

func runWorker(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger, workerID string) error {
	q := newQueue(cfg, pool, log)

	// The lease keeper is the half of the delivery loop that is already
	// correct, and it is wired here rather than in Phase 3 because it is what
	// makes a lost lease safe. Every attempt Phase 3 adds must run under the
	// context returned by keeper.Track: when a renewal comes back reporting
	// that this worker no longer owns a delivery, that context is cancelled
	// with cause queue.ErrLeaseLost, the in-flight HTTP request aborts, and NO
	// delivery_attempts row and NO status transition may be written for it.
	// The row belongs to whichever worker reclaimed it; writing anyway is how
	// one webhook is delivered twice and its terminal status decided by a race.
	keeper := queue.NewLeaseKeeper(q, workerID, cfg.DeliveryLease, log)
	go func() {
		if err := keeper.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("lease keeper stopped", "error", err)
		}
	}()

	// PHASE 3: for each claimed lease - load the endpoint config and active
	// secrets, check the circuit breaker and rate limit, sign the exact payload
	// bytes (signing.Header returns an error when an endpoint has no active
	// secret; that delivery must fail, never go out unsigned), deliver through
	// internal/egress under keeper.Track's context, write a delivery_attempts
	// row, then advance the delivery state machine. Concurrency is bounded by
	// cfg.WorkerConcurrency and by the per-org/project/endpoint ceilings; a
	// slow endpoint must never consume the pool (ARCHITECTURE.md 24).
	//
	// Until that lands this loop deliberately does NOT claim. A stub that
	// claims a batch and immediately releases it without advancing
	// next_attempt_at re-claims the same rows on the very next tick: at a 250ms
	// poll and a 100-row batch that is ~800 UPDATEs/sec of dead tuples against
	// an idle database, autovacuum churn on the hottest table in the system,
	// and an operator UI in which every delivery looks like it was touched a
	// moment ago. Doing nothing is strictly better than doing that.
	log.Info("worker started (delivery loop is a phase 3 stub; not claiming)",
		"worker_id", workerID,
		"concurrency", cfg.WorkerConcurrency,
		"claim_strategy", q.Strategy())
	<-ctx.Done()
	return ctx.Err()
}

// newQueue builds the delivery queue with the configured claim strategy.
//
// CLAIM_STRATEGY defaults to "fifo", which deliberately inverts the default
// stated in ADR-0007. The tenant-fair path is fully implemented and one env var
// away, but nothing has been measured yet, its prerequisite index and NOT NULL
// migration have not been applied, and ARCHITECTURE.md's own rule is to prefer
// the simplest production-grade option. It gets promoted to the default when
// queue_head_of_line_delay_seconds shows starvation, not before. See HANDOFF.md.
func newQueue(cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) *queue.PostgresQueue {
	strategy, err := queue.ParseStrategy(cfg.ClaimStrategy)
	if err != nil {
		// config.Load already rejected this; belt and braces so a future caller
		// that skips validation still gets the safe strategy rather than none.
		log.Error("invalid claim strategy; falling back to fifo", "error", err)
		strategy = queue.StrategyFIFO
	}
	return queue.NewPostgresQueue(pool, strategy)
}

func runAll(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger, instanceID string) error {
	var wg sync.WaitGroup
	roles := map[string]func() error{
		"ingest":    func() error { return runIngest(ctx, cfg, pool, log) },
		"router":    func() error { return runRouter(ctx, cfg, pool, log) },
		"scheduler": func() error { return runScheduler(ctx, cfg, pool, log) },
		"worker":    func() error { return runWorker(ctx, cfg, pool, log, instanceID) },
	}
	for name, fn := range roles {
		wg.Add(1)
		go func(name string, fn func() error) {
			defer wg.Done()
			if err := fn(); err != nil && ctx.Err() == nil {
				log.Error("role exited", "role", name, "error", err)
			}
		}(name, fn)
	}
	wg.Wait()
	return ctx.Err()
}

// tick runs work on an interval until the context is cancelled. Every loop in
// the data plane selects on ctx.Done() so SIGTERM drains rather than kills.
func tick(ctx context.Context, interval time.Duration, work func(context.Context), _ *slog.Logger) error {
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			work(ctx)
		}
	}
}
