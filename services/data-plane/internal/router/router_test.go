package router

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/retry"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// fakeStore records what the Router asked it to do. It is deliberately not a
// database: everything it verifies is a decision the Router makes on its own.
type fakeStore struct {
	mu sync.Mutex

	claim    []OutboxRow
	claimErr error

	routeFn func(RouteRequest) (RouteResult, error)

	parked   []parkCall
	released []releaseCall
	routed   []string

	lagErr error
	lag    float64
}

type parkCall struct{ outboxID, eventID, reason string }
type releaseCall struct {
	outboxID string
	reason   string
	after    time.Duration
}

func (f *fakeStore) ClaimOutbox(context.Context, string, int, time.Duration) ([]OutboxRow, error) {
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	rows := f.claim
	f.claim = nil
	return rows, nil
}

func (f *fakeStore) Route(_ context.Context, req RouteRequest) (RouteResult, error) {
	f.mu.Lock()
	f.routed = append(f.routed, req.Row.ID)
	f.mu.Unlock()
	if f.routeFn != nil {
		return f.routeFn(req)
	}
	return RouteResult{Outcome: OutcomeRouted, Created: 1}, nil
}

func (f *fakeStore) ParkOutbox(_ context.Context, _, outboxID, eventID, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parked = append(f.parked, parkCall{outboxID: outboxID, eventID: eventID, reason: reason})
	return nil
}

func (f *fakeStore) ReleaseOutbox(_ context.Context, _, outboxID, reason string, after time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = append(f.released, releaseCall{outboxID: outboxID, reason: reason, after: after})
	return nil
}

func (f *fakeStore) OutboxLagSeconds(context.Context) (float64, error) { return f.lag, f.lagErr }

