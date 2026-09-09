package ratelimit

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sync/errgroup"
)

// fakeRedis stands in for a Redis server.
//
// It holds the bucket state in a map behind one mutex and applies the same
// arithmetic the Lua script does, so it exercises the whole limiter: key
// naming, argument order, TTLs, the fail-open path and the degrade cooldown.
// What it CANNOT exercise is the Lua text itself - that is what
// TestLiveRedisTokenBucket, gated on REDIS_TEST_URL, is for.
type fakeRedis struct {
	now func() time.Time

	mu      sync.Mutex
	state   map[string]State
	calls   int
	err     error
	lastTTL time.Duration
}

func newFakeRedis(now func() time.Time) *fakeRedis {
	return &fakeRedis{now: now, state: map[string]State{}}
}

func (f *fakeRedis) Take(
	_ context.Context, key string, capacity, ratePerSec, cost float64, ttl time.Duration,
) (bool, time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return false, 0, f.err
	}
	f.lastTTL = ttl
	next, allowed, wait := Take(f.state[key], f.now(), capacity, ratePerSec, cost)
	f.state[key] = next
	return allowed, wait, nil
}

func (f *fakeRedis) fail(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeRedis) heal() { f.fail(nil) }

func (f *fakeRedis) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// staticSource returns a fixed policy set, or an error.
type staticSource struct {
	rows []Row
	err  error
	mu   sync.Mutex
	hits int
}

func (s *staticSource) Policies(context.Context, string, string) ([]Row, error) {
	s.mu.Lock()
	s.hits++
	s.mu.Unlock()
	return s.rows, s.err
}

func newTestLimiter(t *testing.T, clk *clock, src PolicySource, redis Scripter, def Default) (*Limiter, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	l := New(Options{
		Source:  src,
		Redis:   redis,
		Local:   NewLocal(clk.now, 0),
		Default: def,
		Logger:  slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Now:     clk.now,
	})
	return l, &logs
}

func TestLimiterChargesEveryApplicableBucket(t *testing.T) {
	clk := newClock()
	redis := newFakeRedis(clk.now)
	src := &staticSource{rows: []Row{
		{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 100, WindowSeconds: 1},
		{Scope: ScopeProject, ResourceID: ptr(projectID), Limit: 2, WindowSeconds: 1},
		{Scope: ScopeOrganization, ResourceID: ptr(orgID), Limit: 100, WindowSeconds: 1},
	}}
	l, _ := newTestLimiter(t, clk, src, redis, Default{})

	for i := 0; i < 2; i++ {
		if d := l.AllowIngest(context.Background(), target); !d.Allowed {
			t.Fatalf("request %d refused early", i+1)
		}
	}
	d := l.AllowIngest(context.Background(), target)
	if d.Allowed {
		t.Fatal("the project ceiling of 2/s did not bite")
	}
	// The tightest ceiling is the one reported, so a support conversation
	// starts with which limit rather than which service.
	if d.Scope != ScopeProject {
		t.Fatalf("refused by %q, want the project ceiling", d.Scope)
	}
	if d.RetryAfter <= 0 {
		t.Fatal("a refusal carried no retry hint")
	}

	// The organisation bucket was charged on all three requests, including the
	// refused one: a tripped inner ceiling must not shelter the outer budget
	// from accounting.
	redis.mu.Lock()
	orgTokens := redis.state["rl:organization:"+orgID+":1s"].Tokens
	redis.mu.Unlock()
	if orgTokens != 97 {
		t.Fatalf("organisation bucket has %v tokens, want 97 (all three requests charged)", orgTokens)
	}
}

func TestLimiterUsesTheConfiguredDefaultWhenTheTableIsEmpty(t *testing.T) {
	clk := newClock()
	l, _ := newTestLimiter(t, clk, &staticSource{}, newFakeRedis(clk.now), Default{Limit: 3, WindowSeconds: 1})

	for i := 0; i < 3; i++ {
		if d := l.AllowIngest(context.Background(), target); !d.Allowed {
			t.Fatalf("request %d refused before the default was spent", i+1)
		}
	}
	if d := l.AllowIngest(context.Background(), target); d.Allowed || d.Scope != ScopeIngest {
		t.Fatalf("the built-in ingest default did not apply: %+v", d)
	}
}

