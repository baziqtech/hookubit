package ratelimit

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
)

// Decision is the answer for one request.
//
// RetryAfter is what the caller puts in the `Retry-After` header and in
// `details.retry_after_seconds`; Scope names the bucket that refused, so a
// support conversation can start with "which ceiling" instead of "which
// ceiling?".
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
	Scope      Scope
	// Limit and Window describe the bucket that refused. Zero when allowed.
	Limit  int
	Window time.Duration
}

// Allowed is the decision for a request nothing objected to.
var Allowed = Decision{Allowed: true}

// Options configures a Limiter.
type Options struct {
	// Source supplies rate_limit_policies rows. Wrap it in a CachingSource;
	// an uncached source puts a query on the ingest hot path.
	Source PolicySource
	// Redis is the fleet-wide bucket store. Nil means in-process only, which
	// is a supported (and loudly announced) configuration.
	Redis Scripter
	// Local is the fallback and the nil-Redis implementation.
	Local *Local
	// Default is the platform ingest ceiling used when the database has no
	// ingest-scope row.
	Default Default
	// Timeout bounds one Redis round trip.
	Timeout time.Duration
	// DegradeAfter consecutive Redis faults, stop calling Redis for
	// DegradeCooldown. Without this a black-holed Redis adds Timeout to every
	// single request for as long as the outage lasts.
	DegradeAfter    int
	DegradeCooldown time.Duration
	Logger          *slog.Logger
	Now             func() time.Time
}

// Limiter charges a request against every applicable bucket.
type Limiter struct {
	source  PolicySource
	redis   Scripter
	local   *Local
	def     Default
	timeout time.Duration
	log     *slog.Logger
	now     func() time.Time

	degradeAfter    int
	degradeCooldown time.Duration

	mu           sync.Mutex
	failures     int
	skipRedisTil time.Time
	lastComplain time.Time
}

