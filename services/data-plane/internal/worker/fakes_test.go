package worker

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/queue"
	"github.com/shaq/hookubit/services/data-plane/internal/retry"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// --- store ----------------------------------------------------------------

type completion struct {
	Attempt *AttemptRecord
	Next    Transition
}

type fakeStore struct {
	mu sync.Mutex

	job *Job
	// jobs, when set, serves a different Job per delivery id - needed to prove
	// that one endpoint's saturation does not affect another's.
	jobs    map[string]*Job
	loadErr error

	// leaseLost makes Complete/Defer behave as the guarded UPDATE does when
	// another worker owns the row.
	leaseLost bool

	completions []completion
	defers      []Transition
	loads       int

	// budgetLoads counts LoadBudget calls, and budgetErr makes it fail. Both
	// exist for the tenant-gate budget path: the point of that path is that it
	// reads RARELY, so the number of reads is part of what is asserted.
	budgetLoads int
	budgetErr   error
}

func (f *fakeStore) Load(_ context.Context, deliveryID string) (*Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loads++
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	job := f.job
	if f.jobs != nil {
		found, ok := f.jobs[deliveryID]
		if !ok {
			return nil, ErrDeliveryGone
		}
		job = found
	}
	clone := *job
	return &clone, nil
}

// LoadBudget serves the budget from the same Job Load would return, and is
// counted separately so a test can prove the tenant gate did NOT read on every
// refusal.
func (f *fakeStore) LoadBudget(_ context.Context, deliveryID string) (Budget, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.budgetLoads++
	if f.budgetErr != nil {
		return Budget{}, f.budgetErr
	}
	job := f.job
	if f.jobs != nil {
		found, ok := f.jobs[deliveryID]
		if !ok {
			return Budget{}, ErrDeliveryGone
		}
		job = found
	}
	return Budget{Policy: job.Policy, FirstAttemptAt: job.FirstAttemptAt}, nil
}

func (f *fakeStore) budgetReads() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.budgetLoads
}

func (f *fakeStore) Complete(_ context.Context, _, _ string, a *AttemptRecord, next Transition) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.leaseLost {
		return ErrLeaseNotHeld
	}
	f.completions = append(f.completions, completion{Attempt: a, Next: next})
	return nil
}

func (f *fakeStore) Defer(_ context.Context, _, _ string, next Transition) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.leaseLost {
		return ErrLeaseNotHeld
	}
	f.defers = append(f.defers, next)
	return nil
}

func (f *fakeStore) lastCompletion(t *testing.T) completion {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.completions) == 0 {
		t.Fatal("expected the delivery to be completed, but nothing was recorded")
	}
	return f.completions[len(f.completions)-1]
}

func (f *fakeStore) lastDefer(t *testing.T) Transition {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.defers) == 0 {
		t.Fatal("expected the delivery to be deferred, but nothing was recorded")
	}
	return f.defers[len(f.defers)-1]
}

// loadCount reports full Load calls, as opposed to the cheap budget-only read.
func (f *fakeStore) loadCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loads
}

func (f *fakeStore) counts() (completions, defers int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.completions), len(f.defers)
}

// --- health ---------------------------------------------------------------

// fakeHealth implements the breaker's store against NextHealth, which is the
// same rule set the production SQL implements. That is deliberate: the pure
// function is the specification and both implementations are measured against
// it (the SQL by the DATABASE_URL-gated test).
type fakeHealth struct {
	mu    sync.Mutex
	rows  map[string]Health
	now   func() time.Time
	fail  error
	calls int
}

func newFakeHealth(now func() time.Time) *fakeHealth {
	return &fakeHealth{rows: map[string]Health{}, now: now}
}

func (f *fakeHealth) Health(_ context.Context, id string) (Health, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return Health{}, f.fail
	}
	h, ok := f.rows[id]
	if !ok {
		return Health{State: HealthHealthy}, nil
	}
	return h, nil
}