// THE fail-open test. Redis being gone must cost time, never traffic
// (ARCHITECTURE.md 14) - and it must be loud about it.
func TestRedisDownDegradesRatherThanDenies(t *testing.T) {
	clk := newClock()
	redis := newFakeRedis(clk.now)
	redis.fail(errors.New("dial tcp 10.0.0.5:6379: connect: connection refused"))

	l, logs := newTestLimiter(t, clk, &staticSource{}, redis, Default{Limit: 5, WindowSeconds: 1})

	for i := 0; i < 5; i++ {
		if d := l.AllowIngest(context.Background(), target); !d.Allowed {
			t.Fatalf("request %d was DENIED while Redis was down; a cache outage must not become an ingest outage", i+1)
		}
	}

	// Degraded is not unlimited: the in-process bucket still enforces, it just
	// enforces per replica.
	if d := l.AllowIngest(context.Background(), target); d.Allowed {
		t.Fatal("degraded mode enforced nothing at all; the fallback must be a bucket, not a bypass")
	}

	// Loud: a log line, and the metric an operator alerts on.
	if !strings.Contains(logs.String(), "degraded") {
		t.Fatalf("Redis failure was silent; logs were:\n%s", logs.String())
	}
}

// A black-holed Redis must not be dialled on every single request: that adds
// the timeout to every ingest for the length of the outage.
func TestRepeatedRedisFailuresStopCallingRedis(t *testing.T) {
	clk := newClock()
	redis := newFakeRedis(clk.now)
	redis.fail(errors.New("i/o timeout"))
	l, _ := newTestLimiter(t, clk, &staticSource{}, redis, Default{Limit: 1_000_000, WindowSeconds: 1})

	for i := 0; i < 50; i++ {
		l.AllowIngest(context.Background(), target)
	}
	tripped := redis.callCount()
	if tripped >= 50 {
		t.Fatalf("Redis was called %d times across 50 requests; the breaker never tripped", tripped)
	}

	// ... and it must come back on its own once the cooldown expires.
	redis.heal()
	clk.advance(time.Minute)
	l.AllowIngest(context.Background(), target)
	if redis.callCount() == tripped {
		t.Fatal("Redis was never retried after the cooldown; the limiter stayed degraded forever")
	}
}

// A policy lookup that fails must not deny either. It falls back to the
// configured default and says so.
func TestPolicyLookupFailureDegradesToTheDefault(t *testing.T) {
	clk := newClock()
	src := &staticSource{err: errors.New("pool exhausted")}
	l, logs := newTestLimiter(t, clk, src, newFakeRedis(clk.now), Default{Limit: 2, WindowSeconds: 1})

	for i := 0; i < 2; i++ {
		if d := l.AllowIngest(context.Background(), target); !d.Allowed {
			t.Fatal("a failed policy lookup denied a request")
		}
	}
	if d := l.AllowIngest(context.Background(), target); d.Allowed {
		t.Fatal("the configured default was not applied after the lookup failed")
	}
	if !strings.Contains(logs.String(), "policy lookup failed") {
		t.Fatalf("policy lookup failure was silent; logs were:\n%s", logs.String())
	}
}

// The property under concurrency, end to end through the limiter: whatever the
// interleaving, admissions never exceed the configured capacity.
func TestConcurrentRequestsCannotExceedThePolicy(t *testing.T) {
	const capacity = 40
	const callers = 400

	clk := newClock()
	redis := newFakeRedis(clk.now)
	src := &staticSource{rows: []Row{
		{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: capacity, WindowSeconds: 1},
	}}
	l, _ := newTestLimiter(t, clk, src, redis, Default{})

	var mu sync.Mutex
	admitted := 0

	var g errgroup.Group
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		g.Go(func() error {
			<-start
			if l.AllowIngest(context.Background(), target).Allowed {
				mu.Lock()
				admitted++
				mu.Unlock()
			}
			return nil
		})
	}
	close(start)
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	if admitted != capacity {
		t.Fatalf("%d of %d concurrent requests admitted, want exactly %d", admitted, callers, capacity)
	}
}

// --- the delivery path's bucket -------------------------------------------

