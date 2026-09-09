package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/shaq/webhook-platform/services/data-plane/internal/config"
	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ratelimit"
	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
	"github.com/shaq/webhook-platform/services/data-plane/internal/worker"
)

// gaugeValue reads one queue_depth series without a registry round trip.
func gaugeValue(t *testing.T, state string) float64 {
	t.Helper()
	var m dto.Metric
	if err := metrics.QueueDepth.WithLabelValues(state).Write(&m); err != nil {
		t.Fatalf("read queue_depth{state=%q}: %v", state, err)
	}
	return m.GetGauge().GetValue()
}

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// The delivery limiter was the second inert control: ratelimit.AllowDelivery
// was implemented and wired to nothing, runWorker never set Options.Limiter, and
// the worker fell back to its in-process TokenBucket - so a customer's
// endpoints.rate_limit of N was effectively N x the worker replica count.
//
// This asserts the adapter is lossless in the two directions that matter: the
// endpoint's configured ceiling actually refuses, and the refusal carries a wait
// the delivery path can schedule against.
func TestDeliveryLimiterAdapterEnforcesTheEndpointCeiling(t *testing.T) {
	adapter := deliveryLimiter{inner: ratelimit.New(ratelimit.Options{Logger: silentLogger()})}
	ctx := context.Background()

	if ok, _ := adapter.Allow(ctx, "endpoint:ep_01", 1, time.Minute); !ok {
		t.Fatal("the first delivery was refused against a limit of 1")
	}
	ok, wait := adapter.Allow(ctx, "endpoint:ep_01", 1, time.Minute)
	if ok {
		t.Fatal("the endpoint's configured ceiling did not reach the delivery path; the control is inert")
	}
	if wait <= 0 || wait > time.Minute+time.Second {
		t.Fatalf("wait = %s, want a hint inside the 1m window", wait)
	}

	// A different endpoint has its own bucket. One noisy endpoint must not
	// throttle every other endpoint in the fleet.
	if ok, _ := adapter.Allow(ctx, "endpoint:ep_02", 1, time.Minute); !ok {
		t.Fatal("a second endpoint was refused by the first endpoint's bucket")
	}
}

// An endpoint with no rate_limit set must not be charged against anything. This
// is the branch the worker takes for the overwhelming majority of deliveries.
func TestDeliveryLimiterAdapterIsANoOpWithoutALimit(t *testing.T) {
	adapter := deliveryLimiter{inner: ratelimit.New(ratelimit.Options{Logger: silentLogger()})}
	for _, tc := range []struct {
		name   string
		limit  int
		window time.Duration
	}{
		{"no limit", 0, time.Minute},
		{"negative limit", -1, time.Minute},
		{"no window", 10, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, wait := adapter.Allow(context.Background(), "endpoint:ep_01", tc.limit, tc.window)
			if !ok || wait != 0 {
				t.Fatalf("Allow = (%v, %s), want (true, 0)", ok, wait)
			}
		})
	}
}

// Without REDIS_URL the builder must return a genuinely NIL interface, not a
// typed nil and not a limiter wrapping nothing.
//
// Two things turn on it. worker.New only installs its own in-process bucket
// when Options.Limiter is nil, and a nil *T inside an interface is not a nil
// interface - the same trap runIngest documents for the payload store, and
// getting it wrong here would leave every endpoint unlimited rather than
// limited per replica.
func TestBuildDeliveryLimiterIsNilWithoutRedis(t *testing.T) {
	limiter, err := buildDeliveryLimiter(&config.Config{}, silentLogger())
	if err != nil {
		t.Fatalf("buildDeliveryLimiter: %v", err)
	}
	// `limiter != nil` is the EXACT comparison worker.New makes before
	// installing its own bucket, which is why it is the one asserted here.
	if limiter != nil {
		t.Fatalf("limiter = %#v, want a nil interface so worker.New installs its in-process bucket", limiter)
	}
	var _ worker.RateLimiter = limiter
}

