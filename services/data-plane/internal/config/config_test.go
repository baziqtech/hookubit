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
