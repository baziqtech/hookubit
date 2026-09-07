package worker

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func breakerCfg() BreakerConfig {
	return BreakerConfig{
		DegradedThreshold: 3,
		OpenThreshold:     5,
		BaseCooldown:      30 * time.Second,
		MaxCooldown:       10 * time.Minute,
		HalfOpenSuccesses: 1,
		HalfOpenTTL:       time.Minute,
		JitterRatio:       0,
	}
}

func TestNextHealthTransitions(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	cfg := breakerCfg()

	t.Run("failures walk healthy to degraded to open", func(t *testing.T) {
		h := Health{State: HealthHealthy}
		wantStates := []HealthState{
			HealthHealthy, HealthHealthy, HealthDegraded, HealthDegraded, HealthOpen,
		}
		for i, want := range wantStates {
			h = NextHealth(h, false, cfg, now, 1)
			if h.State != want {
				t.Fatalf("after %d failures state = %s, want %s", i+1, h.State, want)
			}
			if h.ConsecutiveFailures != i+1 {
				t.Fatalf("consecutive_failures = %d, want %d", h.ConsecutiveFailures, i+1)
			}
		}
		if h.OpenedAt.IsZero() {
			t.Fatal("opened_at must be stamped when the breaker opens")
		}
		if !h.ProbeAfter.Equal(now.Add(cfg.BaseCooldown)) {
			t.Fatalf("probe_after = %s, want %s", h.ProbeAfter, now.Add(cfg.BaseCooldown))
		}
	})

	t.Run("a success anywhere short of open closes it", func(t *testing.T) {
		h := Health{State: HealthDegraded, ConsecutiveFailures: 4}
		h = NextHealth(h, true, cfg, now, 1)
		if h.State != HealthHealthy {
			t.Fatalf("state = %s, want healthy", h.State)
		}
		if h.ConsecutiveFailures != 0 {
			t.Fatalf("consecutive_failures = %d, want 0", h.ConsecutiveFailures)
		}
	})

	t.Run("a successful probe closes the breaker", func(t *testing.T) {
		h := Health{State: HealthHalfOpen, ConsecutiveFailures: 7, OpenedAt: now.Add(-time.Hour)}
		h = NextHealth(h, true, cfg, now, 1)
		if h.State != HealthHealthy {
			t.Fatalf("state = %s, want healthy", h.State)
		}
		if !h.OpenedAt.IsZero() || !h.ProbeAfter.IsZero() {
			t.Fatal("closing the breaker must clear opened_at and probe_after")
		}
	})

	t.Run("a failed probe re-opens immediately", func(t *testing.T) {
		h := Health{State: HealthHalfOpen, ConsecutiveFailures: 5, OpenedAt: now.Add(-time.Hour)}
		h = NextHealth(h, false, cfg, now, 1)
		if h.State != HealthOpen {
			t.Fatalf("state = %s, want open; half_open exists to ask 'is it back' and the answer was no", h.State)
		}
		if !h.OpenedAt.Equal(now.Add(-time.Hour)) {
			t.Fatal("opened_at must record the FIRST open, not the latest re-open")
		}
	})

	t.Run("half open holds until the success threshold is met", func(t *testing.T) {
		twoProbes := cfg
		twoProbes.HalfOpenSuccesses = 2
		h := Health{State: HealthHalfOpen, ConsecutiveFailures: 5}

		h = NextHealth(h, true, twoProbes, now, 1)
		if h.State != HealthHalfOpen {
			t.Fatalf("after one probe state = %s, want half_open", h.State)
		}
		if !h.ProbeAfter.Equal(now) {
			t.Fatal("the next probe slot must be immediately available after a successful probe")
		}
		h = NextHealth(h, true, twoProbes, now, 1)
		if h.State != HealthHealthy {
			t.Fatalf("after two probes state = %s, want healthy", h.State)
		}
	})
}

func TestCooldownDoublesAndIsCapped(t *testing.T) {
	cfg := breakerCfg()
	base := cfg.BaseCooldown

	for failures, want := range map[int]time.Duration{
		5: base, 6: 2 * base, 7: 4 * base, 8: 8 * base,
	} {
		if got := cfg.Cooldown(failures, 1); got != want {
			t.Fatalf("Cooldown(%d) = %s, want %s", failures, got, want)
		}
	}
	if got := cfg.Cooldown(50, 1); got != cfg.MaxCooldown {
		t.Fatalf("Cooldown(50) = %s, want the cap %s; a dead endpoint must still be probed occasionally", got, cfg.MaxCooldown)
	}
	// The doubling must not overflow into a nonsense duration.
	if got := cfg.Cooldown(1000, 1); got <= 0 || got > cfg.MaxCooldown {
		t.Fatalf("Cooldown(1000) = %s; the exponent ran away", got)
	}
}