// BucketFor is how endpoints.rate_limit - a COLUMN on the endpoint, not a
// rate_limit_policies row - becomes a chargeable bucket.
func TestBucketFor(t *testing.T) {
	b := BucketFor(ScopeEndpoint, "endpoint:ep_01", 120, time.Minute)

	if b.Scope != ScopeEndpoint {
		t.Fatalf("scope = %s, want %s", b.Scope, ScopeEndpoint)
	}
	if b.Capacity != 120 {
		t.Fatalf("capacity = %v, want 120", b.Capacity)
	}
	if b.RatePerSec != 2 {
		t.Fatalf("rate = %v/s, want 2 (120 per minute)", b.RatePerSec)
	}
	// Keyed under rl:delivery: so it cannot collide with an endpoint-scope
	// policy row charged through ResolveDelivery. Two ceilings an operator
	// configured separately must be charged separately, or the tighter one
	// silently absorbs the other.
	if b.Key != "rl:delivery:endpoint:ep_01:60s" {
		t.Fatalf("key = %q", b.Key)
	}
	policyRow := bucketOf(Row{Scope: ScopeEndpoint, Limit: 120, WindowSeconds: 60}, "ep_01")
	if b.Key == policyRow.Key {
		t.Fatalf("the endpoint COLUMN and an endpoint-scope policy ROW share the key %q; charging one "+
			"would spend the other's tokens", b.Key)
	}

	// The window is part of the key, so editing it starts a new bucket rather
	// than inheriting the old one's tokens at a different rate.
	if BucketFor(ScopeEndpoint, "endpoint:ep_01", 120, time.Second).Key == b.Key {
		t.Fatal("two windows produced the same bucket key")
	}
	// A window smaller than a second must not divide by a zero seconds count.
	if got := BucketFor(ScopeEndpoint, "endpoint:ep_01", 10, 10*time.Millisecond); got.RatePerSec <= 0 {
		t.Fatalf("sub-second window produced rate %v", got.RatePerSec)
	}
	if got := BucketFor(ScopeEndpoint, "endpoint:ep_01", 10, 0); got.Window != time.Second {
		t.Fatalf("zero window = %s, want a second", got.Window)
	}
}

// AllowBucket is the delivery path's entry point. It must charge ONE shared
// bucket through Redis - that is what stops N worker replicas each granting a
// customer's configured limit - and it must degrade to the in-process bucket
// rather than refusing when Redis is gone.
func TestAllowBucketIsFleetWideAndFailsOpen(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	redis := newFakeRedis(clock)

	// Two limiters, as two worker replicas would be. They share only Redis.
	replicaA := New(Options{Redis: redis, Local: NewLocal(clock, 0), Now: clock, Logger: quietLogger()})
	replicaB := New(Options{Redis: redis, Local: NewLocal(clock, 0), Now: clock, Logger: quietLogger()})

	bucket := BucketFor(ScopeEndpoint, "endpoint:ep_01", 2, time.Minute)
	ctx := context.Background()

	if ok, _ := replicaA.AllowBucket(ctx, bucket); !ok {
		t.Fatal("the first delivery was refused by a bucket of two")
	}
	if ok, _ := replicaB.AllowBucket(ctx, bucket); !ok {
		t.Fatal("the second delivery was refused by a bucket of two")
	}
	// The third must be refused, and the fact that it is refused on the OTHER
	// replica is the whole point: an endpoint configured for 2 gets 2, not 2
	// per pod.
	ok, wait := replicaB.AllowBucket(ctx, bucket)
	if ok {
		t.Fatal("a per-endpoint limit of 2 admitted a third delivery; the bucket is not shared between " +
			"replicas, so a customer's configured limit is multiplied by the pod count")
	}
	if wait <= 0 {
		t.Fatal("a refusal with no wait invites an immediate retry")
	}

	// Redis dies. Delivery must NOT stop: the ceiling degrades to per replica,
	// which is a smaller error than converting a cache outage into a delivery
	// outage (ARCHITECTURE.md 14).
	redis.fail(errors.New("dial tcp: connection refused"))
	if ok, _ := replicaA.AllowBucket(ctx, BucketFor(ScopeEndpoint, "endpoint:ep_02", 5, time.Minute)); !ok {
		t.Fatal("a delivery was refused because Redis was unreachable; the limiter failed CLOSED")
	}
}

// The degrade breaker applies to the delivery path too: a black-holed Redis
// must not add its timeout to every single delivery.
func TestAllowBucketStopsCallingADeadRedis(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	redis := newFakeRedis(clock)
	redis.fail(errors.New("i/o timeout"))

	limiter := New(Options{
		Redis: redis, Local: NewLocal(clock, 0), Now: clock, Logger: quietLogger(),
		DegradeAfter: 3, DegradeCooldown: time.Minute,
	})
	bucket := BucketFor(ScopeEndpoint, "endpoint:ep_01", 1000, time.Second)
	ctx := context.Background()

	for i := 0; i < 20; i++ {
		if ok, _ := limiter.AllowBucket(ctx, bucket); !ok {
			t.Fatalf("delivery %d was refused while Redis was down", i)
		}
	}
	if calls := redis.callCount(); calls > 6 {
		t.Fatalf("the limiter made %d Redis calls across 20 deliveries with DegradeAfter=3; it is not "+
			"backing off, so a black-holed Redis adds its timeout to every delivery", calls)
	}
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}
