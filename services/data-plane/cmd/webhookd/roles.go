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
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/payloadstore"
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
	store, err := buildPayloadStore(ctx, cfg, log)
	if err != nil {
		// Refusing to start is the honest failure. Starting without the bucket
		// an operator configured would silently drop the effective maximum
		// event size to PAYLOAD_INLINE_MAX_BYTES and 413 every large event.
		return fmt.Errorf("build payload store: %w", err)
	}
	// Assigned through an explicit nil check rather than passed straight in: a
	// nil *payloadstore.Store in an interface is NOT a nil interface, and the
	// difference between the two is a panic on the first oversized event.
	payloads := ingest.PayloadStore(ingest.NewUnconfiguredPayloadStore())
	if store != nil {
		payloads = store
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

	// The orphan sweep rides on the scheduler because it is the same kind of
	// job - periodic reconciliation of state nothing else owns - and because
	// it is far too infrequent to deserve a process. See internal/payloadstore
	// for why an object lifecycle rule cannot do this job.
	go runPayloadSweep(ctx, cfg, pool, log)

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

	// The worker must read what ingest wrote. Both sides build the same store
	// from the same S3_* configuration, so the key layout cannot drift: a
	// disagreement here would accept every large event with a 202 and then
	// fail it at delivery.
	store, err := buildPayloadStore(ctx, cfg, log)
	if err != nil {
		return fmt.Errorf("build payload store: %w", err)
	}
	// Same trap as in runIngest: worker.Options.Payloads must be a genuinely
	// nil interface when there is no bucket, or the nil-check inside the
	// delivery path passes and dereferences nothing.
	var payloads worker.PayloadFetcher
	if store != nil {
		payloads = store
	}

	w, err := worker.New(worker.Options{
		Queue:    newQueue(cfg, pool, log),
		Store:    worker.NewPostgresStore(pool),
		Health:   worker.NewPostgresStore(pool),
		Client:   client,
		Keyring:  ring,
		Payloads: payloads,
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

// buildPayloadStore returns the object store for offloaded payloads, or the
// refusing stub when no bucket is configured.
//
// Both ingest and the worker call this, which is the point: one function, one
// key layout, no way for the writer and the reader to disagree.
func buildPayloadStore(ctx context.Context, cfg *config.Config, log *slog.Logger) (*payloadstore.Store, error) {
	if cfg.S3Bucket == "" {
		// Worth saying out loud: without object storage the effective maximum
		// event size is PAYLOAD_INLINE_MAX_BYTES, not PAYLOAD_MAX_BYTES.
		log.Warn("object storage is not configured; payloads at or above the inline limit will be rejected",
			"payload_inline_max_bytes", cfg.PayloadInlineMaxBytes,
			"payload_max_bytes", cfg.PayloadMaxBytes)
		return nil, nil
	}
	return payloadstore.New(ctx, payloadstore.Config{
		Endpoint:       cfg.S3Endpoint,
		Bucket:         cfg.S3Bucket,
		Region:         cfg.S3Region,
		AccessKey:      cfg.S3AccessKey,
		SecretKey:      cfg.S3SecretKey,
		ForcePathStyle: cfg.S3ForcePathStyle,
		Prefix:         cfg.S3Prefix,

		UploadTimeout:   cfg.PayloadUploadTimeout,
		DownloadTimeout: cfg.PayloadDownloadTimeout,
		MaxAttempts:     cfg.PayloadStoreMaxAttempts,
		// The read ceiling is the largest event the platform accepts. An object
		// bigger than that is not one of ours, whatever its metadata claims.
		MaxObjectBytes: cfg.PayloadMaxBytes,
	})
}

// runPayloadSweep reclaims payload objects that no events row references.
func runPayloadSweep(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) {
	if !cfg.PayloadSweepEnabled || cfg.S3Bucket == "" {
		return
	}
	store, err := buildPayloadStore(ctx, cfg, log)
	if err != nil || store == nil {
		log.Error("orphan payload sweep disabled: could not build the payload store", "error", err)
		return
	}
	lookup := payloadstore.NewPostgresEventLookup(pool)

	_ = tick(ctx, cfg.PayloadSweepInterval, func(ctx context.Context) {
		report, err := store.Reconcile(ctx, lookup, payloadstore.ReconcileOptions{
			MinAge:     cfg.PayloadSweepMinAge,
			MaxDeletes: cfg.PayloadSweepMaxDelete,
			Logger:     log,
		})
		if err != nil {
			log.Error("orphan payload sweep failed", "error", err,
				"examined", report.Examined, "deleted", report.Deleted)
			return
		}
		if report.Deleted > 0 {
			metrics.PayloadOrphans.WithLabelValues("swept").Add(float64(report.Deleted))
			log.Warn("orphan payload sweep reclaimed objects",
				"examined", report.Examined, "deleted", report.Deleted,
				"referenced", report.Referenced, "skipped", report.Skipped)
		}
	}, log)
}
