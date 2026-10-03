package worker

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/metrics"
)

// HealthState is a member of the "EndpointHealthState" enum on endpoint_health.
type HealthState string

const (
	HealthHealthy  HealthState = "healthy"
	HealthDegraded HealthState = "degraded"
	HealthOpen     HealthState = "open"
	HealthHalfOpen HealthState = "half_open"
)

// Health is one endpoint_health row.
type Health struct {
	State                HealthState
	ConsecutiveFailures  int
	ConsecutiveSuccesses int
	OpenedAt             time.Time
	ProbeAfter           time.Time
}

// BreakerConfig tunes the circuit breaker (ARCHITECTURE.md 26).
type BreakerConfig struct {
	// DegradedThreshold is the consecutive-failure count at which an endpoint
	// is flagged for an operator without yet being throttled.
	DegradedThreshold int
	// OpenThreshold is where delivery pressure is actually removed.
	OpenThreshold int
	// BaseCooldown is how long the breaker stays shut on the first open.
	BaseCooldown time.Duration
	// MaxCooldown caps the doubling, so a permanently dead endpoint is probed
	// occasionally rather than never.
	MaxCooldown time.Duration
	// HalfOpenSuccesses is how many consecutive probe successes close the
	// breaker.
	HalfOpenSuccesses int
	// HalfOpenTTL bounds how long one worker may hold the probe slot. It is
	// the recovery path for a worker that dies mid-probe: without it a crashed
	// prober leaves the endpoint half_open and undeliverable forever.
	HalfOpenTTL time.Duration
	// JitterRatio spreads the cooldown so a thousand endpoints that failed
	// together do not all probe in the same millisecond.
	JitterRatio float64
}

// DefaultBreakerConfig is deliberately slow to open and quick to probe: opening
// on a transient blip costs a customer real deliveries, while probing often
// costs one request.
func DefaultBreakerConfig() BreakerConfig {
	return BreakerConfig{
		DegradedThreshold: 3,
		OpenThreshold:     5,
		BaseCooldown:      30 * time.Second,
		MaxCooldown:       10 * time.Minute,
		HalfOpenSuccesses: 1,
		HalfOpenTTL:       time.Minute,
		JitterRatio:       0.2,
	}
}

func (c BreakerConfig) withDefaults() BreakerConfig {
	d := DefaultBreakerConfig()
	if c.DegradedThreshold <= 0 {
		c.DegradedThreshold = d.DegradedThreshold
	}
	if c.OpenThreshold <= 0 {
		c.OpenThreshold = d.OpenThreshold
	}
	if c.OpenThreshold < c.DegradedThreshold {
		c.DegradedThreshold = c.OpenThreshold
	}
	if c.BaseCooldown <= 0 {
		c.BaseCooldown = d.BaseCooldown
	}
	if c.MaxCooldown < c.BaseCooldown {
		c.MaxCooldown = d.MaxCooldown
	}
	if c.MaxCooldown < c.BaseCooldown {
		c.MaxCooldown = c.BaseCooldown
	}
	if c.HalfOpenSuccesses <= 0 {
		c.HalfOpenSuccesses = d.HalfOpenSuccesses
	}
	if c.HalfOpenTTL <= 0 {
		c.HalfOpenTTL = d.HalfOpenTTL
	}
	if c.JitterRatio < 0 || c.JitterRatio > 1 {
		c.JitterRatio = d.JitterRatio
	}
	return c
}

