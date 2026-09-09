// Package config loads data-plane configuration from the environment.
// Nothing has a host-shaped default: the database location always comes from
// configuration, never from an assumed localhost:5432 (ARCHITECTURE.md 36).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/payloadstore"
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ratelimit"
	"github.com/shaq/webhook-platform/services/data-plane/internal/router"
)

// ShutdownGrace is the TOTAL budget from SIGTERM to process exit, and
// MaxShutdownReadinessDelay is the share of it that may be spent advertising
// not-ready while still accepting. The budget is spent in three phases:
//
//  1. readiness propagation  0..MaxShutdownReadinessDelay (SHUTDOWN_READINESS_DELAY_MS, default 5s)
//  2. role drain             <= ingest.DrainTimeout (15s), the longest role drain
//  3. probe server shutdown  whatever remains of ShutdownGrace
//
// With the defaults: 5s + 15s = 20s <= 25s, leaving 5s for phase 3, which only
// has to close idle probe connections. Capping phase 1 at ShutdownGrace minus
// the role drain (10s) makes phases 1+2 unable to exhaust the budget on their
// own, and phase 3 is deadline-bounded from the instant the signal arrived, so
// an overrunning role drain cannot push the total past ShutdownGrace either.
// Keep the Kubernetes terminationGracePeriodSeconds comfortably above it.
const (
	ShutdownGrace             = 25 * time.Second
	MaxShutdownReadinessDelay = ShutdownGrace - ingest.DrainTimeout
)