func newTestRouter(t *testing.T, store Store, tweak func(*Options)) *Router {
	t.Helper()
	opts := Options{
		Store:                    store,
		RouterID:                 "rtr_test",
		Logger:                   quietLogger(),
		BatchSize:                10,
		Concurrency:              2,
		MaxOutboxAttempts:        3,
		MaxSubscriptionsPerEvent: 100,
	}
	if tweak != nil {
		tweak(&opts)
	}
	r, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

func TestNewRequiresStoreAndRouterID(t *testing.T) {
	if _, err := New(Options{RouterID: "rtr"}); err == nil {
		t.Fatal("expected an error without a Store")
	}
	if _, err := New(Options{Store: &fakeStore{}}); err == nil {
		t.Fatal("expected an error without a RouterID; it is the lease owner")
	}
}

func TestNewFillsBounds(t *testing.T) {
	r, err := New(Options{Store: &fakeStore{}, RouterID: "rtr"})
	if err != nil {
		t.Fatal(err)
	}
	if r.opts.BatchSize <= 0 || r.opts.Concurrency <= 0 || r.opts.Lease <= 0 ||
		r.opts.MaxSubscriptionsPerEvent <= 0 || r.opts.MaxOutboxAttempts <= 0 ||
		r.opts.MaxOutboxRetryDuration <= 0 {
		t.Fatalf("a bound was left unset: %+v", r.opts)
	}
	if r.opts.RetryBackoff.InitialDelay <= 0 {
		t.Fatal("retry backoff was left at the zero policy; a released row would return instantly and spin")
	}
}

// The dead-default bug: cmd/webhookd/roles.go passes retry.DefaultPolicy(), the
// DELIVERY policy, whose MaxDelay is an hour - so DefaultOutboxBackoff never
// applied in production and a released outbox row could wait an hour to be
// retried, against a one-hour MaxOutboxRetryDuration that would then park it.
// The outbox retries database-side failures, which resolve in seconds.
func TestNewClampsADeliveryScaleBackoffToTheOutboxCeiling(t *testing.T) {
	r, err := New(Options{
		Store:        &fakeStore{},
		RouterID:     "rtr",
		Logger:       quietLogger(),
		RetryBackoff: retry.DefaultPolicy(), // MaxDelay: 1 hour
	})
	if err != nil {
		t.Fatal(err)
	}
	ceiling := DefaultOutboxBackoff().MaxDelay
	if r.opts.RetryBackoff.MaxDelay != ceiling {
		t.Fatalf("RetryBackoff.MaxDelay = %s, want it clamped to the outbox ceiling %s",
			r.opts.RetryBackoff.MaxDelay, ceiling)
	}
	// A policy already inside the ceiling is honoured untouched.
	tight := DefaultOutboxBackoff()
	tight.MaxDelay = 5 * time.Second
	r2, err := New(Options{Store: &fakeStore{}, RouterID: "rtr", Logger: quietLogger(), RetryBackoff: tight})
	if err != nil {
		t.Fatal(err)
	}
	if r2.opts.RetryBackoff.MaxDelay != 5*time.Second {
		t.Fatalf("MaxDelay = %s, want the caller's 5s left alone", r2.opts.RetryBackoff.MaxDelay)
	}
}

// The poison bound is UNACCOUNTED claims - claims that ended with the router
// writing nothing at all, which is what a row that kills the process looks like.
// That protection is unchanged; what changed is the counter it reads.
func TestRunOnceParksAPoisonedRow(t *testing.T) {
	store := &fakeStore{claim: []OutboxRow{
		{ID: "obx_ok", EventID: "evt_ok", Type: OutboxTypeEventCreated, Attempts: 3, UnaccountedAttempts: 3},
		{ID: "obx_poison", EventID: "evt_poison", Type: OutboxTypeEventCreated, Attempts: 4, UnaccountedAttempts: 4},
	}}
	r := newTestRouter(t, store, nil) // MaxOutboxAttempts = 3

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if len(store.routed) != 1 || store.routed[0] != "obx_ok" {
		t.Fatalf("routed = %v; the poisoned row must not be routed again", store.routed)
	}
	if len(store.parked) != 1 || store.parked[0].outboxID != "obx_poison" {
		t.Fatalf("parked = %+v, want the poisoned row", store.parked)
	}
	if store.parked[0].eventID != "evt_poison" {
		t.Fatalf("park did not carry the event id: %+v", store.parked[0])
	}
	if store.parked[0].reason == "" {
		t.Fatal("a parked row must record why; an unexplained park is unactionable at 2am")
	}
}

// The FALSE-PARKING regression, stated directly.
//
// A degraded-Postgres window claims a row, fails before routing is attempted,
// records the failure and releases - over and over. Every one of those claims
// increments `attempts`, so under the old single-counter bound the row parked
// and its event was marked `failed`, having already been answered 202 Accepted.
// The claims were accounted for, so the poison budget is untouched and the row
// stays in the queue to be retried when the database comes back.
func TestRunOnceDoesNotParkARowWhoseFailuresWereAllRecorded(t *testing.T) {
	store := &fakeStore{claim: []OutboxRow{{
		ID: "obx_brownout", EventID: "evt_brownout", Type: OutboxTypeEventCreated,
		// Claimed far past the bound, but every one of those claims released
		// with a recorded reason and handed its increment back.
		Attempts:            40,
		UnaccountedAttempts: 0,
	}}}
	r := newTestRouter(t, store, nil) // MaxOutboxAttempts = 3

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.parked) != 0 {
		t.Fatalf("parked = %+v; a row whose every failure was observed and recorded is a "+
			"database problem, not a poisoned row, and parking it strands an accepted event",
			store.parked)
	}
	if len(store.routed) != 1 || store.routed[0] != "obx_brownout" {
		t.Fatalf("routed = %v, want the row to be tried again", store.routed)
	}
}

