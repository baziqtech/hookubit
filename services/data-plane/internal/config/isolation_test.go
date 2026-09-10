package config

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
)

// fieldsOf turns an Advisory's slog pairs into a map so a test can assert on
// the arithmetic rather than on the sentence.
func fieldsOf(t *testing.T, a Advisory) map[string]any {
	t.Helper()
	if len(a.Fields)%2 != 0 {
		t.Fatalf("advisory fields are not key/value pairs: %v", a.Fields)
	}
	out := map[string]any{}
	for i := 0; i < len(a.Fields); i += 2 {
		key, ok := a.Fields[i].(string)
		if !ok {
			t.Fatalf("advisory field key %v is not a string", a.Fields[i])
		}
		out[key] = a.Fields[i+1]
	}
	return out
}

func advisoryMentioning(t *testing.T, as []Advisory, substr string) (Advisory, bool) {
	t.Helper()
	for _, a := range as {
		if strings.Contains(a.Message, substr) {
			return a, true
		}
	}
	return Advisory{}, false
}

// G13. The rule that decides whether per-endpoint isolation holds -
//
//	sum(max_concurrency of endpoints that can be slow) < WORKER_CONCURRENCY
//
// - was stated nowhere, enforced nowhere and visible in no metric. It is
// measured, not reasoned: docs/LOAD_TESTING.md 7 has the scenario failing at
// 12,660 ms with caps summing to 96 against a pool of 64 and passing at
// 1,782 ms with caps summing to 24.
//
// At the SHIPPED defaults - MAX_CONCURRENCY_PER_ENDPOINT 16 against a
// WORKER_CONCURRENCY of 64 - four endpoints at their ceiling own the whole
// pool. This asserts an operator is told so, with the arithmetic in the record.
func TestShippedDefaultsWarnThatIsolationIsACeilingNotAReservation(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	advisories := cfg.ConcurrencyAdvisories()
	a, ok := advisoryMentioning(t, advisories, "CEILING, not a reservation")
	if !ok {
		t.Fatalf("the shipped defaults (endpoint=%d, pool=%d) produced no isolation advisory: %+v",
			cfg.MaxConcurrencyEndpoint, cfg.WorkerConcurrency, advisories)
	}

	f := fieldsOf(t, a)
	// The arithmetic has to be IN the message an operator sees, or they have to
	// find docs/FAILURE_RECOVERY.md to act on it - which is the discoverability
	// defect this exists to close.
	if got := f["endpoints_to_fill_the_pool"]; got != 4 {
		t.Fatalf("endpoints_to_fill_the_pool = %v, want 4 (64 / 16)", got)
	}
	if got := f["max_concurrency_per_endpoint"]; got != cfg.MaxConcurrencyEndpoint {
		t.Fatalf("advisory reports max_concurrency_per_endpoint %v, config says %d", got, cfg.MaxConcurrencyEndpoint)
	}
	if got := f["worker_concurrency"]; got != cfg.WorkerConcurrency {
		t.Fatalf("advisory reports worker_concurrency %v, config says %d", got, cfg.WorkerConcurrency)
	}
	for _, key := range []string{"arithmetic", "rule", "remedy", "observe"} {
		if s, _ := f[key].(string); s == "" {
			t.Fatalf("advisory has no %q field; an operator cannot act on it without one", key)
		}
	}
}

// The other half of the same breath: MAX_CONCURRENCY_GLOBAL defaults to 512
// against a WORKER_CONCURRENCY of 64, so the gate that READS as the process
// ceiling sits eight times above the real one and can never bind.
func TestShippedDefaultsWarnThatTheGlobalGateCannotBind(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	a, ok := advisoryMentioning(t, cfg.ConcurrencyAdvisories(), "cannot bind")
	if !ok {
		t.Fatalf("MAX_CONCURRENCY_GLOBAL=%d against WORKER_CONCURRENCY=%d produced no advisory",
			cfg.MaxConcurrencyGlobal, cfg.WorkerConcurrency)
	}
	f := fieldsOf(t, a)
	if got := f["max_concurrency_global"]; got != 512 {
		t.Fatalf("max_concurrency_global = %v, want the shipped 512", got)
	}
	if got := f["effective_ceiling"]; got != cfg.WorkerConcurrency {
		t.Fatalf("effective_ceiling = %v, want the worker pool (%d)", got, cfg.WorkerConcurrency)
	}
}