type Config struct {
	AppEnv   string
	LogLevel string

	DatabaseURL            string
	DatabaseMaxConnections int32
	// DatabaseStatementTimeout is applied to every pooled connection. It is the
	// server-side backstop for a query that would otherwise hold a connection
	// for as long as PostgreSQL will wait.
	DatabaseStatementTimeout time.Duration

	RedisURL string
	// DeliveryRateLimitAllowPerReplica acknowledges, explicitly, that endpoint
	// delivery rate limits will be enforced PER WORKER REPLICA rather than
	// fleet-wide, which is what happens when REDIS_URL is unset.
	//
	// It exists so that the downgrade is a decision somebody wrote down rather
	// than an omission nobody noticed. In production the worker refuses to
	// start without either REDIS_URL or this flag - the same treatment
	// EGRESS_ALLOW_PRIVATE_NETWORKS gets, and for the same reason: a
	// customer-visible guarantee quietly weaker than the configured one.
	//
	// It changes NO runtime behaviour. Delivery never depends on Redis being
	// up: the limiter fails open, the worker keeps its in-process bucket as the
	// fallback, and internal/failure/outage asserts the delivery path imports
	// no Redis client at all. This is a configuration gate, not a dependency.
	DeliveryRateLimitAllowPerReplica bool
	// RedisTimeout bounds ONE rate-limiter round trip. It is deliberately tiny:
	// the limiter is an optimisation on a path whose latency budget is already
	// spoken for, and a limiter that blocks a request for seconds waiting on
	// its own store has done more damage than the traffic it was refusing.
	RedisTimeout time.Duration

	// --- Rate limiting (ARCHITECTURE.md 25) ------------------------------
	//
	// RateLimitPolicyCacheTTL is the ONLY staleness in the system: it is how
	// long after an operator changes a rate_limit_policies row before every
	// data-plane replica is enforcing the new value. Bounded and finite by
	// requirement (ARCHITECTURE.md 55); nothing pushes an invalidation, so
	// there is no cache that can get stuck.
	RateLimitPolicyCacheTTL time.Duration

	// IngestRateLimit is the built-in per-API-key ceiling, applied only when
	// the project has no scope='ingest' policy of its own. It exists so a
	// compromised or runaway credential is bounded out of the box; 0 disables
	// it and leaves ingest limited by policy rows alone.
	IngestRateLimit              int
	IngestRateLimitWindowSeconds int
	IngestRateLimitBurst         int

	// IngestSourceRateLimit is the PRE-AUTH per-address ceiling - the one that
	// runs before any database work. 0 disables it, which reopens
	// unauthenticated pressure on the connection pool; see ingest.SourceLimiter.
	IngestSourceRateLimit              int
	IngestSourceRateLimitWindowSeconds int
	IngestSourceRateLimitBurst         int
	// IngestSourceAuthFailurePenalty is the EXTRA cost charged to an address
	// whose request failed authentication.
	IngestSourceAuthFailurePenalty int

	// TrustedProxyHops is the exact number of proxies in front of the ingest
	// server. It is never inferred: guessing high means a client can forge its
	// own bucket key, guessing low means every client shares one bucket.
	TrustedProxyHops int

	S3Endpoint       string
	S3Bucket         string
	S3Region         string
	S3AccessKey      string
	S3SecretKey      string
	S3ForcePathStyle bool
	// S3Prefix is the key namespace the platform owns inside the bucket.
	// Everything written lives under it, so the orphan sweep can name one
	// prefix and be sure it covers the platform's objects and nothing an
	// operator put in the bucket by hand.
	S3Prefix string

	PayloadInlineMaxBytes int64
	PayloadMaxBytes       int64

	// PayloadUploadTimeout and PayloadDownloadTimeout bound ONE object storage
	// call each, retries included. Neither may be unbounded: an upload sits on
	// the ingest hot path and a download sits between a worker and its
	// endpoint (ARCHITECTURE.md 31).
	PayloadUploadTimeout   time.Duration
	PayloadDownloadTimeout time.Duration
	// PayloadStoreMaxAttempts bounds the SDK's own retrying. A count, not a
	// deadline; the timeouts above are the deadline.
	PayloadStoreMaxAttempts int

	// Orphan sweep. `PlanPayload` uploads before the ingest transaction, so a
	// process that dies in between leaves an object no events row references.
	// See internal/payloadstore for why this is a sweep rather than a bucket
	// lifecycle rule.
	PayloadSweepEnabled  bool
	PayloadSweepInterval time.Duration
	// PayloadSweepMinAge is how old an object must be before the sweep will
	// even consider it. It is floored at payloadstore.MinAgeFloor: anything
	// shorter races a request that is between its upload and its COMMIT.
	PayloadSweepMinAge    time.Duration
	PayloadSweepMaxDelete int

	IngestPort  int
	MetricsPort int
	// IngestDBTimeout bounds the database work of one accepted request.
	IngestDBTimeout time.Duration
	// WorkerDBTimeout bounds ONE database call on the delivery path: the load,
	// the breaker read, the attempt write, the deferral.
	//
	// It is separate from IngestDBTimeout because the two bound different work
	// with different tolerances - an ingest call is on a request a client is
	// waiting on, a delivery call is on a background loop that would rather
	// wait than abandon a lease - and because sharing one knob meant tuning the
	// ingest deadline silently retuned every database call the worker makes.
	WorkerDBTimeout time.Duration

	// ShutdownReadinessDelay is how long the process keeps accepting traffic
	// after readiness has already flipped to draining on SIGTERM. It exists so
	// load balancers observe the not-ready state while the socket is still
	// open; without it a rolling update 502s the write path for as long as the
	// ingress backend list takes to converge. Zero means drain immediately.
	ShutdownReadinessDelay time.Duration

	WorkerConcurrency  int
	WorkerPollInterval time.Duration
	WorkerClaimBatch   int
	DeliveryLease      time.Duration
	OutboxPollInterval time.Duration

	// Endpoint signing secrets are encrypted by the NestJS control plane and
	// decrypted here. Same key, same envelope, same AAD - see internal/worker.
	EncryptionKey         string
	EncryptionKeyID       string
	EncryptionKeysRetired string

	RouterBatchSize                int
	RouterConcurrency              int
	RouterLease                    time.Duration
	RouterMaxSubscriptionsPerEvent int
	RouterMaxOutboxAttempts        int
	// RouterMaxOutboxRetryDuration bounds RECORDED outbox failure by elapsed
	// time. A count cannot separate a twenty-minute database brownout from a row
	// that fails every time; a clock can. See router.DefaultMaxOutboxRetryDuration.
	RouterMaxOutboxRetryDuration time.Duration

	BreakerFailureThreshold  int
	BreakerDegradedThreshold int
	BreakerHalfOpenSuccesses int
	BreakerBaseCooldown      time.Duration
	MaxStoredResponseBytes   int

	// ClaimStrategy selects how the worker picks its batch: "fifo" (default)
	// or "tenant_fair" (ADR-0007). See the note on the default in
	// queue.NewPostgresQueue and in HANDOFF.md.
	ClaimStrategy string

	MaxConcurrencyGlobal   int
	MaxConcurrencyPerOrg   int
	MaxConcurrencyProject  int
	MaxConcurrencyEndpoint int

	EgressDNSTimeout            time.Duration
	EgressConnectTimeout        time.Duration
	EgressTLSTimeout            time.Duration
	EgressResponseHeaderTimeout time.Duration
	EgressTotalTimeout          time.Duration
	EgressMaxResponseBytes      int64
	EgressMaxRedirects          int
	EgressAllowPrivateNetworks  bool
	EgressPrivateAllowlist      []string

	// EgressMaxConnsPerHost is the hard ceiling on concurrent connections this
	// process opens to one destination host:port, shared by every endpoint and
	// every tenant that resolves there. Defaults to WorkerConcurrency - see the
	// derivation below for why the two are tied.
	EgressMaxConnsPerHost int

	OTLPEndpoint string
}

