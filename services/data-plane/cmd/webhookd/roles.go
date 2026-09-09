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
	"github.com/shaq/webhook-platform/services/data-plane/internal/ratelimit"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retention"
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
		MaxOutboxRetryDuration:   cfg.RouterMaxOutboxRetryDuration,
		LagInterval:              10 * time.Second,
		// The OUTBOX's backoff, not the delivery one. Passing
		// retry.DefaultPolicy() here made the outbox back off on the delivery
		// schedule, whose 1h cap against a 1h MaxOutboxRetryDuration would park
		// an accepted event after a single retry.
		RetryBackoff: router.DefaultOutboxBackoff(),
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

// queueDepthInterval is how often queue_depth is recomputed. A constant rather
// than an environment variable: it is one aggregate over the non-terminal rows,
// the cost is the same for every deployment, and fifteen seconds is well inside
// any useful scrape interval. If a deployment ever needs it tuned, that is the
// moment to add the knob - not before.
const queueDepthInterval = 15 * time.Second

func runScheduler(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) error {
	q := newQueue(cfg, pool, log)

	// The orphan sweep rides on the scheduler because it is the same kind of
	// job - periodic reconciliation of state nothing else owns - and because
	// it is far too infrequent to deserve a process. See internal/payloadstore
	// for why an object lifecycle rule cannot do this job.
	go runPayloadSweep(ctx, cfg, pool, log)

	// The queue depth gauge rides here for the same reason and one more: it is
	// a pure READER - no lease, no claim, no write - so the singleton
	// reconciliation role is the cheapest place to put it, and its numbers are
	// fleet-wide rather than per-replica.
	//
	// It is the only instrument that can see the failure modes that produce no
	// attempt at all. A delivery deferred by an open circuit breaker or a rate
	// limit writes no delivery_attempts row and moves no counter; the rows just
	// accumulate. Counters of things that happened cannot show work that is not
	// happening.
	//
	// The error is discarded on purpose: Run returns nil on cancellation and
	// swallows query faults itself, so there is nothing here that should be able
	// to take the scheduler down. A metrics refresher must never be why a role
	// exits.
	go func() {
		_ = metrics.NewQueueDepthCollector(pool, queueDepthInterval, log).Run(ctx)
	}()

	// Delivery ledger retention rides here for the same reasons as the collector
	// above: periodic reconciliation of state nothing else owns, far too
	// infrequent to deserve a process, on a role that is already a singleton. It
	// takes no lease - every statement is bounded, idempotent and
	// self-terminating - so a second scheduler would be wasteful, not unsafe.
	go func() {
		rcfg, err := retention.ConfigFromEnv()
		if err != nil {
			// Refusing to sweep is the safe failure, and this is the one
			// background job that must NOT fall back to a default: a mistyped
			// egress timeout costs latency, a mistyped retention horizon deletes
			// the delivery ledger on a schedule nobody chose.
			log.Error("delivery ledger retention disabled: invalid configuration", "error", err)
			return
		}
		sweeper, err := retention.New(pool, rcfg, log)
		if err != nil {
			log.Error("delivery ledger retention disabled", "error", err)
			return
		}
		// Discarded exactly as the collector's is: Run returns nil on
		// cancellation and logs its own failures. This role also owns lease
		// reclaim, which deliveries depend on and disk space does not.
		_ = sweeper.Run(ctx)
	}()

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

// egressLimits maps configuration onto the outbound HTTP bounds. It exists as a
// function so a test can pin the one relationship that is easy to break by
// accident and impossible to notice in production: the per-host connection
// ceiling must be what the operator configured.
//
// It used to read `IdleConnsPerHost: 4` here, and net/http derived a
// MaxConnsPerHost of 16 from it. That was the real limit on outbound
// concurrency to any one customer host - below WORKER_CONCURRENCY, below
// MAX_CONCURRENCY_PER_ENDPOINT, and reachable from no environment variable.
func egressLimits(cfg *config.Config) egress.Limits {
	// Warm connections are worth keeping, but not one per pool slot per host:
	// a data plane speaking to thousands of customer hosts would then hold
	// thousands of idle sockets. Cap the warm pool at the transport default and
	// let the ceiling above it carry the concurrency. Idle slots never bound
	// concurrency, so this cannot re-create the bug it replaces.
	idle := egress.DefaultIdleConnsPerHost
	if cfg.EgressMaxConnsPerHost < idle {
		idle = cfg.EgressMaxConnsPerHost
	}
	return egress.Limits{
		DNSTimeout:            cfg.EgressDNSTimeout,
		ConnectTimeout:        cfg.EgressConnectTimeout,
		TLSHandshakeTimeout:   cfg.EgressTLSTimeout,
		ResponseHeaderTimeout: cfg.EgressResponseHeaderTimeout,
		TotalTimeout:          cfg.EgressTotalTimeout,
		MaxResponseBytes:      cfg.EgressMaxResponseBytes,
		MaxRedirects:          cfg.EgressMaxRedirects,
		MaxConnsPerHost:       cfg.EgressMaxConnsPerHost,
		IdleConnsPerHost:      idle,
	}
}

// workerTimeouts maps configuration onto the two INDEPENDENT budgets the
// delivery loop runs on: one database call, and one object-storage fetch.
//
// It exists as a function for the same reason egressLimits does - so a test can
// pin a relationship that is easy to break by accident and impossible to notice
// in production. Both halves have been broken here before. The worker's
// database calls ran on INGEST_DB_TIMEOUT_MS, so tuning the deadline of a
// request a client is waiting on silently retuned a background loop that would
// rather wait than abandon a lease; and the payload fetch ran on the same
// budget, so any PAYLOAD_DOWNLOAD_TIMEOUT_MS set above it was truncated with no
// sign that it had been.
func workerTimeouts(cfg *config.Config) (db, payload time.Duration) {
	return cfg.WorkerDBTimeout, cfg.PayloadDownloadTimeout
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
	client := egress.NewClient(guard, egressLimits(cfg))

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

	limiter, err := buildDeliveryLimiter(cfg, log)
	if err != nil {
		return fmt.Errorf("build delivery rate limiter: %w", err)
	}

	// Said out loud, before any work is claimed, because the failure it
	// describes is silent and its symptom (one customer's webhooks are slow)
	// points nowhere near its cause (a different customer's endpoints are
	// sitting on the pool). Warnings, never a refusal: taking the data plane
	// down over a tuning choice is worse than the starvation it warns about.
	// See config.ConcurrencyAdvisories and docs/FAILURE_RECOVERY.md, G13.
	for _, advisory := range cfg.ConcurrencyAdvisories() {
		log.Warn(advisory.Message, advisory.Fields...)
	}

	dbTimeout, payloadTimeout := workerTimeouts(cfg)

	w, err := worker.New(worker.Options{
		Queue:    newQueue(cfg, pool, log),
		Store:    worker.NewPostgresStore(pool),
		Health:   worker.NewPostgresStore(pool),
		Client:   client,
		Keyring:  ring,
		Payloads: payloads,
		Limiter:  limiter,
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
		WorkerID:     workerID,
		Concurrency:  cfg.WorkerConcurrency,
		ClaimBatch:   cfg.WorkerClaimBatch,
		PollInterval: cfg.WorkerPollInterval,
		Lease:        cfg.DeliveryLease,
		// Two budgets, neither of them the ingest one. See workerTimeouts.
		DBTimeout:              dbTimeout,
		PayloadTimeout:         payloadTimeout,
		MaxStoredResponseBytes: cfg.MaxStoredResponseBytes,
		Logger:                 log,
	})
	if err != nil {
		return fmt.Errorf("build worker: %w", err)
	}
	// max_conns_per_host is logged next to concurrency deliberately: it is the
	// one bound that can silently outrank every configured concurrency ceiling,
	// and an operator comparing the two numbers can see that it does.
	log.Info("worker started",
		"worker_id", workerID,
		"concurrency", cfg.WorkerConcurrency,
		"max_conns_per_host", cfg.EgressMaxConnsPerHost,
		"db_timeout", dbTimeout,
		"payload_timeout", payloadTimeout)
	return w.Run(ctx)
}

// deliveryLimiter adapts internal/ratelimit onto worker.RateLimiter, so a
// per-endpoint delivery ceiling is charged against ONE fleet-wide bucket rather
// than one bucket per worker replica.
//
// Two properties this must not lose, both asserted by the outage suite:
//
//   - it never fails closed. internal/ratelimit resolves every fault itself -
//     a dead Redis, a timeout, a degraded circuit - and falls back to the
//     in-process bucket, so the worst a Redis outage can do is put the ceiling
//     back to per replica. A delivery is never refused because a cache blipped.
//   - internal/worker never learns Redis exists. The go-redis dependency lives
//     in internal/ratelimit and reaches the worker only through this interface;
//     the structural guard in internal/failure/outage asserts that the durable
//     path imports no Redis client, and it is right to.
type deliveryLimiter struct{ inner *ratelimit.Limiter }

func (d deliveryLimiter) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration) {
	if limit <= 0 || window <= 0 {
		return true, 0
	}
	return d.inner.AllowBucket(ctx, ratelimit.BucketFor(ratelimit.ScopeEndpoint, key, limit, window))
}