// Recorded failure is bounded by TIME, not by count: a row that has genuinely
// been failing for longer than the retry duration is parked, so a broken row
// still cannot cycle forever.
func TestRunOnceParksARowThatHasBeenFailingTooLong(t *testing.T) {
	stale := time.Now().Add(-2 * time.Hour)
	fresh := time.Now().Add(-time.Minute)
	store := &fakeStore{claim: []OutboxRow{
		{ID: "obx_fresh", EventID: "evt_fresh", Type: OutboxTypeEventCreated, Attempts: 9, FailingSince: &fresh},
		{ID: "obx_stale", EventID: "evt_stale", Type: OutboxTypeEventCreated, Attempts: 9, FailingSince: &stale},
	}}
	r := newTestRouter(t, store, func(o *Options) { o.MaxOutboxRetryDuration = time.Hour })

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.parked) != 1 || store.parked[0].outboxID != "obx_stale" {
		t.Fatalf("parked = %+v, want only the row that has been failing for two hours", store.parked)
	}
	if len(store.routed) != 1 || store.routed[0] != "obx_fresh" {
		t.Fatalf("routed = %v; a row a minute into an incident must still be retried", store.routed)
	}
	if !strings.Contains(store.parked[0].reason, "failing since") {
		t.Fatalf("park reason = %q; it must say what the operator is looking at", store.parked[0].reason)
	}
}

func TestRunOnceParksAnUnknownOutboxType(t *testing.T) {
	store := &fakeStore{claim: []OutboxRow{
		{ID: "obx_1", EventID: "evt_1", Type: "endpoint.created", Attempts: 1},
	}}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.routed) != 0 {
		t.Fatalf("routed = %v, want none", store.routed)
	}
	if len(store.parked) != 1 {
		t.Fatalf("parked = %+v, want the unknown-type row parked rather than re-claimed forever", store.parked)
	}
}

func TestRunOnceReleasesWithBackoffOnTransientFailure(t *testing.T) {
	boom := errors.New("connection reset by peer")
	store := &fakeStore{
		claim: []OutboxRow{{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1}},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{}, boom
		},
	}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.parked) != 0 {
		t.Fatalf("a transient failure must not park the row: %+v", store.parked)
	}
	if len(store.released) != 1 {
		t.Fatalf("released = %+v, want one", store.released)
	}
	if store.released[0].after <= 0 {
		t.Fatal("released with a zero backoff; the row would be re-claimed immediately and spin")
	}
	if store.released[0].reason == "" {
		t.Fatal("release must record the failure reason")
	}
}

func TestBackoffGrowsWithAttempts(t *testing.T) {
	r := newTestRouter(t, &fakeStore{}, func(o *Options) {
		o.RetryBackoff = DefaultOutboxBackoff()
		o.RetryBackoff.JitterRatio = 0 // deterministic
	})
	first := r.backoff(1)
	second := r.backoff(2)
	if first <= 0 {
		t.Fatalf("backoff(1) = %s, want a positive delay", first)
	}
	if second <= first {
		t.Fatalf("backoff did not grow: %s then %s", first, second)
	}
	if capped := r.backoff(30); capped > r.opts.RetryBackoff.MaxDelay {
		t.Fatalf("backoff(30) = %s, exceeds MaxDelay %s", capped, r.opts.RetryBackoff.MaxDelay)
	}
}

func TestRunOnceLeaseLostIsNotParkedOrReleased(t *testing.T) {
	store := &fakeStore{
		claim: []OutboxRow{{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1}},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{Outcome: OutcomeLeaseLost}, nil
		},
	}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	// The row belongs to another router now. Touching it would stomp on its
	// bookkeeping, which is the whole reason the locked_by guard exists.
	if len(store.parked) != 0 || len(store.released) != 0 {
		t.Fatalf("lost lease was written to: parked=%+v released=%+v", store.parked, store.released)
	}
}

func TestRunOnceParksAnOutboxRowWhoseEventIsGone(t *testing.T) {
	store := &fakeStore{
		claim: []OutboxRow{{ID: "obx_1", EventID: "evt_gone", Type: OutboxTypeEventCreated, Attempts: 1}},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{Outcome: OutcomeEventMissing}, nil
		},
	}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.parked) != 1 || store.parked[0].reason == "" {
		t.Fatalf("parked = %+v, want the orphaned row parked with a reason", store.parked)
	}
	if len(store.released) != 0 {
		t.Fatal("an orphaned row must not be released; it would be re-claimed forever")
	}
}