// With REDIS_URL set the limiter is built and installed. It must not dial at
// construction time - a Redis that is down at boot must not stop a worker
// starting, because delivery does not depend on Redis (ARCHITECTURE.md 14).
func TestBuildDeliveryLimiterIsBuiltAndDoesNotDialAtStartup(t *testing.T) {
	cfg := &config.Config{RedisURL: "redis://127.0.0.1:1/0", RedisTimeout: 50 * time.Millisecond}

	limiter, err := buildDeliveryLimiter(cfg, silentLogger())
	if err != nil {
		t.Fatalf("buildDeliveryLimiter refused to start with an unreachable Redis: %v", err)
	}
	if limiter == nil {
		t.Fatal("REDIS_URL was set and no limiter was built; endpoint limits stay per replica")
	}

	// And it fails OPEN against that unreachable Redis: the ceiling degrades to
	// the in-process bucket, deliveries keep flowing.
	ok, _ := limiter.Allow(context.Background(), "endpoint:ep_01", 10, time.Minute)
	if !ok {
		t.Fatal("a delivery was refused because Redis was unreachable; the limiter failed CLOSED and a " +
			"cache outage became a delivery outage")
	}
}

// queue_depth is the only instrument that can see a backlog nothing is
// attempting: a delivery deferred by an open circuit breaker or a rate limit
// writes no attempt row and moves no counter, so counters of things that
// happened cannot show it. The gauge was declared and never written.
//
// The collector itself is covered in internal/metrics; what is asserted here is
// the half that lives in this file - that a role actually STARTS it. An
// unstarted collector leaves the gauge absent, and the moment anything else
// writes to it, at a confident permanent zero.
//
// The sentinel is the trick: the gauge is pushed to a value the query can never
// produce, and the assertion is that the scheduler overwrites it. That proves a
// refresh ran, without needing a seeded delivery.
func TestSchedulerStartsTheQueueDepthCollector(t *testing.T) {
	pool := testsupport.Pool(t)

	const sentinel = -1
	metrics.QueueDepth.WithLabelValues(metrics.StateReady).Set(sentinel)
	metrics.QueueDepth.WithLabelValues(metrics.StateDelayed).Set(sentinel)
	metrics.QueueDepth.WithLabelValues(metrics.StateInFlight).Set(sentinel)

	cfg := &config.Config{ClaimStrategy: "fifo"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = runScheduler(ctx, cfg, pool, silentLogger())
	}()

	deadline := time.Now().Add(10 * time.Second)
	for {
		ready := gaugeValue(t, metrics.StateReady)
		if ready != sentinel {
			// This package's own database is empty, so the real answer is zero -
			// published explicitly rather than left absent, which is what an
			// alert rule needs.
			if ready != 0 {
				t.Fatalf("queue_depth{state=ready} = %v on an empty database, want 0", ready)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the scheduler ran for 10s without refreshing queue_depth; the gauge is still at its " +
				"sentinel, so nothing started the collector and the backlog signal does not exist")
		}
		time.Sleep(25 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler did not stop on cancellation")
	}

	// And the refresher does not take the role down with it: runScheduler
	// returned because ITS context was cancelled, not because a metrics query
	// failed. Re-running Refresh against a closed context proves the collector
	// swallows that rather than propagating it.
	if err := metrics.NewQueueDepthCollector(pool, queueDepthInterval, silentLogger()).Run(ctx); err != nil {
		t.Fatalf("the queue depth collector returned %v on cancellation; a metrics refresher must never "+
			"be the reason a role exits", err)
	}
}

// REGRESSION. This is the wiring the load suite caught: runWorker built its
// egress client with `IdleConnsPerHost: 4` written inline, net/http derived
// MaxConnsPerHost = 16 from it, and that 16 was the real ceiling on concurrent
// requests to any one customer host - below WORKER_CONCURRENCY, below
// MAX_CONCURRENCY_PER_ENDPOINT, and unreachable from any environment variable.
//
// The chain that must hold is config -> egress.Limits -> transport. The other
// two links are pinned in internal/config and internal/egress; this pins the
// one in the middle, which is the one that was wrong.
func TestEgressLimitsCarryTheConfiguredPerHostCeiling(t *testing.T) {
	cfg := &config.Config{
		EgressMaxConnsPerHost: 96,
		EgressTotalTimeout:    30 * time.Second,
	}
	limits := egressLimits(cfg)
	if limits.MaxConnsPerHost != 96 {
		t.Fatalf("MaxConnsPerHost = %d, want the configured 96 (not a constant, and not derived from the idle pool)", limits.MaxConnsPerHost)
	}
	if limits.IdleConnsPerHost != egress.DefaultIdleConnsPerHost {
		t.Fatalf("IdleConnsPerHost = %d, want %d", limits.IdleConnsPerHost, egress.DefaultIdleConnsPerHost)
	}

	// A deliberately small ceiling must not be undone by a larger warm pool.
	limits = egressLimits(&config.Config{EgressMaxConnsPerHost: 2})
	if limits.MaxConnsPerHost != 2 || limits.IdleConnsPerHost != 2 {
		t.Fatalf("limits = {max:%d idle:%d}, want both 2", limits.MaxConnsPerHost, limits.IdleConnsPerHost)
	}
}

// G15. The worker ran every database call on INGEST_DB_TIMEOUT_MS, so tuning
// the deadline of a request a client is waiting on silently retuned a
// background loop that would rather wait than abandon a lease. The payload half
// of the same defect was fixed earlier; this pins both halves at once, which is
// the point of workerTimeouts existing as a function.
func TestWorkerTimeoutsAreItsOwnAndNotTheIngestOne(t *testing.T) {
	cfg := &config.Config{
		IngestDBTimeout:        1500 * time.Millisecond,
		WorkerDBTimeout:        9 * time.Second,
		PayloadDownloadTimeout: 20 * time.Second,
	}

	db, payload := workerTimeouts(cfg)
	if db != cfg.WorkerDBTimeout {
		t.Fatalf("worker db timeout = %s, want WORKER_DB_TIMEOUT_MS (%s)", db, cfg.WorkerDBTimeout)
	}
	if db == cfg.IngestDBTimeout {
		t.Fatal("the worker is still borrowing INGEST_DB_TIMEOUT_MS")
	}
	if payload != cfg.PayloadDownloadTimeout {
		t.Fatalf("payload timeout = %s, want PAYLOAD_DOWNLOAD_TIMEOUT_MS (%s)", payload, cfg.PayloadDownloadTimeout)
	}
	// The object fetch must not be clamped by the database budget: that was the
	// half of G10 that got fixed, and it is easy to re-break by passing one
	// value to both.
	if payload <= db {
		t.Fatal("this fixture no longer proves the payload budget can exceed the database one")
	}
}

// G17. Without REDIS_URL an endpoint's configured rate limit is enforced once
// per worker replica, so the number a customer actually gets is their limit
// times the replica count - and it changes whenever the Deployment is scaled.
// It was logged once at WARN and refused by nothing, including in production.
func TestBuildDeliveryLimiterRefusesPerReplicaLimitsInProduction(t *testing.T) {
	cfg := &config.Config{AppEnv: "production"}

	limiter, err := buildDeliveryLimiter(cfg, silentLogger())
	if err == nil {
		t.Fatal("a production worker started with customer rate limits silently multiplied by the replica count")
	}
	if limiter != nil {
		t.Fatalf("a limiter was returned alongside the refusal: %#v", limiter)
	}
	if !strings.Contains(err.Error(), "DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA") {
		t.Fatalf("the refusal does not name the escape hatch: %v", err)
	}
}

// Refusing has to be escapable, or an operator with one worker replica and no
// Redis cannot run at all. The escape is explicit and written down in
// configuration, which is the entire difference from the silent downgrade.
func TestBuildDeliveryLimiterAllowsAcknowledgedPerReplicaLimits(t *testing.T) {
	cfg := &config.Config{AppEnv: "production", DeliveryRateLimitAllowPerReplica: true}

	limiter, err := buildDeliveryLimiter(cfg, silentLogger())
	if err != nil {
		t.Fatalf("an acknowledged per-replica deployment was refused: %v", err)
	}
	// Still a genuinely nil interface, so worker.New installs its in-process
	// bucket. The acknowledgement changes the CONFIGURATION gate and nothing
	// about the runtime.
	if limiter != nil {
		t.Fatalf("limiter = %#v, want a nil interface", limiter)
	}
	if got := simpleGaugeValue(t, metrics.DeliveryRateLimitFleetWide); got != 0 {
		t.Fatalf("delivery_rate_limit_fleet_wide = %v, want 0 while limits are per replica", got)
	}
}

// And the gauge is the dashboard half of the same fact. An instrument that is
// declared and never written reads as a confident zero; this one has to mean
// something in BOTH directions.
func TestDeliveryLimiterPublishesItsScope(t *testing.T) {
	cfg := &config.Config{RedisURL: "redis://127.0.0.1:1/0", RedisTimeout: 50 * time.Millisecond}
	if _, err := buildDeliveryLimiter(cfg, silentLogger()); err != nil {
		t.Fatalf("buildDeliveryLimiter: %v", err)
	}
	if got := simpleGaugeValue(t, metrics.DeliveryRateLimitFleetWide); got != 1 {
		t.Fatalf("delivery_rate_limit_fleet_wide = %v, want 1 with a shared store configured", got)
	}

	if _, err := buildDeliveryLimiter(&config.Config{}, silentLogger()); err != nil {
		t.Fatalf("buildDeliveryLimiter: %v", err)
	}
	if got := simpleGaugeValue(t, metrics.DeliveryRateLimitFleetWide); got != 0 {
		t.Fatalf("delivery_rate_limit_fleet_wide = %v, want 0 with no shared store", got)
	}
}

// simpleGaugeValue reads an unlabelled gauge without a registry round trip.
func simpleGaugeValue(t *testing.T, g prometheus.Gauge) float64 {
	t.Helper()
	var m dto.Metric
	if err := g.Write(&m); err != nil {
		t.Fatalf("read gauge: %v", err)
	}
	return m.GetGauge().GetValue()
}

// G13(a). The advisories are what converts an invisible failure into a known
// one, so the worker role has to actually emit them - an advisory nothing logs
// is the same discoverability defect it was written to close.
func TestWorkerRoleWouldWarnAtTheShippedDefaults(t *testing.T) {
	cfg, err := shippedDefaults(t)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	advisories := cfg.ConcurrencyAdvisories()
	if len(advisories) == 0 {
		t.Fatal("the shipped defaults produce no isolation advisory; nothing would be logged at worker startup")
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	for _, a := range advisories {
		log.Warn(a.Message, a.Fields...)
	}
	out := buf.String()
	// The arithmetic has to be in the record, or an operator has to find
	// docs/FAILURE_RECOVERY.md to act on it.
	for _, want := range []string{"worker_concurrency=64", "max_concurrency_per_endpoint=16", "endpoints_to_fill_the_pool=4"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the warning does not carry %q:\n%s", want, out)
		}
	}
}

// shippedDefaults loads a Config with nothing but the required variables set,
// which is the configuration a deployment gets when it tunes none of this.
func shippedDefaults(t *testing.T) (*config.Config, error) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://user:pass@db:5432/webhooks")
	return config.Load()
}

// `all` mode must not survive the loss of one role.
//
// The state this guards against is the worst one available: the worker refuses
// to start - in production without Redis, delivery rate limits would silently
// become per-replica - while ingest keeps answering 202. Events are accepted
// durably and nothing delivers them, and every probe stays green because
// liveness does not know a role is missing.
func TestRunAllStopsEveryRoleWhenOneFails(t *testing.T) {
	// The pool FIRST: shippedDefaults calls t.Setenv on DATABASE_URL with a
	// placeholder host, and testsupport.Pool reads that variable when it runs.
	pool := testsupport.Pool(t)

	cfg, err := shippedDefaults(t)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	// A worker that refuses: production, no Redis, downgrade not acknowledged.
	cfg.AppEnv = "production"
	cfg.RedisURL = ""
	cfg.DeliveryRateLimitAllowPerReplica = false

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- runAll(ctx, cfg, pool, silentLogger(), "wrk_all_test") }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("runAll returned nil after a role refused to start; the process would stay up " +
				"accepting events with nothing delivering them")
		}
		if !strings.Contains(err.Error(), "worker") {
			t.Fatalf("error does not name the failing role: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("runAll did not return after a role failed; the surviving roles were left running, " +
			"which is the half-running state this test exists to prevent")
	}
}