// Provisioned so the arithmetic holds, there is nothing to say. A warning that
// fires on a correctly configured deployment is a warning operators learn to
// ignore, which costs the ones that matter.
func TestNoAdvisoriesWhenTheCeilingsAreProvisionedUnderThePool(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"WORKER_CONCURRENCY":           "64",
		"MAX_CONCURRENCY_PER_ENDPOINT": "4",  // 16 endpoints to fill the pool
		"MAX_CONCURRENCY_PER_PROJECT":  "16", // and no ceiling at or above it
		"MAX_CONCURRENCY_PER_ORG":      "32",
		"MAX_CONCURRENCY_GLOBAL":       "48",
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := cfg.ConcurrencyAdvisories(); len(got) != 0 {
		t.Fatalf("a correctly provisioned deployment was warned: %+v", got)
	}
}

// Advisories are advisories. Taking the data plane down over a tuning choice is
// worse than the starvation it warns about - the starvation is slow webhooks
// for some tenants, a refusal is no webhooks for any of them - and an operator
// whose endpoints are all fast has nothing to isolate from.
func TestConcurrencyAdvisoriesNeverRefuseToStart(t *testing.T) {
	cfg, err := loadWith(t, map[string]string{
		"WORKER_CONCURRENCY":           "4",
		"MAX_CONCURRENCY_PER_ENDPOINT": "4",
		"MAX_CONCURRENCY_PER_PROJECT":  "4",
		"MAX_CONCURRENCY_GLOBAL":       "4096",
	})
	if err != nil {
		t.Fatalf("Load refused a configuration that is merely badly tuned: %v", err)
	}
	if len(cfg.ConcurrencyAdvisories()) == 0 {
		t.Fatal("one endpoint entitled to the entire pool produced no advisory")
	}
}

