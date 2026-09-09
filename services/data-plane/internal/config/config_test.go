package config

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
)

func loadWith(t *testing.T, env map[string]string) (*Config, error) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://user:pass@db:5432/webhooks")
	for k, v := range env {
		t.Setenv(k, v)
	}
	return Load()
}

// The default is fifo on purpose, inverting ADR-0007's stated default: nothing
// has been measured, the prerequisite index and NOT NULL migration have not
// been applied, and the house rule is the simplest production-grade option.
// This test exists so promoting tenant_fair is a deliberate act with a reason,
// not a quiet edit.
func TestClaimStrategyDefaultsToFIFO(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ClaimStrategy != "fifo" {
		t.Fatalf("ClaimStrategy = %q, want fifo (see HANDOFF.md before changing this)", cfg.ClaimStrategy)
	}
}

func TestClaimStrategyIsOptInAndValidated(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{"CLAIM_STRATEGY": "tenant_fair"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ClaimStrategy != "tenant_fair" {
		t.Fatalf("ClaimStrategy = %q, want tenant_fair", cfg.ClaimStrategy)
	}

	// A typo must stop the process at boot rather than silently pick a
	// strategy nobody asked for.
	_, err = loadWith(t, map[string]string{"CLAIM_STRATEGY": "tenantfair"})
	if err == nil {
		t.Fatal("an unknown CLAIM_STRATEGY was accepted")
	}
	if !strings.Contains(err.Error(), "CLAIM_STRATEGY") {
		t.Fatalf("error does not name the offending variable: %v", err)
	}
}

// Every ingest database call must be bounded: http.Server.WriteTimeout does not
// cancel the request context and pgxpool has no default statement timeout, so
// without these two a stuck query holds a pool connection indefinitely.
func TestIngestAndStatementTimeoutsHaveBoundedDefaults(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.IngestDBTimeout != ingest.DefaultDBTimeout {
		t.Fatalf("IngestDBTimeout = %s, want %s", cfg.IngestDBTimeout, ingest.DefaultDBTimeout)
	}
	if cfg.DatabaseStatementTimeout <= 0 {
		t.Fatal("DatabaseStatementTimeout must have a positive default; it is the server-side backstop")
	}
	if cfg.DatabaseStatementTimeout < cfg.IngestDBTimeout {
		t.Fatal("the backstop must not fire before the request deadline")
	}

	cfg, err = loadWith(t, map[string]string{
		"INGEST_DB_TIMEOUT_MS":          "1500",
		"DATABASE_STATEMENT_TIMEOUT_MS": "4000",
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.IngestDBTimeout != 1500*time.Millisecond || cfg.DatabaseStatementTimeout != 4*time.Second {
		t.Fatalf("overrides not applied: %s / %s", cfg.IngestDBTimeout, cfg.DatabaseStatementTimeout)
	}

	// A statement timeout below the request deadline masks it: the connection
	// dies before the handler's own deadline can report a clean 500.
	if _, err := loadWith(t, map[string]string{
		"INGEST_DB_TIMEOUT_MS":          "5000",
		"DATABASE_STATEMENT_TIMEOUT_MS": "1000",
	}); err == nil {
		t.Fatal("a statement timeout below the ingest deadline was accepted")
	}

	if _, err := loadWith(t, map[string]string{"INGEST_DB_TIMEOUT_MS": "0"}); err == nil {
		t.Fatal("an unbounded ingest deadline was accepted")
	}
}

// The propagation delay is the window in which the process advertises
// not-ready while still accepting, so a load balancer can converge before the
// listener closes. It has to fit inside the shutdown grace alongside the
// longest role drain, or the pod is SIGKILLed mid-drain instead.
func TestShutdownReadinessDelayDefaultsAndIsBounded(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ShutdownReadinessDelay != 5*time.Second {
		t.Fatalf("default readiness delay = %s, want 5s", cfg.ShutdownReadinessDelay)
	}
	if got := cfg.ShutdownReadinessDelay + ingest.DrainTimeout; got > ShutdownGrace {
		t.Fatalf("default delay plus role drain = %s, exceeds shutdown grace %s", got, ShutdownGrace)
	}

	if _, err := loadWith(t, map[string]string{"SHUTDOWN_READINESS_DELAY_MS": "0"}); err != nil {
		t.Fatalf("zero delay must be permitted (opting out of the window): %v", err)
	}

	over := int(MaxShutdownReadinessDelay/time.Millisecond) + 1
	_, err = loadWith(t, map[string]string{
		"SHUTDOWN_READINESS_DELAY_MS": strconv.Itoa(over),
	})
	if err == nil || !strings.Contains(err.Error(), "SHUTDOWN_READINESS_DELAY_MS") {
		t.Fatalf("a delay past the grace budget must be rejected, got %v", err)
	}
}

// The rate-limit knobs, and the guard rails that stop a config change from
// silently producing a limiter that cannot enforce what it advertises.
func TestRateLimitDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://u:p@db:5432/x")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RateLimitPolicyCacheTTL <= 0 {
		t.Fatal("the policy cache TTL must have a positive default; an uncached lookup is a query per event")
	}
	if cfg.IngestSourceRateLimit <= 0 {
		t.Fatal("the pre-auth ceiling must default to ON; it is the only bound on an unauthenticated flood")
	}
	if cfg.TrustedProxyHops != 0 {
		t.Fatal("trusted proxy hops must default to 0: trusting a forwarded header by default lets a client forge its own bucket")
	}
	if cfg.RedisTimeout <= 0 || cfg.RedisTimeout > time.Second {
		t.Fatalf("REDIS_TIMEOUT_MS default = %s; a limiter that can block a request for a second costs more than it saves", cfg.RedisTimeout)
	}
}

func TestRateLimitConfigIsValidated(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "a burst below the limit makes the limit unreachable",
			env:  map[string]string{"INGEST_RATE_LIMIT": "100", "INGEST_RATE_LIMIT_BURST": "10"},
			want: "INGEST_RATE_LIMIT_BURST",
		},
		{
			name: "a source burst below the source limit is the same fault",
			env:  map[string]string{"INGEST_SOURCE_RATE_LIMIT": "100", "INGEST_SOURCE_RATE_LIMIT_BURST": "10"},
			want: "INGEST_SOURCE_RATE_LIMIT_BURST",
		},
		{
			name: "a negative hop count is not a hop count",
			env:  map[string]string{"INGEST_TRUSTED_PROXY_HOPS": "-1"},
			want: "INGEST_TRUSTED_PROXY_HOPS",
		},
		{
			name: "a zero window is a division by zero in the refill rate",
			env:  map[string]string{"INGEST_RATE_LIMIT": "10", "INGEST_RATE_LIMIT_WINDOW_SECONDS": "0"},
			want: "INGEST_RATE_LIMIT_WINDOW_SECONDS",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://u:p@db:5432/x")
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			_, err := Load()
			if err == nil {
				t.Fatal("configuration was accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error does not name %s: %v", tc.want, err)
			}
		})
	}
}

