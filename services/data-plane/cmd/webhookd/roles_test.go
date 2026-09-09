package main

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

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