func TestRunOnceZeroSubscriptionsIsANormalOutcome(t *testing.T) {
	store := &fakeStore{
		claim: []OutboxRow{{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1}},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{Outcome: OutcomeNoSubscriptions, Plan: Plan{Skipped: map[string]int{}}}, nil
		},
	}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.parked) != 0 || len(store.released) != 0 {
		t.Fatalf("an unmatched event must leave the queue cleanly: parked=%+v released=%+v",
			store.parked, store.released)
	}
}

func TestRunOnceSurfacesClaimErrors(t *testing.T) {
	store := &fakeStore{claimErr: errors.New("pool exhausted")}
	r := newTestRouter(t, store, nil)

	if _, err := r.RunOnce(context.Background()); err == nil {
		t.Fatal("expected the claim error to surface; a swallowed one hides a stalled router")
	}
}

func TestRunOnceBoundsConcurrency(t *testing.T) {
	const concurrency = 3
	var (
		mu             sync.Mutex
		inFlight, peak int
	)
	rows := make([]OutboxRow, 0, 20)
	for i := 0; i < 20; i++ {
		rows = append(rows, OutboxRow{
			ID: "obx_" + string(rune('a'+i)), EventID: "evt", Type: OutboxTypeEventCreated, Attempts: 1,
		})
	}
	store := &fakeStore{
		claim: rows,
		routeFn: func(RouteRequest) (RouteResult, error) {
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			mu.Unlock()
			time.Sleep(time.Millisecond)
			mu.Lock()
			inFlight--
			mu.Unlock()
			return RouteResult{Outcome: OutcomeRouted, Created: 1}, nil
		},
	}
	r := newTestRouter(t, store, func(o *Options) { o.Concurrency = concurrency })

	n, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != len(rows) {
		t.Fatalf("processed %d rows, want %d", n, len(rows))
	}
	mu.Lock()
	defer mu.Unlock()
	if peak > concurrency {
		t.Fatalf("peak concurrency = %d, want at most %d", peak, concurrency)
	}
	if peak < 2 {
		t.Fatalf("peak concurrency = %d; the batch was processed serially", peak)
	}
}

func TestRunOnceStopsClaimingWorkOnceCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	rows := make([]OutboxRow, 0, 10)
	for i := 0; i < 10; i++ {
		rows = append(rows, OutboxRow{
			ID: "obx_" + string(rune('a'+i)), EventID: "evt", Type: OutboxTypeEventCreated, Attempts: 1,
		})
	}
	store := &fakeStore{
		claim: rows,
		routeFn: func(RouteRequest) (RouteResult, error) {
			cancel()
			return RouteResult{Outcome: OutcomeRouted, Created: 1}, nil
		},
	}
	r := newTestRouter(t, store, func(o *Options) { o.Concurrency = 1 })

	if _, err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.routed) == len(rows) {
		t.Fatal("the whole batch was routed after cancellation; shutdown must stop taking new work")
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := newTestRouter(t, &fakeStore{}, nil)

	done := make(chan error, 1)
	go func() { done <- r.Run(ctx, time.Millisecond) }()
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on cancellation")
	}
}

func TestObserveLagIsThrottled(t *testing.T) {
	calls := 0
	store := &countingLagStore{onLag: func() { calls++ }}
	r := newTestRouter(t, store, func(o *Options) { o.LagInterval = time.Hour })

	for i := 0; i < 5; i++ {
		if _, err := r.RunOnce(context.Background()); err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
	}
	if calls != 1 {
		t.Fatalf("lag measured %d times across 5 polls; the aggregate must be throttled", calls)
	}
}

type countingLagStore struct {
	fakeStore
	onLag func()
}

func (c *countingLagStore) OutboxLagSeconds(context.Context) (float64, error) {
	c.onLag()
	return 0, nil
}