// buildDeliveryLimiter returns the limiter for endpoints.rate_limit, or nil to
// leave the worker on its own in-process token bucket.
//
// Nil is the honest answer with no REDIS_URL: worker.New already defaults to an
// in-process bucket, and routing through internal/ratelimit's local fallback
// instead would be the same behaviour with an extra layer and a name that
// implies a fleet-wide guarantee it cannot make.
func buildDeliveryLimiter(cfg *config.Config, log *slog.Logger) (worker.RateLimiter, error) {
	if cfg.RedisURL == "" {
		// Refused in production unless an operator has said, in configuration,
		// that they mean it. A limit the customer configured and does not get
		// is the same class of quiet downgrade as EGRESS_ALLOW_PRIVATE_NETWORKS
		// and gets the same treatment. Nothing about the RUNTIME changes:
		// delivery never depends on Redis, and the in-process bucket below is
		// still the fallback when a configured Redis dies.
		if err := cfg.ValidateDeliveryRateLimitScope(); err != nil {
			return nil, err
		}
		metrics.DeliveryRateLimitFleetWide.Set(0)
		log.Warn("REDIS_URL is not set; endpoint delivery rate limits are enforced PER REPLICA, not fleet-wide",
			"effect", "an endpoint limit of N is effectively N x the number of worker pods",
			"app_env", cfg.AppEnv,
			"acknowledged", cfg.DeliveryRateLimitAllowPerReplica,
			"observe", "delivery_rate_limit_fleet_wide is 0 for as long as this holds")
		return nil, nil
	}
	client, err := ratelimit.NewRedisClient(cfg.RedisURL, cfg.RedisTimeout)
	if err != nil {
		return nil, fmt.Errorf("build delivery limiter redis client: %w", err)
	}

	limiter := ratelimit.New(ratelimit.Options{
		// No policy Source: this limiter charges the endpoint's own
		// rate_limit column, which arrives on the delivery row. Adding a source
		// here would put a policy query on the delivery hot path for buckets
		// nothing resolves from rows.
		Redis:   ratelimit.NewRedisScripter(client),
		Timeout: cfg.RedisTimeout,
		Logger:  log,
	})
	metrics.DeliveryRateLimitFleetWide.Set(1)
	log.Info("endpoint delivery rate limiting is fleet-wide",
		"redis_timeout_ms", cfg.RedisTimeout.Milliseconds(),
		"degrades_to", "in-process buckets when redis is unreachable")
	return deliveryLimiter{inner: limiter}, nil
}