// G15. The worker ran every database call on INGEST_DB_TIMEOUT_MS, so tuning
// the deadline of a request a client is waiting on silently retuned a
// background loop that would rather wait than abandon a lease. The default is
// unchanged, so adding the knob changes no shipped behaviour; what changes is
// that the two can now move independently.
func TestWorkerDBTimeoutIsSeparateFromTheIngestOne(t *testing.T) {
	cfg, err := loadWith(t, nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.WorkerDBTimeout != ingest.DefaultDBTimeout {
		t.Fatalf("WorkerDBTimeout = %s, want the unchanged %s default", cfg.WorkerDBTimeout, ingest.DefaultDBTimeout)
	}

	cfg, err = loadWith(t, map[string]string{"INGEST_DB_TIMEOUT_MS": "1500"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.WorkerDBTimeout != ingest.DefaultDBTimeout {
		t.Fatalf("retuning INGEST_DB_TIMEOUT_MS moved the worker's budget to %s; the two are still one knob",
			cfg.WorkerDBTimeout)
	}

	// And the reverse. t.Setenv persists for the whole test, so the ingest knob
	// is put back explicitly rather than assumed unset.
	cfg, err = loadWith(t, map[string]string{
		"INGEST_DB_TIMEOUT_MS":          strconv.Itoa(int(ingest.DefaultDBTimeout.Milliseconds())),
		"WORKER_DB_TIMEOUT_MS":          "9000",
		"DATABASE_STATEMENT_TIMEOUT_MS": "30000",
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.WorkerDBTimeout != 9*time.Second {
		t.Fatalf("WorkerDBTimeout = %s, want 9s", cfg.WorkerDBTimeout)
	}
	if cfg.IngestDBTimeout != ingest.DefaultDBTimeout {
		t.Fatalf("setting the worker's budget moved the ingest one to %s", cfg.IngestDBTimeout)
	}
}

// It is bounded, and it is bounded BELOW the server-side backstop - or the
// connection dies before the delivery loop's own deadline can report cleanly.
func TestWorkerDBTimeoutIsValidated(t *testing.T) {
	if _, err := loadWith(t, map[string]string{"WORKER_DB_TIMEOUT_MS": "0"}); err == nil {
		t.Fatal("an unbounded worker database deadline was accepted")
	}
	_, err := loadWith(t, map[string]string{
		"WORKER_DB_TIMEOUT_MS":          "40000",
		"DATABASE_STATEMENT_TIMEOUT_MS": "30000",
	})
	if err == nil {
		t.Fatal("a statement timeout below the worker deadline was accepted; the backstop would mask it")
	}
	if !strings.Contains(err.Error(), "WORKER_DB_TIMEOUT_MS") {
		t.Fatalf("error does not name the offending variable: %v", err)
	}
}

// G17. With no REDIS_URL an endpoint's configured rate limit is enforced once
// per worker replica, so the number a customer gets is their limit times the
// replica count - and it changes when the Deployment is scaled. That is the
// same class of quiet downgrade as EGRESS_ALLOW_PRIVATE_NETWORKS, which IS
// refused in production, and it now gets the same treatment.
func TestPerReplicaDeliveryLimitsAreRefusedInProductionOnly(t *testing.T) {
	cases := []struct {
		name      string
		env       map[string]string
		wantError bool
	}{
		{
			name:      "production, no redis, not acknowledged",
			env:       map[string]string{"APP_ENV": "production"},
			wantError: true,
		},
		{
			name: "production, no redis, acknowledged deliberately",
			env: map[string]string{
				"APP_ENV":                               "production",
				"DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA": "true",
			},
		},
		{
			name: "production with redis",
			env:  map[string]string{"APP_ENV": "production", "REDIS_URL": "redis://redis:6379/0"},
		},
		{
			name: "development, no redis",
			env:  map[string]string{"APP_ENV": "development"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := loadWith(t, tc.env)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			// It is never Load that refuses: only the worker role cares, and
			// ingest, router and scheduler must still start.
			err = cfg.ValidateDeliveryRateLimitScope()
			if tc.wantError && err == nil {
				t.Fatal("a production worker was allowed to enforce customer rate limits per replica, silently")
			}
			if !tc.wantError && err != nil {
				t.Fatalf("refused a legitimate configuration: %v", err)
			}
			if tc.wantError && !strings.Contains(err.Error(), "DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA") {
				t.Fatalf("the refusal does not name the escape hatch: %v", err)
			}
		})
	}
}

// A guard against the obvious accident: making the CONFIGURATION refuse must
// not make the RUNTIME depend on Redis. Load itself must never object to a
// missing REDIS_URL, whatever the environment, because ingest, the router and
// the scheduler all start from the same Config and none of them needs it.
func TestLoadNeverRequiresRedis(t *testing.T) {
	for _, env := range []string{"development", "staging", "production"} {
		if _, err := loadWith(t, map[string]string{"APP_ENV": env}); err != nil {
			t.Fatalf("APP_ENV=%s: Load refused a configuration with no REDIS_URL: %v", env, err)
		}
	}
}

// The advisory arithmetic must survive a division it cannot do, rather than
// panicking the process it was added to protect.
func TestConcurrencyAdvisoriesToleratesDegenerateConfiguration(t *testing.T) {
	for _, c := range []Config{
		{},
		{WorkerConcurrency: 64},
		{MaxConcurrencyEndpoint: 16},
	} {
		if got := c.ConcurrencyAdvisories(); len(got) != 0 {
			t.Fatalf("%+v produced advisories from an impossible division: %v", c, got)
		}
	}
}
