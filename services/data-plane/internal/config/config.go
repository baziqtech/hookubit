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
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
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

	S3Endpoint       string
	S3Bucket         string
	S3Region         string
	S3AccessKey      string
	S3SecretKey      string
	S3ForcePathStyle bool

	PayloadInlineMaxBytes int64
	PayloadMaxBytes       int64

	IngestPort  int
	MetricsPort int
	// IngestDBTimeout bounds the database work of one accepted request.
	IngestDBTimeout time.Duration

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
	OutboxBatchSize    int

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

		RedisURL: os.Getenv("REDIS_URL"),

		S3Endpoint:       os.Getenv("S3_ENDPOINT"),
		S3Bucket:         os.Getenv("S3_BUCKET"),
		S3Region:         env("S3_REGION", "us-east-1"),
		S3AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:      os.Getenv("S3_SECRET_KEY"),
		S3ForcePathStyle: envBool("S3_FORCE_PATH_STYLE", true),

		PayloadInlineMaxBytes: int64(envInt("PAYLOAD_INLINE_MAX_BYTES", 64<<10)),
		PayloadMaxBytes:       int64(envInt("PAYLOAD_MAX_BYTES", 1<<20)),

		IngestPort:      envInt("INGEST_PORT", 8080),
		MetricsPort:     envInt("DATA_PLANE_METRICS_PORT", 9090),
		IngestDBTimeout: envDuration("INGEST_DB_TIMEOUT_MS", ingest.DefaultDBTimeout),

		ShutdownReadinessDelay: envDuration("SHUTDOWN_READINESS_DELAY_MS", 5*time.Second),

		WorkerConcurrency:  envInt("WORKER_CONCURRENCY", 64),
		WorkerPollInterval: envDuration("WORKER_POLL_INTERVAL_MS", 250*time.Millisecond),
		WorkerClaimBatch:   envInt("WORKER_CLAIM_BATCH_SIZE", 100),
		DeliveryLease:      time.Duration(envInt("DELIVERY_LEASE_SECONDS", 120)) * time.Second,
		OutboxPollInterval: envDuration("OUTBOX_POLL_INTERVAL_MS", 250*time.Millisecond),
		OutboxBatchSize:    envInt("OUTBOX_BATCH_SIZE", 200),

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
		EgressAllowPrivateNetworks:  envBool("EGRESS_ALLOW_PRIVATE_NETWORKS", false),
		EgressPrivateAllowlist:      splitList(os.Getenv("EGRESS_PRIVATE_ALLOWLIST")),

		OTLPEndpoint: os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
	}

	// Guard rails that have bitten real deployments.
	if c.AppEnv == "production" && c.EgressAllowPrivateNetworks {
		problems = append(problems,
			"EGRESS_ALLOW_PRIVATE_NETWORKS must not be true in production; use EGRESS_PRIVATE_ALLOWLIST for specific subnets")
	}
	if c.PayloadInlineMaxBytes > c.PayloadMaxBytes {
		problems = append(problems, "PAYLOAD_INLINE_MAX_BYTES cannot exceed PAYLOAD_MAX_BYTES")
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
	if c.ShutdownReadinessDelay < 0 {
		problems = append(problems, "SHUTDOWN_READINESS_DELAY_MS must not be negative")
	}
	if c.ShutdownReadinessDelay > MaxShutdownReadinessDelay {
		problems = append(problems, fmt.Sprintf(
			"SHUTDOWN_READINESS_DELAY_MS must not exceed %d; the delay plus the longest role drain (%s) has to fit inside the process shutdown grace",
			MaxShutdownReadinessDelay.Milliseconds(), ingest.DrainTimeout))
	}
	if c.MaxConcurrencyEndpoint > c.MaxConcurrencyProject {
		problems = append(problems, "MAX_CONCURRENCY_PER_ENDPOINT cannot exceed MAX_CONCURRENCY_PER_PROJECT")
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