// runAll runs every role in one process, and brings the WHOLE process down if
// any single role fails.
//
// It used to log "role exited" and leave the others running, which produces the
// worst state this system can be in: the worker refuses to start - because
// delivery rate limits would be per-replica in production, say - while ingest
// keeps answering 202. Events are accepted, durably, and nothing delivers them.
// Every health probe stays green, because liveness does not know a role is
// missing. That is silent data accumulation presented as a healthy service.
//
// A process that dies loudly is recoverable by a restart loop and visible in
// any dashboard. A half-running one is neither.
func runAll(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger, instanceID string) error {
	// Roles run on a context this function can cancel, so the first failure
	// drains the rest rather than leaving them orphaned behind a dead peer.
	runCtx, cancelRoles := context.WithCancel(ctx)
	defer cancelRoles()

	var (
		wg      sync.WaitGroup
		once    sync.Once
		failure error
	)
	roles := map[string]func() error{
		"ingest":    func() error { return runIngest(runCtx, cfg, pool, log) },
		"router":    func() error { return runRouter(runCtx, cfg, pool, log) },
		"scheduler": func() error { return runScheduler(runCtx, cfg, pool, log) },
		"worker":    func() error { return runWorker(runCtx, cfg, pool, log, instanceID) },
	}
	for name, fn := range roles {
		wg.Add(1)
		go func(name string, fn func() error) {
			defer wg.Done()
			// ctx, not runCtx: a role unwinding because a PEER failed is
			// shutting down normally and has nothing of its own to report.
			if err := fn(); err != nil && ctx.Err() == nil {
				log.Error("role exited; stopping every role in this process",
					"role", name, "error", err)
				once.Do(func() {
					failure = fmt.Errorf("role %s: %w", name, err)
					cancelRoles()
				})
			}
		}(name, fn)
	}
	wg.Wait()

	if failure != nil {
		return failure
	}
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