// Cooldown is how long the breaker stays shut after `failures` consecutive
// failures. It doubles per failure past the open threshold and is capped, so a
// flapping endpoint is retried soon and a dead one is left alone.
//
// jitter is a multiplier around 1 (see lockedRand.jitterFactor). Applying it here rather
// than to next_attempt_at is what stops every delivery queued behind an open
// breaker from waking in the same millisecond when it closes.
func (c BreakerConfig) Cooldown(failures int, jitter float64) time.Duration {
	c = c.withDefaults()
	over := failures - c.OpenThreshold
	if over < 0 {
		over = 0
	}
	if over > 20 { // 2^20 is already far past MaxCooldown; stop before the float does anything exciting
		over = 20
	}
	d := float64(c.BaseCooldown) * math.Pow(2, float64(over))
	if d > float64(c.MaxCooldown) {
		d = float64(c.MaxCooldown)
	}
	d *= jitter
	if d < float64(time.Second) {
		d = float64(time.Second)
	}
	return time.Duration(d)
}

// NextHealth is the breaker's transition function, kept pure so every edge can
// be unit tested without a database.
//
// The SQL in store.go implements exactly these rules as a single atomic upsert
// (two workers reporting a failure at the same instant must not both read 4 and
// both write 5). breaker_sql_integration_test.go drives the SQL through this
// same table of cases so the two cannot drift apart unnoticed.
func NextHealth(cur Health, success bool, cfg BreakerConfig, now time.Time, jitter float64) Health {
	cfg = cfg.withDefaults()
	next := cur
	if next.State == "" {
		next.State = HealthHealthy
	}

	if success {
		next.ConsecutiveFailures = 0
		next.ConsecutiveSuccesses = cur.ConsecutiveSuccesses + 1
		if cur.State == HealthHalfOpen && next.ConsecutiveSuccesses < cfg.HalfOpenSuccesses {
			// Still proving itself. Stay half open, but make the probe slot
			// immediately available so the next probe is not delayed.
			next.State = HealthHalfOpen
			next.ProbeAfter = now
			return next
		}
		next.State = HealthHealthy
		next.OpenedAt = time.Time{}
		next.ProbeAfter = time.Time{}
		return next
	}

	next.ConsecutiveSuccesses = 0
	next.ConsecutiveFailures = cur.ConsecutiveFailures + 1

	// A failed probe re-opens immediately, whatever the failure count says:
	// half_open exists precisely to answer "is it back?", and the answer was no.
	opens := cur.State == HealthHalfOpen || next.ConsecutiveFailures >= cfg.OpenThreshold
	switch {
	case opens:
		next.State = HealthOpen
		if next.OpenedAt.IsZero() {
			next.OpenedAt = now
		}
		next.ProbeAfter = now.Add(cfg.Cooldown(next.ConsecutiveFailures, jitter))
	case next.ConsecutiveFailures >= cfg.DegradedThreshold:
		next.State = HealthDegraded
	}
	return next
}

// Verdict is the breaker's answer for one delivery.
type Verdict struct {
	Allowed bool
	// Probe marks the single delivery admitted to test a recovering endpoint.
	Probe bool
	// RetryAfter is when to reschedule a refused delivery.
	RetryAfter time.Time
	Reason     Reason
	State      HealthState
}

// Breaker is the circuit breaker over the endpoint_health table.
//
// PostgreSQL is authoritative (ARCHITECTURE.md 26): the state survives a Redis
// flush and every worker sees the same row. Redis may later front the read as a
// cache, but the probe admission is a conditional UPDATE and must stay in the
// database, because it is the mutual exclusion that stops a thousand workers
// probing a recovering endpoint simultaneously - which would be a thundering
// herd wearing a circuit breaker's clothes.
type Breaker struct {
	store HealthStore
	cfg   BreakerConfig
	now   func() time.Time
	rng   *lockedRand
	log   *slog.Logger
}

// NewBreaker builds a breaker. now and rng may be nil.
func NewBreaker(store HealthStore, cfg BreakerConfig, now func() time.Time, rng *lockedRand, log *slog.Logger) *Breaker {
	if now == nil {
		now = time.Now
	}
	if rng == nil {
		rng = newLockedRand(0)
	}
	if log == nil {
		log = slog.Default()
	}
	return &Breaker{store: store, cfg: cfg.withDefaults(), now: now, rng: rng, log: log}
}

// Config reports the effective configuration.
func (b *Breaker) Config() BreakerConfig { return b.cfg }