func New(opts Options) *Limiter {
	l := &Limiter{
		source:          opts.Source,
		redis:           opts.Redis,
		local:           opts.Local,
		def:             opts.Default,
		timeout:         opts.Timeout,
		log:             opts.Logger,
		now:             opts.Now,
		degradeAfter:    opts.DegradeAfter,
		degradeCooldown: opts.DegradeCooldown,
	}
	if l.local == nil {
		l.local = NewLocal(l.now, 0)
	}
	if l.timeout <= 0 {
		l.timeout = 50 * time.Millisecond
	}
	if l.degradeAfter <= 0 {
		l.degradeAfter = 5
	}
	if l.degradeCooldown <= 0 {
		l.degradeCooldown = 5 * time.Second
	}
	if l.log == nil {
		l.log = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if l.now == nil {
		l.now = time.Now
	}
	return l
}

// AllowIngest charges one accepted event against the ingest chain.
//
// It NEVER returns an error that should refuse a request: a policy lookup that
// fails, a Redis that is gone, a bucket store that times out - all of them
// degrade, none of them deny. The one thing that denies is a bucket that
// actually ran out of tokens.
func (l *Limiter) AllowIngest(ctx context.Context, t Target) Decision {
	rows := l.rows(ctx, t)
	return l.charge(ctx, ResolveIngest(rows, t, l.def))
}

// AllowDelivery is the same for the outbound chain, for the buckets that come
// from rate_limit_policies rows; see ResolveDelivery.
//
// The delivery path in internal/worker does NOT go through here, and the reason
// is a shape mismatch rather than an oversight: the ceiling it enforces is
// endpoints.rate_limit, a column already loaded onto the delivery row, and its
// seam (worker.RateLimiter) is handed a key, a limit and a window rather than a
// tenant identity. AllowBucket is that entry point. Wiring the policy-row chain
// onto the delivery path as well means widening that seam to carry the
// organisation and project ids, which is a change to the worker's interface and
// not to this one.
func (l *Limiter) AllowDelivery(ctx context.Context, t Target) Decision {
	rows := l.rows(ctx, t)
	return l.charge(ctx, ResolveDelivery(rows, t))
}

// AllowBucket charges one already-resolved bucket and reports whether the
// caller may proceed, and if not, how long until it could.
//
// This is what makes a per-endpoint delivery limit fleet-wide: it goes through
// the same take() as every other bucket, which means the same Redis script, the
// same degrade-after-N-faults breaker, and the same fall back to the in-process
// bucket when Redis is unreachable. Redis is never authoritative here - losing
// it costs the ceiling its fleet-wide scope, never a delivery (ARCHITECTURE.md
// 14).
//
// It does NOT emit rate_limit_hits: the delivery path labels that metric with
// its own scope, and counting the refusal in both places would double it.
func (l *Limiter) AllowBucket(ctx context.Context, b Bucket) (bool, time.Duration) {
	return l.take(ctx, b)
}

func (l *Limiter) rows(ctx context.Context, t Target) []Row {
	if l.source == nil {
		return nil
	}
	rows, err := l.source.Policies(ctx, t.OrganizationID, t.ProjectID)
	if err != nil {
		metrics.RateLimiterDegraded.WithLabelValues("policy_lookup").Inc()
		l.complain("rate limit policy lookup failed; falling back to the configured default", err)
		return nil
	}
	return rows
}

// charge applies every resolved bucket.
//
// Every bucket is charged even once one has refused, which is deliberate and
// matches the control plane's own throttle: if a tripped project ceiling
// stopped the organisation bucket from being charged, an attacker inside one
// project could shelter the rest of the organisation's budget from accounting.
// The FIRST refusal decides the response, because it is the most specific.
func (l *Limiter) charge(ctx context.Context, buckets []Bucket) Decision {
	decision := Allowed
	for _, b := range buckets {
		allowed, wait := l.take(ctx, b)
		if allowed || !decision.Allowed {
			continue
		}
		metrics.RateLimitHits.WithLabelValues(string(b.Scope)).Inc()
		decision = Decision{
			Allowed:    false,
			RetryAfter: wait,
			Scope:      b.Scope,
			Limit:      b.Limit,
			Window:     b.Window,
		}
	}
	return decision
}

func (l *Limiter) take(ctx context.Context, b Bucket) (bool, time.Duration) {
	if l.redis != nil && l.redisUsable() {
		callCtx, cancel := context.WithTimeout(ctx, l.timeout)
		allowed, wait, err := l.redis.Take(callCtx, b.Key, b.Capacity, b.RatePerSec, 1, ttlFor(b))
		cancel()
		if err == nil {
			l.redisRecovered()
			return allowed, wait
		}
		l.redisFailed(err)
	}
	// Degraded, or never configured. The in-process bucket is per replica, so
	// the effective ceiling is N x limit across N pods. That is the deliberate
	// trade: a fleet of pods each enforcing the limit locally is a far smaller
	// error than no ceiling at all, and infinitely smaller than refusing every
	// request because a cache is down (ARCHITECTURE.md 14).
	return l.local.Allow(b.Key, b.Capacity, b.RatePerSec, 1)
}

// redisUsable reports whether Redis is worth trying right now.
func (l *Limiter) redisUsable() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.now().Before(l.skipRedisTil)
}

func (l *Limiter) redisRecovered() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failures == 0 {
		return
	}
	l.failures = 0
	l.log.Info("rate limiter reconnected to redis; fleet-wide buckets are authoritative again")
}

func (l *Limiter) redisFailed(err error) {
	metrics.RateLimiterDegraded.WithLabelValues("redis").Inc()

	l.mu.Lock()
	l.failures++
	tripped := l.failures >= l.degradeAfter
	if tripped {
		l.skipRedisTil = l.now().Add(l.degradeCooldown)
	}
	l.mu.Unlock()

	l.complain("rate limiter degraded to in-process buckets; limits are now per replica", err)
}

// complain logs at most once every complainInterval.
//
// This matters: the failure it reports happens once per request, and a Redis
// outage under load would otherwise write a log line per event - turning a
// degradation into a log-volume incident on top of it. The metric
// (rate_limiter_degraded_total) is the thing to alert on; the log is the thing
// to read afterwards.
const complainInterval = 10 * time.Second

func (l *Limiter) complain(msg string, err error) {
	now := l.now()
	l.mu.Lock()
	if now.Sub(l.lastComplain) < complainInterval {
		l.mu.Unlock()
		return
	}
	l.lastComplain = now
	l.mu.Unlock()
	l.log.Error(msg, "error", err.Error())
}
