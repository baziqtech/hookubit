package outage_test

import (
	"context"
	"go/parser"
	"go/token"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/queue"
	"github.com/shaq/hookubit/services/data-plane/internal/ratelimit"
)

// deadRedis builds the production Redis scripter pointed at a port nothing is
// listening on. Every Take is a real dial that is really refused - no fake, no
// injected error - with the production 50ms timeouts.
func deadRedis(t *testing.T) *ratelimit.RedisScripter {
	t.Helper()
	client, err := ratelimit.NewRedisClient("redis://"+closedPort(t)+"/0", 50*time.Millisecond)
	if err != nil {
		t.Fatalf("build the redis client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return ratelimit.NewRedisScripter(client)
}

// countingScripter records how often the limiter actually reached for Redis.
type countingScripter struct {
	inner ratelimit.Scripter

	mu    sync.Mutex
	calls int
}

func (c *countingScripter) Take(
	ctx context.Context, key string, capacity, rate, cost float64, ttl time.Duration,
) (bool, time.Duration, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	return c.inner.Take(ctx, key, capacity, rate, cost, ttl)
}

func (c *countingScripter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// policyLimiter mirrors cmd/webhookd's adapter, which is unexported. Keeping a
// copy here is deliberate: it is four lines, and the alternative is testing the
// ingest path with a limiter that is not the one production runs.
type policyLimiter struct{ inner *ratelimit.Limiter }

func (p policyLimiter) Allow(ctx context.Context, scope ingest.Scope) (ingest.LimitDecision, error) {
	d := p.inner.AllowIngest(ctx, ratelimit.Target{
		OrganizationID: scope.OrganizationID,
		ProjectID:      scope.ProjectID,
		APIKeyID:       scope.APIKeyID,
	})
	return ingest.LimitDecision{Allowed: d.Allowed, RetryAfter: d.RetryAfter, LimitedScope: string(d.Scope)}, nil
}

// TestScenario07_RedisUnavailable_IngestFailsOpenAndStillCommits covers
// ARCHITECTURE.md 57 scenario 7: Redis becomes unavailable.
//
// What Redis is here decides the answer, so it is worth stating: Redis is the
// FLEET-WIDE TOKEN BUCKET for rate limiting, and nothing else. It is not the
// job queue (that is PostgreSQL, ADR-0003) and it holds nothing durable
// (ARCHITECTURE.md 14).
//
// Recovery strategy asserted: ingest FAILS OPEN on rate limiting. A refused
// accept costs a customer an event; a Redis outage that refused traffic would
// turn a cache blip into a customer outage. The ceiling is not abandoned - it
// degrades to the in-process bucket, which is per replica rather than
// fleet-wide - and the durable write is completely unaffected.
//
// A production regression would look like: a 429 or a 500 on every request
// while Redis is down, or a limiter fault propagated as an error that the
// handler treats as a rejection.
func TestScenario07_RedisUnavailable_IngestFailsOpenAndStillCommits(t *testing.T) {
	truth := directPool(t)
	seed := seedTenant(t, truth)

	limiter := ratelimit.New(ratelimit.Options{
		Source:  ratelimit.NewCachingSource(ratelimit.NewPostgresSource(truth), time.Minute, nil),
		Redis:   deadRedis(t),
		Default: ratelimit.Default{Limit: 1000, WindowSeconds: 1, Burst: 1000},
		Timeout: 50 * time.Millisecond,
		Logger:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	handler := ingest.New(ingest.Options{
		Store:     ingest.NewPostgresStore(truth),
		Limiter:   policyLimiter{inner: limiter},
		Limits:    generousPayloadLimits(),
		DBTimeout: 5 * time.Second,
		Logger:    slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	rec := postEvent(t, handler, seed.projectID, seed.apiKey, idempotencyKey(t), eventBody)
	if rec.Code == http.StatusTooManyRequests {
		t.Fatal("ingest returned 429 with Redis unreachable: the limiter failed CLOSED, so an outage of a " +
			"component that holds nothing durable became a customer-visible rejection")
	}
	requireStatus(t, rec, http.StatusAccepted)

	// The durable half is untouched: the event and its outbox row committed to
	// PostgreSQL exactly as they would with Redis up.
	accepted := acceptedIDOf(t, rec)
	if n := countEvents(t, truth, accepted); n != 1 {
		t.Fatalf("events rows = %d with Redis down, want 1", n)
	}
	if n := countOutbox(t, truth, accepted); n != 1 {
		t.Fatalf("event_outbox rows = %d with Redis down, want 1: the event would never be routed", n)
	}
}

// TestScenario07_RedisUnavailable_DegradesToPerReplicaCeilings is the other
// half of scenario 7: what is LOST when Redis goes away.
//
// Recovery strategy asserted: the ceiling survives the outage as a per-replica
// one (the in-process bucket still refuses over-limit traffic), and the limiter
// stops calling Redis after DegradeAfter consecutive faults so a black-holed
// Redis cannot add its timeout to every request for the length of the outage.
//
// A production regression would look like: no ceiling at all while Redis is
// down (an outage becomes an open door for a burst), or every request paying
// REDIS_TIMEOUT_MS for the whole incident because nothing trips.
func TestScenario07_RedisUnavailable_DegradesToPerReplicaCeilings(t *testing.T) {
	counter := &countingScripter{inner: deadRedis(t)}
	const degradeAfter = 3

	limiter := ratelimit.New(ratelimit.Options{
		Redis: counter,
		// Two events per second, so the third in the same second must be
		// refused BY THE IN-PROCESS BUCKET.
		Default:         ratelimit.Default{Limit: 2, WindowSeconds: 1},
		Timeout:         50 * time.Millisecond,
		DegradeAfter:    degradeAfter,
		DegradeCooldown: time.Minute,
		Logger:          slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	target := ratelimit.Target{
		OrganizationID: "org_outage",
		ProjectID:      "prj_outage",
		APIKeyID:       "key_outage",
	}
	ctx := context.Background()

	allowed, refused := 0, 0
	for i := 0; i < 12; i++ {
		if limiter.AllowIngest(ctx, target).Allowed {
			allowed++
		} else {
			refused++
		}
	}

	if allowed == 0 {
		t.Fatal("every request was refused with Redis unreachable: the limiter failed closed")
	}
	if refused == 0 {
		t.Fatalf("all %d requests were allowed against a 2/second ceiling: losing Redis disabled rate "+
			"limiting entirely rather than degrading it to a per-replica bucket", allowed+refused)
	}

	// Redis is no longer being called. The exact number does not matter; what
	// matters is that it stopped, because the alternative is paying the dial
	// timeout on every request for the length of the outage.
	tripped := counter.count()
	if tripped > degradeAfter*3 {
		t.Fatalf("the limiter made %d Redis calls across 12 requests with DegradeAfter=%d: it is not "+
			"backing off, so a black-holed Redis would add its timeout to every accept", tripped, degradeAfter)
	}
	before := counter.count()
	for i := 0; i < 5; i++ {
		limiter.AllowIngest(ctx, target)
	}
	if after := counter.count(); after != before {
		t.Fatalf("Redis was called %d more times after the breaker tripped (cooldown is a minute)", after-before)
	}
}

// TestScenario07_RedisUnavailable_DeliveryPathDoesNotDependOnIt asserts the
// claim the architecture makes about blast radius: losing Redis costs
// fleet-wide rate limiting and nothing else. Deliveries keep flowing because
// the queue is PostgreSQL.
//
// The structural half of the assertion is the durable one. A future change that
// puts Redis in front of the queue as the RECORD rather than as a latency
// optimisation would pass every behavioural test written today and lose
// in-flight deliveries in the first Redis restart.
func TestScenario07_RedisUnavailable_DeliveryPathDoesNotDependOnIt(t *testing.T) {
	truth := directPool(t)
	seed := seedTenant(t, truth)
	want := seed.insertDelivery(t, "pending", "", 0)

	// Redis is unreachable for the whole of this test (deadRedis holds a client
	// on a closed port); the claim path never touches it.
	_ = deadRedis(t)

	q := queue.NewPostgresQueue(truth, queue.StrategyFIFO)
	leases, err := q.Claim(context.Background(), "worker_redisless", 10, 30*time.Second)
	if err != nil {
		t.Fatalf("Claim with Redis unreachable: %v", err)
	}
	found := false
	for _, l := range leases {
		if l.Job.DeliveryID == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("delivery %s was not claimable with Redis down", want)
	}

	// The structural guard.
	for _, pkg := range []string{"queue", "worker", "ingest", "router"} {
		if imp, file := importsRedis(t, filepath.Join("..", "..", pkg)); imp {
			t.Fatalf("%s imports go-redis (%s): the durable path must not depend on a store that is "+
				"allowed to lose data (ARCHITECTURE.md 14, ADR-0003)", pkg, file)
		}
	}
}

// importsRedis reports whether any non-test file in dir imports a Redis client.
func importsRedis(t *testing.T, dir string) (bool, string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, spec := range file.Imports {
			if strings.Contains(spec.Path.Value, "redis") {
				return true, path
			}
		}
	}
	return false, ""
}

// TestScenario07_RedisRecovers_BucketsBecomeFleetWideAgain closes the loop:
// once Redis answers again the limiter goes back to it, so the ceiling stops
// being per replica without anybody restarting anything.
//
// It needs a real Redis and skips without one, matching internal/ratelimit's
// own live test.
//
// A production regression would look like: a limiter that trips into local mode
// and never comes back, so a five-minute Redis restart silently leaves the
// fleet enforcing N x the configured limit until the next deploy.
func TestScenario07_RedisRecovers_BucketsBecomeFleetWideAgain(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL is not set; skipping the Redis recovery test")
	}
	live, err := ratelimit.NewRedisClient(url, 2*time.Second)
	if err != nil {
		t.Fatalf("build the live redis client: %v", err)
	}
	t.Cleanup(func() { _ = live.Close() })
	if err := live.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("REDIS_TEST_URL is set but unreachable: %v", err)
	}

	// A scripter that is dead until the test heals it, wrapping the two real
	// implementations rather than a fake.
	healing := &healingScripter{dead: deadRedis(t), live: ratelimit.NewRedisScripter(live)}
	counter := &countingScripter{inner: healing}

	limiter := ratelimit.New(ratelimit.Options{
		Redis:           counter,
		Default:         ratelimit.Default{Limit: 1000, WindowSeconds: 1, Burst: 1000},
		Timeout:         500 * time.Millisecond,
		DegradeAfter:    2,
		DegradeCooldown: 100 * time.Millisecond,
		Logger:          slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	target := ratelimit.Target{
		OrganizationID: "org_" + suffix,
		ProjectID:      "prj_" + suffix,
		APIKeyID:       "key_" + suffix,
	}
	ctx := context.Background()

	// Trip it.
	for i := 0; i < 5; i++ {
		if !limiter.AllowIngest(ctx, target).Allowed {
			t.Fatal("a request was refused while Redis was down")
		}
	}
	tripped := counter.count()

	// Redis comes back, and so does the cooldown.
	healing.heal()
	time.Sleep(200 * time.Millisecond)

	for i := 0; i < 3; i++ {
		if !limiter.AllowIngest(ctx, target).Allowed {
			t.Fatal("a request was refused against a 1000/second ceiling after Redis recovered")
		}
	}
	if counter.count() <= tripped {
		t.Fatalf("the limiter never went back to Redis after the outage (%d calls before, %d after): the "+
			"fleet stays on per-replica ceilings until the process is restarted", tripped, counter.count())
	}
	if !healing.served() {
		t.Fatal("no call reached the live Redis after recovery")
	}
}

// healingScripter is dead until heal() is called, then real.
type healingScripter struct {
	dead ratelimit.Scripter
	live ratelimit.Scripter

	mu      sync.Mutex
	healed  bool
	servedN int
}

func (h *healingScripter) Take(
	ctx context.Context, key string, capacity, rate, cost float64, ttl time.Duration,
) (bool, time.Duration, error) {
	h.mu.Lock()
	healed := h.healed
	if healed {
		h.servedN++
	}
	h.mu.Unlock()
	if healed {
		return h.live.Take(ctx, key, capacity, rate, cost, ttl)
	}
	return h.dead.Take(ctx, key, capacity, rate, cost, ttl)
}

func (h *healingScripter) heal() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.healed = true
}

func (h *healingScripter) served() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.servedN > 0
}