// Allow decides whether a delivery to endpointID may be attempted.
//
// It FAILS OPEN on a store error. The breaker is a pressure-relief valve, not
// an authorisation check: if the health read fails, the correct behaviour is to
// attempt the delivery and let the attempt's own outcome speak. Refusing
// deliveries because a SELECT failed converts a database blip into a delivery
// outage.
func (b *Breaker) Allow(ctx context.Context, endpointID string) Verdict {
	now := b.now()
	h, err := b.store.Health(ctx, endpointID)
	if err != nil {
		b.log.Warn("circuit breaker health read failed; allowing delivery",
			"endpoint_id", endpointID, "error", err)
		return Verdict{Allowed: true, State: HealthHealthy}
	}

	switch h.State {
	case "", HealthHealthy, HealthDegraded:
		return Verdict{Allowed: true, State: h.State}
	}

	// open or half_open. A probe is due only when probe_after has passed; the
	// conditional UPDATE inside ClaimProbe is what makes exactly one worker win.
	if h.ProbeAfter.IsZero() || h.ProbeAfter.After(now) {
		return Verdict{
			Allowed:    false,
			RetryAfter: b.retryAfter(h, now),
			Reason:     ReasonBreakerOpen,
			State:      h.State,
		}
	}

	claimed, err := b.store.ClaimProbe(ctx, endpointID, b.cfg.HalfOpenTTL)
	if err != nil {
		b.log.Warn("circuit breaker probe claim failed; allowing delivery",
			"endpoint_id", endpointID, "error", err)
		return Verdict{Allowed: true, State: h.State}
	}
	if !claimed {
		// Another worker is the prober. Come back a little after its slot
		// expires, jittered, so the losers do not all return together.
		return Verdict{
			Allowed:    false,
			RetryAfter: now.Add(b.jittered(b.cfg.HalfOpenTTL)),
			Reason:     ReasonBreakerOpen,
			State:      HealthHalfOpen,
		}
	}
	return Verdict{Allowed: true, Probe: true, State: HealthHalfOpen}
}

func (b *Breaker) retryAfter(h Health, now time.Time) time.Time {
	if !h.ProbeAfter.IsZero() && h.ProbeAfter.After(now) {
		// Spread the wake-ups across the tail of the cooldown rather than
		// stacking every deferred delivery on the same instant.
		return h.ProbeAfter.Add(b.jittered(b.cfg.BaseCooldown / 4))
	}
	return now.Add(b.jittered(b.cfg.BaseCooldown))
}

func (b *Breaker) jittered(d time.Duration) time.Duration {
	j := time.Duration(float64(d) * b.rng.jitterFactor(b.cfg.JitterRatio))
	if j < time.Second {
		j = time.Second
	}
	return j
}

// RecordOutcome reports one attempt's result and advances the health state.
// Best effort by design: a breaker bookkeeping failure must not fail a delivery
// that actually succeeded, so the error is logged and swallowed by the caller.
func (b *Breaker) RecordOutcome(ctx context.Context, endpointID string, success bool) (Health, error) {
	jitter := b.rng.jitterFactor(b.cfg.JitterRatio)
	before, after, err := b.store.RecordOutcome(ctx, endpointID, success, b.cfg, jitter)
	if err != nil {
		return Health{}, err
	}
	if after.State == HealthOpen && before.State != HealthOpen {
		metrics.CircuitBreakerOpened.Inc()
		b.log.Warn("circuit breaker opened",
			"endpoint_id", endpointID,
			"consecutive_failures", after.ConsecutiveFailures,
			"probe_after", after.ProbeAfter,
			"reason", "delivery pressure removed until the endpoint answers a probe")
	}
	if after.State == HealthHealthy && before.State != HealthHealthy && before.State != "" {
		b.log.Info("circuit breaker closed",
			"endpoint_id", endpointID, "previous_state", string(before.State))
	}
	return after, nil
}
