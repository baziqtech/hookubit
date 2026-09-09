package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"fmt"

	"github.com/shaq/webhook-platform/services/data-plane/internal/config"
	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
	"github.com/shaq/webhook-platform/services/data-plane/internal/router"
	"github.com/shaq/webhook-platform/services/data-plane/internal/worker"
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

	limiter, err := buildIngestLimiter(cfg, pool, log)
	if err != nil {
		return fmt.Errorf("build ingest rate limiter: %w", err)
	}

	handler := ingest.New(ingest.Options{
		Store: ingest.NewPostgresStore(pool),
		// Two ceilings, in this order and for different reasons: Source is the
		// pre-auth per-address bound that protects the connection pool from a
		// flood with no credential, and Limiter is the policy-driven per-key,
		// per-project and per-organisation budget from the control plane.
		Limiter:          limiter,
		Source:           buildSourceLimiter(cfg, log),
		TrustedProxyHops: cfg.TrustedProxyHops,
		Payloads:         payloads,
		Limits: ingest.PayloadLimits{
			InlineMax: cfg.PayloadInlineMaxBytes,
			Max:       cfg.PayloadMaxBytes,
		},
		Logger:    log,
		DBTimeout: cfg.IngestDBTimeout,
	})

	return ingest.Serve(ctx, cfg.IngestPort, handler, log)
}

func runRouter(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) error {
	r, err := router.New(router.Options{
		Store:                    router.NewPostgresStore(pool),
		RouterID:                 ids.New(ids.Worker),
		Logger:                   log,
		BatchSize:                cfg.RouterBatchSize,
		Concurrency:              cfg.RouterConcurrency,
		Lease:                    cfg.RouterLease,
		MaxSubscriptionsPerEvent: cfg.RouterMaxSubscriptionsPerEvent,
		MaxOutboxAttempts:        cfg.RouterMaxOutboxAttempts,
		LagInterval:              10 * time.Second,
		RetryBackoff:             retry.DefaultPolicy(),
	})
	if err != nil {
		return fmt.Errorf("build router: %w", err)
	}
	log.Info("router started", "batch", cfg.RouterBatchSize, "concurrency", cfg.RouterConcurrency)
	return r.Run(ctx, cfg.OutboxPollInterval)
}

// newQueue resolves CLAIM_STRATEGY once, in one place, so the scheduler and the
// worker cannot disagree about which claim query is in force. ADR-0007 ships
// the tenant-fair lateral behind this flag and defaults to fifo until
// queue_head_of_line_delay_seconds shows a tenant actually being starved.
func newQueue(cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) *queue.PostgresQueue {
	strategy, err := queue.ParseStrategy(cfg.ClaimStrategy)
	if err != nil {
		// config.Load already validated this; a miss here means the two
		// disagree, which is worth saying out loud rather than silently
		// falling back.
		log.Error("invalid claim strategy, falling back to fifo", "error", err, "value", cfg.ClaimStrategy)
		strategy = queue.StrategyFIFO
	}
	return queue.NewPostgresQueue(pool, strategy)
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
	// The keyring must be built before any work is claimed. A worker that
	// cannot decrypt signing secrets would claim deliveries and fail every one
	// of them at signing time - which presents as a consumer problem.
	ring, err := worker.ParseKeyring(cfg.EncryptionKey, cfg.EncryptionKeyID, cfg.EncryptionKeysRetired)
	if err != nil {
		return fmt.Errorf("build decryption keyring: %w", err)
	}

	guard, err := egress.NewGuard(cfg.EgressAllowPrivateNetworks, cfg.EgressPrivateAllowlist)
	if err != nil {
		return fmt.Errorf("build egress guard: %w", err)
	}
	client := egress.NewClient(guard, egress.Limits{
		DNSTimeout:            cfg.EgressDNSTimeout,
		ConnectTimeout:        cfg.EgressConnectTimeout,
		TLSHandshakeTimeout:   cfg.EgressTLSTimeout,
		ResponseHeaderTimeout: cfg.EgressResponseHeaderTimeout,
		TotalTimeout:          cfg.EgressTotalTimeout,
		MaxResponseBytes:      cfg.EgressMaxResponseBytes,
		MaxRedirects:          cfg.EgressMaxRedirects,
		IdleConnsPerHost:      4,
	})

	w, err := worker.New(worker.Options{
		Queue:   newQueue(cfg, pool, log),
		Store:   worker.NewPostgresStore(pool),
		Health:  worker.NewPostgresStore(pool),
		Client:  client,
		Keyring: ring,
		Limits: worker.GateLimits{
			Global:   cfg.MaxConcurrencyGlobal,
			Org:      cfg.MaxConcurrencyPerOrg,
			Project:  cfg.MaxConcurrencyProject,
			Endpoint: cfg.MaxConcurrencyEndpoint,
		},
		Breaker: worker.BreakerConfig{
			OpenThreshold:     cfg.BreakerFailureThreshold,
			DegradedThreshold: cfg.BreakerDegradedThreshold,
			HalfOpenSuccesses: cfg.BreakerHalfOpenSuccesses,
			BaseCooldown:      cfg.BreakerBaseCooldown,
		},
		WorkerID:               workerID,
		Concurrency:            cfg.WorkerConcurrency,
		ClaimBatch:             cfg.WorkerClaimBatch,
		PollInterval:           cfg.WorkerPollInterval,
		Lease:                  cfg.DeliveryLease,
		DBTimeout:              cfg.IngestDBTimeout,
		MaxStoredResponseBytes: cfg.MaxStoredResponseBytes,
		Logger:                 log,
	})
	if err != nil {
		return fmt.Errorf("build worker: %w", err)
	}
	log.Info("worker started", "worker_id", workerID, "concurrency", cfg.WorkerConcurrency)
	return w.Run(ctx)
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
