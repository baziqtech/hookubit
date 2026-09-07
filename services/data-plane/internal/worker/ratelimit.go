package worker

import (
	"context"
	"sync"
	"time"
)

// RateLimiter decides whether one more delivery may go out to a scope right
// now, and if not, how long to wait (ARCHITECTURE.md 25).
//
// It is an interface for the same reason internal/ingest's is: the production
// implementation is a Redis token bucket shared by every worker process, and
// the seam has to exist before that lands or the delivery loop cannot be
// tested without Redis.
type RateLimiter interface {
	// Allow consumes one token from key's bucket. It returns whether the
	// delivery may proceed and, when it may not, how long until it could.
	//
	// Implementations MUST fail open on their own faults: a rate limiter that
	// cannot reach its store and therefore refuses everything has converted a
	// Redis blip into a platform-wide delivery outage.
	Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration)
}

// NoRateLimit allows everything. Used when an endpoint has no rate_limit set.
type NoRateLimit struct{}

// Allow always permits.
func (NoRateLimit) Allow(context.Context, string, int, time.Duration) (bool, time.Duration) {
	return true, 0
}

// TokenBucket is the in-process limiter: `limit` tokens per `window`, refilled
// continuously, burst equal to the limit (ARCHITECTURE.md 25).
//
// Honest about its scope: this bucket is per PROCESS. Run eight workers and an
// endpoint configured for 100/s receives up to 800/s. That is a real gap, and
// it is why the interface exists - the Redis implementation makes the bucket
// fleet-wide. Until then this still does the job it most needs to do, which is
// stopping ONE worker from hammering one endpoint flat out.
type TokenBucket struct {
	now func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
	// sweepAfter is when idle buckets are next pruned. Pruning on a schedule
	// rather than on every call keeps the hot path a map lookup.
	sweepAfter time.Time
}

type bucket struct {
	tokens   float64
	capacity float64
	// ratePerSec is refill speed; recomputed if the endpoint's limit changes.
	ratePerSec float64
	updatedAt  time.Time
	lastUsed   time.Time
}

// bucketIdleTTL is how long an unused bucket is kept. Long enough that a
// once-a-minute endpoint keeps its state, short enough that the map tracks
// active endpoints rather than every endpoint that ever existed.
const bucketIdleTTL = 10 * time.Minute

// NewTokenBucket builds an in-process limiter. now may be nil.
func NewTokenBucket(now func() time.Time) *TokenBucket {
	if now == nil {
		now = time.Now
	}
	return &TokenBucket{now: now, buckets: make(map[string]*bucket)}
}

// Allow implements RateLimiter.
func (t *TokenBucket) Allow(_ context.Context, key string, limit int, window time.Duration) (bool, time.Duration) {
	if limit <= 0 || window <= 0 {
		return true, 0
	}
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweepLocked(now)

	rate := float64(limit) / window.Seconds()
	b, ok := t.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(limit), capacity: float64(limit), ratePerSec: rate, updatedAt: now}
		t.buckets[key] = b
	}
	if b.capacity != float64(limit) || b.ratePerSec != rate {
		// The policy was edited. Re-cap rather than reset, so an operator
		// raising a limit does not also hand out a full free burst.
		b.capacity = float64(limit)
		b.ratePerSec = rate
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
	}

	if elapsed := now.Sub(b.updatedAt).Seconds(); elapsed > 0 {
		b.tokens += elapsed * b.ratePerSec
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
		b.updatedAt = now
	}
	b.lastUsed = now

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / b.ratePerSec * float64(time.Second))
	if wait <= 0 {
		wait = time.Millisecond
	}
	return false, wait
}

func (t *TokenBucket) sweepLocked(now time.Time) {
	if now.Before(t.sweepAfter) {
		return
	}
	t.sweepAfter = now.Add(time.Minute)
	for key, b := range t.buckets {
		if now.Sub(b.lastUsed) > bucketIdleTTL {
			delete(t.buckets, key)
		}
	}
}