// Load reads and validates configuration, returning every problem at once
// rather than one per restart.
func Load() (*Config, error) {
	var problems []string
	require := func(key string) string {
		v := os.Getenv(key)
		if v == "" {
			problems = append(problems, key+" is required")
		}
		return v
	}

	c := &Config{
		AppEnv:   env("APP_ENV", "development"),
		LogLevel: env("LOG_LEVEL", "info"),

		DatabaseURL:              require("DATABASE_URL"),
		DatabaseMaxConnections:   int32(envInt("DATABASE_MAX_CONNECTIONS", 20)),
		DatabaseStatementTimeout: envDuration("DATABASE_STATEMENT_TIMEOUT_MS", 30*time.Second),

		RedisURL:                         os.Getenv("REDIS_URL"),
		DeliveryRateLimitAllowPerReplica: envBool("DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA", false),
		RedisTimeout:                     envDuration("REDIS_TIMEOUT_MS", 50*time.Millisecond),

		RateLimitPolicyCacheTTL: envDuration("RATE_LIMIT_POLICY_CACHE_TTL_MS", ratelimit.DefaultCacheTTL),

		IngestRateLimit:              envInt("INGEST_RATE_LIMIT", 1000),
		IngestRateLimitWindowSeconds: envInt("INGEST_RATE_LIMIT_WINDOW_SECONDS", 1),
		IngestRateLimitBurst:         envInt("INGEST_RATE_LIMIT_BURST", 2000),

		IngestSourceRateLimit:              envInt("INGEST_SOURCE_RATE_LIMIT", 300),
		IngestSourceRateLimitWindowSeconds: envInt("INGEST_SOURCE_RATE_LIMIT_WINDOW_SECONDS", 1),
		IngestSourceRateLimitBurst:         envInt("INGEST_SOURCE_RATE_LIMIT_BURST", 600),
		IngestSourceAuthFailurePenalty:     envInt("INGEST_SOURCE_AUTH_FAILURE_PENALTY", 20),

		TrustedProxyHops: envInt("INGEST_TRUSTED_PROXY_HOPS", 0),

		S3Endpoint:       os.Getenv("S3_ENDPOINT"),
		S3Bucket:         os.Getenv("S3_BUCKET"),
		S3Region:         env("S3_REGION", "us-east-1"),
		S3AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:      os.Getenv("S3_SECRET_KEY"),
		S3ForcePathStyle: envBool("S3_FORCE_PATH_STYLE", true),
		S3Prefix:         env("S3_PREFIX", payloadstore.DefaultPrefix),

		PayloadInlineMaxBytes: int64(envInt("PAYLOAD_INLINE_MAX_BYTES", 64<<10)),
		PayloadMaxBytes:       int64(envInt("PAYLOAD_MAX_BYTES", 1<<20)),

		PayloadUploadTimeout:    envDuration("PAYLOAD_UPLOAD_TIMEOUT_MS", payloadstore.DefaultUploadTimeout),
		PayloadDownloadTimeout:  envDuration("PAYLOAD_DOWNLOAD_TIMEOUT_MS", payloadstore.DefaultDownloadTimeout),
		PayloadStoreMaxAttempts: envInt("PAYLOAD_STORE_MAX_ATTEMPTS", payloadstore.DefaultMaxAttempts),

		PayloadSweepEnabled:   envBool("PAYLOAD_SWEEP_ENABLED", true),
		PayloadSweepInterval:  envDuration("PAYLOAD_SWEEP_INTERVAL_MS", time.Hour),
		PayloadSweepMinAge:    envDuration("PAYLOAD_SWEEP_MIN_AGE_MS", 24*time.Hour),
		PayloadSweepMaxDelete: envInt("PAYLOAD_SWEEP_MAX_DELETES", 1000),

		IngestPort:      envInt("INGEST_PORT", 8080),
		MetricsPort:     envInt("DATA_PLANE_METRICS_PORT", 9090),
		IngestDBTimeout: envDuration("INGEST_DB_TIMEOUT_MS", ingest.DefaultDBTimeout),
		// Defaults to the same 5s the worker inherited from
		// INGEST_DB_TIMEOUT_MS, so adding the knob changes no shipped
		// behaviour - it only makes the two separately tunable.
		WorkerDBTimeout: envDuration("WORKER_DB_TIMEOUT_MS", ingest.DefaultDBTimeout),

		ShutdownReadinessDelay: envDuration("SHUTDOWN_READINESS_DELAY_MS", 5*time.Second),

		WorkerConcurrency:  envInt("WORKER_CONCURRENCY", 64),
		WorkerPollInterval: envDuration("WORKER_POLL_INTERVAL_MS", 250*time.Millisecond),
		WorkerClaimBatch:   envInt("WORKER_CLAIM_BATCH_SIZE", 100),
		DeliveryLease:      time.Duration(envInt("DELIVERY_LEASE_SECONDS", 120)) * time.Second,
		OutboxPollInterval: envDuration("OUTBOX_POLL_INTERVAL_MS", 250*time.Millisecond),

		EncryptionKey:         os.Getenv("ENCRYPTION_KEY"),
		EncryptionKeyID:       env("ENCRYPTION_KEY_ID", "k1"),
		EncryptionKeysRetired: os.Getenv("ENCRYPTION_KEYS_RETIRED"),

		RouterBatchSize:                envInt("ROUTER_BATCH_SIZE", 100),
		RouterConcurrency:              envInt("ROUTER_CONCURRENCY", 8),
		RouterLease:                    time.Duration(envInt("ROUTER_LEASE_SECONDS", 60)) * time.Second,
		RouterMaxSubscriptionsPerEvent: envInt("ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT", 1000),
		RouterMaxOutboxAttempts:        envInt("ROUTER_MAX_OUTBOX_ATTEMPTS", 10),
		RouterMaxOutboxRetryDuration:   envDuration("ROUTER_MAX_OUTBOX_RETRY_DURATION_MS", router.DefaultMaxOutboxRetryDuration),

		BreakerFailureThreshold:  envInt("BREAKER_FAILURE_THRESHOLD", 5),
		BreakerDegradedThreshold: envInt("BREAKER_DEGRADED_THRESHOLD", 3),
		BreakerHalfOpenSuccesses: envInt("BREAKER_HALF_OPEN_SUCCESSES", 2),
		BreakerBaseCooldown:      envDuration("BREAKER_BASE_COOLDOWN_MS", 30*time.Second),
		MaxStoredResponseBytes:   envInt("MAX_STORED_RESPONSE_BYTES", 64<<10),

		// Default "fifo" deliberately, inverting ADR-0007's stated default.
		// Nothing has been measured, the prerequisite index and NOT NULL
		// migration have not been applied, and the house rule is to prefer the
		// simplest production-grade option. Flip this to tenant_fair when
		// queue_head_of_line_delay_seconds shows real starvation.
		ClaimStrategy: env("CLAIM_STRATEGY", "fifo"),

		MaxConcurrencyGlobal:   envInt("MAX_CONCURRENCY_GLOBAL", 512),
		MaxConcurrencyPerOrg:   envInt("MAX_CONCURRENCY_PER_ORG", 128),
		MaxConcurrencyProject:  envInt("MAX_CONCURRENCY_PER_PROJECT", 64),
		MaxConcurrencyEndpoint: envInt("MAX_CONCURRENCY_PER_ENDPOINT", 16),

		EgressDNSTimeout:            envDuration("EGRESS_DNS_TIMEOUT_MS", 2*time.Second),
		EgressConnectTimeout:        envDuration("EGRESS_CONNECT_TIMEOUT_MS", 3*time.Second),
		EgressTLSTimeout:            envDuration("EGRESS_TLS_TIMEOUT_MS", 3*time.Second),
		EgressResponseHeaderTimeout: envDuration("EGRESS_RESPONSE_HEADER_TIMEOUT_MS", 10*time.Second),
		EgressTotalTimeout:          envDuration("EGRESS_TOTAL_TIMEOUT_MS", 30*time.Second),
		EgressMaxResponseBytes:      int64(envInt("EGRESS_MAX_RESPONSE_BYTES", 64<<10)),
		EgressMaxRedirects:          envInt("EGRESS_MAX_REDIRECTS", 0),
		// 0 means "derive from WORKER_CONCURRENCY"; see below.
		EgressMaxConnsPerHost:      envInt("EGRESS_MAX_CONNS_PER_HOST", 0),
		EgressAllowPrivateNetworks: envBool("EGRESS_ALLOW_PRIVATE_NETWORKS", false),
		EgressPrivateAllowlist:     splitList(os.Getenv("EGRESS_PRIVATE_ALLOWLIST")),

		OTLPEndpoint: os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
	}

	// The per-host transport ceiling defaults to the worker pool size, because
	// a single process cannot have more than WorkerConcurrency attempts in
	// flight, so WorkerConcurrency connections to one host is exactly enough
	// for the pool to never queue on the transport - and not one connection
	// more than it could use.
	//
	// The alternative, a fixed small number, is what shipped: the ceiling was
	// 16 whatever the pool was, and it sat BELOW MAX_CONCURRENCY_PER_ENDPOINT,
	// MAX_CONCURRENCY_PER_PROJECT and the delivery gate, silently overriding
	// all of them for any customer whose endpoints share a hostname - which is
	// the normal shape. Politeness to a customer's server is real, but it
	// belongs to the controls an operator can see and a customer can be told
	// about (the concurrency gate and the rate limiter), not to a transport
	// constant that makes those controls fiction. Set EGRESS_MAX_CONNS_PER_HOST
	// explicitly to be gentler than the pool; the platform will then queue on
	// the transport on purpose rather than by accident.
	//
	// Only an UNSET knob derives. A negative one is rejected below rather than
	// quietly replaced, because silently substituting a number for the one an
	// operator wrote is the failure mode this whole change exists to remove.
	if c.EgressMaxConnsPerHost == 0 && c.WorkerConcurrency > 0 {
		c.EgressMaxConnsPerHost = c.WorkerConcurrency
	}

	// Guard rails that have bitten real deployments.
	if c.AppEnv == "production" && c.EgressAllowPrivateNetworks {
		problems = append(problems,
			"EGRESS_ALLOW_PRIVATE_NETWORKS must not be true in production; use EGRESS_PRIVATE_ALLOWLIST for specific subnets")
	}
	if c.PayloadInlineMaxBytes > c.PayloadMaxBytes {
		problems = append(problems, "PAYLOAD_INLINE_MAX_BYTES cannot exceed PAYLOAD_MAX_BYTES")
	}
	if c.PayloadUploadTimeout <= 0 {
		problems = append(problems, "PAYLOAD_UPLOAD_TIMEOUT_MS must be positive; an unbounded upload holds an ingest request open")
	}
	if c.PayloadDownloadTimeout <= 0 {
		problems = append(problems, "PAYLOAD_DOWNLOAD_TIMEOUT_MS must be positive; an unbounded download holds a worker slot open")
	}
	if c.PayloadStoreMaxAttempts <= 0 {
		problems = append(problems, "PAYLOAD_STORE_MAX_ATTEMPTS must be positive")
	}
	if c.PayloadSweepEnabled && c.PayloadSweepMinAge < payloadstore.MinAgeFloor {
		problems = append(problems, fmt.Sprintf(
			"PAYLOAD_SWEEP_MIN_AGE_MS must be at least %d; a shorter window races an ingest request that is between its upload and its COMMIT",
			payloadstore.MinAgeFloor.Milliseconds()))
	}
	if c.S3Bucket != "" && c.S3Prefix == "" {
		problems = append(problems, "S3_PREFIX must not be empty; the sweep needs a namespace it can be sure the platform owns")
	}
	if c.WorkerConcurrency <= 0 {
		problems = append(problems, "WORKER_CONCURRENCY must be positive; unbounded worker pools are not permitted")
	}
	if _, err := queue.ParseStrategy(c.ClaimStrategy); err != nil {
		problems = append(problems, "CLAIM_STRATEGY is invalid: "+err.Error())
	}
	if c.IngestDBTimeout <= 0 {
		problems = append(problems, "INGEST_DB_TIMEOUT_MS must be positive; an unbounded ingest query exhausts the pool")
	}
	if c.DatabaseStatementTimeout > 0 && c.DatabaseStatementTimeout < c.IngestDBTimeout {
		problems = append(problems,
			"DATABASE_STATEMENT_TIMEOUT_MS must not be below INGEST_DB_TIMEOUT_MS; the server-side backstop would fire first and mask the request deadline")
	}
	if c.WorkerDBTimeout <= 0 {
		problems = append(problems, "WORKER_DB_TIMEOUT_MS must be positive; an unbounded delivery query holds a pool connection and a lease")
	}
	if c.DatabaseStatementTimeout > 0 && c.DatabaseStatementTimeout < c.WorkerDBTimeout {
		problems = append(problems,
			"DATABASE_STATEMENT_TIMEOUT_MS must not be below WORKER_DB_TIMEOUT_MS; the server-side backstop would fire first and mask the delivery deadline")
	}
	if c.ShutdownReadinessDelay < 0 {
		problems = append(problems, "SHUTDOWN_READINESS_DELAY_MS must not be negative")
	}
	if c.ShutdownReadinessDelay > MaxShutdownReadinessDelay {
		problems = append(problems, fmt.Sprintf(
			"SHUTDOWN_READINESS_DELAY_MS must not exceed %d; the delay plus the longest role drain (%s) has to fit inside the process shutdown grace",
			MaxShutdownReadinessDelay.Milliseconds(), ingest.DrainTimeout))
	}
	if c.TrustedProxyHops < 0 {
		problems = append(problems, "INGEST_TRUSTED_PROXY_HOPS must not be negative")
	}
	if c.RateLimitPolicyCacheTTL <= 0 {
		problems = append(problems, "RATE_LIMIT_POLICY_CACHE_TTL_MS must be positive; an uncached policy lookup puts a query on the ingest hot path")
	}
	// A burst below the limit means the bucket cannot hold one window's worth
	// of tokens, so the configured limit is unreachable - the same check the
	// control plane enforces on rate_limit_policies rows.
	if c.IngestRateLimit > 0 && c.IngestRateLimitBurst > 0 && c.IngestRateLimitBurst < c.IngestRateLimit {
		problems = append(problems, "INGEST_RATE_LIMIT_BURST must not be below INGEST_RATE_LIMIT")
	}
	if c.IngestRateLimit > 0 && c.IngestRateLimitWindowSeconds <= 0 {
		problems = append(problems, "INGEST_RATE_LIMIT_WINDOW_SECONDS must be positive")
	}
	if c.IngestSourceRateLimit > 0 && c.IngestSourceRateLimitBurst > 0 &&
		c.IngestSourceRateLimitBurst < c.IngestSourceRateLimit {
		problems = append(problems, "INGEST_SOURCE_RATE_LIMIT_BURST must not be below INGEST_SOURCE_RATE_LIMIT")
	}
	if c.IngestSourceRateLimit > 0 && c.IngestSourceRateLimitWindowSeconds <= 0 {
		problems = append(problems, "INGEST_SOURCE_RATE_LIMIT_WINDOW_SECONDS must be positive")
	}
	if c.IngestSourceAuthFailurePenalty < 0 {
		problems = append(problems, "INGEST_SOURCE_AUTH_FAILURE_PENALTY must not be negative")
	}
	if c.MaxConcurrencyEndpoint > c.MaxConcurrencyProject {
		problems = append(problems, "MAX_CONCURRENCY_PER_ENDPOINT cannot exceed MAX_CONCURRENCY_PER_PROJECT")
	}
	if c.EgressMaxConnsPerHost <= 0 {
		problems = append(problems,
			"EGRESS_MAX_CONNS_PER_HOST must be positive; net/http reads zero as UNLIMITED connections to one host, which is not a bound")
	}

	if len(problems) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  - %s", strings.Join(problems, "\n  - "))
	}
	return c, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}

// envDuration reads a millisecond count, so operators tune with plain integers.
func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	ms, err := strconv.Atoi(v)
	if err != nil || ms < 0 {
		return fallback
	}
	return time.Duration(ms) * time.Millisecond
}

func splitList(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