// REGRESSION. The per-host connection ceiling used to be arithmetic, not
// configuration: egress hard-coded IdleConnsPerHost = 4 and net/http derived
// MaxConnsPerHost = 16 from it, so one data-plane process made at most 16
// concurrent requests to any one host:port however large WORKER_CONCURRENCY
// was, and every per-endpoint, per-project and per-org concurrency ceiling
// above it was fiction for any customer whose endpoints share a hostname.
//
// The default now tracks the worker pool: a process cannot have more than
// WorkerConcurrency attempts in flight, so WorkerConcurrency connections to one
// host is exactly enough for the transport never to be the thing that queues.
func TestEgressMaxConnsPerHostDefaultsToTheWorkerPool(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EgressMaxConnsPerHost != cfg.WorkerConcurrency {
		t.Fatalf("EgressMaxConnsPerHost = %d, want WorkerConcurrency (%d): a transport ceiling below the pool silently overrides MAX_CONCURRENCY_PER_ENDPOINT",
			cfg.EgressMaxConnsPerHost, cfg.WorkerConcurrency)
	}

	cfg, err = loadWith(t, map[string]string{"WORKER_CONCURRENCY": "200"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EgressMaxConnsPerHost != 200 {
		t.Fatalf("EgressMaxConnsPerHost = %d, want 200; the default must follow WORKER_CONCURRENCY, not a constant", cfg.EgressMaxConnsPerHost)
	}
}

func TestEgressMaxConnsPerHostIsConfigurableAndBounded(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"WORKER_CONCURRENCY":        "64",
		"EGRESS_MAX_CONNS_PER_HOST": "8",
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Deliberately below the pool is allowed - being gentle with a fragile
	// consumer is a legitimate choice. It must just be a visible one.
	if cfg.EgressMaxConnsPerHost != 8 {
		t.Fatalf("EgressMaxConnsPerHost = %d, want 8", cfg.EgressMaxConnsPerHost)
	}

	// Zero is not "no limit" here. net/http reads MaxConnsPerHost == 0 as
	// unlimited, which is the opposite of what every other bound in this
	// config means, so an explicit non-positive value must not reach the
	// transport. Zero itself means "derive", so negative is the case to check.
	if _, err := loadWith(t, map[string]string{"EGRESS_MAX_CONNS_PER_HOST": "-1"}); err == nil {
		t.Fatal("a negative EGRESS_MAX_CONNS_PER_HOST was accepted")
	} else if !strings.Contains(err.Error(), "EGRESS_MAX_CONNS_PER_HOST") {
		t.Fatalf("error does not name the offending variable: %v", err)
	}
}
