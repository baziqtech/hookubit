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