func (f *fakeHealth) ClaimProbe(_ context.Context, id string, ttl time.Duration) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	h, ok := f.rows[id]
	if !ok {
		return false, nil
	}
	now := f.now()
	if h.State != HealthOpen && h.State != HealthHalfOpen {
		return false, nil
	}
	if h.ProbeAfter.IsZero() || h.ProbeAfter.After(now) {
		return false, nil
	}
	h.State = HealthHalfOpen
	h.ConsecutiveSuccesses = 0
	h.ProbeAfter = now.Add(ttl)
	f.rows[id] = h
	return true, nil
}

func (f *fakeHealth) RecordOutcome(
	_ context.Context, id string, success bool, cfg BreakerConfig, jitter float64,
) (Health, Health, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	prev := f.rows[id]
	if prev.State == "" {
		prev.State = HealthHealthy
	}
	next := NextHealth(prev, success, cfg, f.now(), jitter)
	f.rows[id] = next
	return prev, next, nil
}

// probeClaims reports how many times a probe slot was CLAIMED - the conditional
// UPDATE that admits exactly one delivery to a recovering endpoint. It is the
// only way to prove a probe was not spent by a delivery that never reached the
// network.
func (f *fakeHealth) probeClaims() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeHealth) set(id string, h Health) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows[id] = h
}

func (f *fakeHealth) get(id string) Health {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rows[id]
}

// --- queue ----------------------------------------------------------------

type fakeQueue struct {
	mu       sync.Mutex
	pending  []queue.Lease
	claimed  int
	released []string
	lost     map[string]bool
	claimErr error
}

func newFakeQueue(leases ...queue.Lease) *fakeQueue {
	return &fakeQueue{pending: leases, lost: map[string]bool{}}
}

func (f *fakeQueue) Claim(_ context.Context, workerID string, limit int, _ time.Duration) ([]queue.Lease, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if len(f.pending) == 0 {
		return nil, nil
	}
	if limit > len(f.pending) {
		limit = len(f.pending)
	}
	out := make([]queue.Lease, limit)
	copy(out, f.pending[:limit])
	f.pending = f.pending[limit:]
	for i := range out {
		out[i].WorkerID = workerID
	}
	f.claimed += limit
	return out, nil
}

func (f *fakeQueue) Renew(_ context.Context, _ string, ids []string, _ time.Duration) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var lost []string
	for _, id := range ids {
		if f.lost[id] {
			lost = append(lost, id)
		}
	}
	return lost, nil
}

func (f *fakeQueue) Release(_ context.Context, _ string, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = append(f.released, id)
	return nil
}

func (f *fakeQueue) claimedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claimed
}

// --- job fixture ----------------------------------------------------------

// testJob builds a Job whose signing secret is the REAL envelope produced by
// the TypeScript control plane, so the delivery-path tests exercise the same
// decrypt the production path does.
func testJob(t *testing.T, url string) (*Job, *Keyring, string) {
	return testJobVector(t, url, 0)
}

// testJobVector picks one of the TypeScript-generated vectors, so a test that
// needs two endpoints gets two secrets that are each correctly bound to their
// own endpoint id.
func testJobVector(t *testing.T, url string, vector int) (*Job, *Keyring, string) {
	t.Helper()
	fx := loadInteropFixture(t)
	ring := interopKeyring(t, fx)
	v := fx.Vectors[vector]

	job := &Job{
		DeliveryID:     "del_01TEST",
		EventID:        "evt_01TEST",
		OrganizationID: "org_01TEST",
		ProjectID:      "proj_01TEST",
		EventType:      "order.created",
		AttemptNumber:  1,
		Payload:        []byte(`{"b":1,"a":2}`),
		EventCreatedAt: time.Now().Add(-time.Second),
		FirstAttemptAt: time.Now().Add(-time.Second),
		Endpoint: Endpoint{
			ID:              v.Context.Owner,
			URL:             url,
			Status:          "active",
			Enabled:         true,
			Timeout:         5 * time.Second,
			MaxConcurrency:  4,
			RateLimitWindow: time.Second,
		},
		Policy:  retry.DefaultPolicy(),
		Secrets: []EncryptedSecret{{ID: v.Context.ID, Version: 1, Envelope: v.Envelope}},
	}
	return job, ring, v.Plaintext
}