func TestBreakerAdmitsExactlyOneProbe(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	health := newFakeHealth(clock)
	health.set("ep_1", Health{
		State:               HealthOpen,
		ConsecutiveFailures: 5,
		OpenedAt:            now.Add(-time.Minute),
		ProbeAfter:          now.Add(-time.Second), // due
	})

	b := NewBreaker(health, breakerCfg(), clock, newLockedRand(7), discardLogger())

	// Twenty workers reach the due breaker at the same instant. Exactly one may
	// go through: that is the whole no-thundering-herd requirement.
	const workers = 20
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		allowed int
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := b.Allow(context.Background(), "ep_1")
			mu.Lock()
			defer mu.Unlock()
			if v.Allowed {
				allowed++
				if !v.Probe {
					t.Error("the admitted delivery must be marked as the probe")
				}
			} else if v.RetryAfter.Before(now) {
				t.Errorf("a refused delivery was told to retry in the past: %s", v.RetryAfter)
			}
		}()
	}
	wg.Wait()

	if allowed != 1 {
		t.Fatalf("%d of %d workers were admitted; exactly one probe may pass an open breaker", allowed, workers)
	}
}

func TestBreakerRefusesWhileTheCooldownRuns(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	health := newFakeHealth(func() time.Time { return now })
	health.set("ep_1", Health{State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(30 * time.Second)})

	b := NewBreaker(health, breakerCfg(), func() time.Time { return now }, newLockedRand(7), discardLogger())
	v := b.Allow(context.Background(), "ep_1")

	if v.Allowed {
		t.Fatal("an open breaker admitted a delivery before its probe was due")
	}
	if v.Reason != ReasonBreakerOpen {
		t.Fatalf("reason = %s, want %s", v.Reason, ReasonBreakerOpen)
	}
	if !v.RetryAfter.After(now.Add(30*time.Second - time.Second)) {
		t.Fatalf("retry_after = %s; a refused delivery must wait for at least the rest of the cooldown", v.RetryAfter)
	}
}

func TestBreakerAllowsHealthyAndDegraded(t *testing.T) {
	now := time.Now()
	health := newFakeHealth(func() time.Time { return now })
	b := NewBreaker(health, breakerCfg(), func() time.Time { return now }, newLockedRand(7), discardLogger())

	for _, state := range []HealthState{HealthHealthy, HealthDegraded} {
		health.set("ep_1", Health{State: state, ConsecutiveFailures: 4})
		if v := b.Allow(context.Background(), "ep_1"); !v.Allowed {
			t.Fatalf("state %s must not stop deliveries; degraded is a signal, not a valve", state)
		}
	}
	// An endpoint with no health row at all has never failed.
	if v := b.Allow(context.Background(), "ep_unknown"); !v.Allowed {
		t.Fatal("an endpoint with no health row was refused")
	}
}

// A breaker is a pressure-relief valve, not an authorisation check.
func TestBreakerFailsOpenWhenItsStoreIsBroken(t *testing.T) {
	now := time.Now()
	health := newFakeHealth(func() time.Time { return now })
	health.fail = errors.New("connection refused")

	b := NewBreaker(health, breakerCfg(), func() time.Time { return now }, newLockedRand(7), discardLogger())
	if v := b.Allow(context.Background(), "ep_1"); !v.Allowed {
		t.Fatal("a failed health read stopped a delivery; a database blip must not become a delivery outage")
	}
}

func TestBreakerRecordOutcomeAdvancesState(t *testing.T) {
	now := time.Now()
	health := newFakeHealth(func() time.Time { return now })
	b := NewBreaker(health, breakerCfg(), func() time.Time { return now }, newLockedRand(7), discardLogger())

	for i := 0; i < 5; i++ {
		if _, err := b.RecordOutcome(context.Background(), "ep_1", false); err != nil {
			t.Fatalf("record failure: %v", err)
		}
	}
	if got := health.get("ep_1").State; got != HealthOpen {
		t.Fatalf("state = %s after five failures, want open", got)
	}
	if _, err := b.RecordOutcome(context.Background(), "ep_1", true); err != nil {
		t.Fatalf("record success: %v", err)
	}
	if got := health.get("ep_1").State; got != HealthHealthy {
		t.Fatalf("state = %s after a success, want healthy", got)
	}
}
