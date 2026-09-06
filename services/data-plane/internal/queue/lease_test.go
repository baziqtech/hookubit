package queue

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeQueue lets the keeper's behaviour be tested without a database.
type fakeQueue struct {
	mu       sync.Mutex
	lost     map[string]bool
	err      error
	renewals [][]string
}

func newFakeQueue() *fakeQueue { return &fakeQueue{lost: map[string]bool{}} }

func (f *fakeQueue) Claim(context.Context, string, int, time.Duration) ([]Lease, error) {
	return nil, nil
}

func (f *fakeQueue) Renew(_ context.Context, _ string, ids []string, _ time.Duration) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewals = append(f.renewals, append([]string(nil), ids...))
	if f.err != nil {
		return nil, f.err
	}
	var lost []string
	for _, id := range ids {
		if f.lost[id] {
			lost = append(lost, id)
		}
	}
	return lost, nil
}

func (f *fakeQueue) Release(context.Context, string, string) error { return nil }

func (f *fakeQueue) steal(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lost[id] = true
}

func (f *fakeQueue) failWith(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeQueue) rounds() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.renewals)
}

var _ Queue = (*fakeQueue)(nil)

// The double-delivery scenario, end to end. Worker A holds a lease, a failover
// eats a renewal, the row is reclaimed and delivered by worker B. A must learn
// its lease is gone and abandon the attempt rather than write a second
// delivery_attempts row and race B over the terminal status.
func TestStolenLeaseCancelsTheInFlightAttempt(t *testing.T) {
	q := newFakeQueue()
	k := NewLeaseKeeper(q, "wrk_a", 30*time.Second, discardLogger())

	mine, doneMine := k.Track(context.Background(), "del_mine")
	defer doneMine()
	stolen, doneStolen := k.Track(context.Background(), "del_stolen")
	defer doneStolen()

	q.steal("del_stolen")
	k.RenewOnce(context.Background())

	select {
	case <-stolen.Done():
	case <-time.After(time.Second):
		t.Fatal("the attempt whose lease was stolen was not cancelled; it would deliver twice")
	}
	if cause := context.Cause(stolen); !errors.Is(cause, ErrLeaseLost) {
		t.Fatalf("cancellation cause = %v, want ErrLeaseLost so the caller can tell this from a timeout", cause)
	}

	select {
	case <-mine.Done():
		t.Fatal("an attempt whose lease is still held was cancelled")
	default:
	}
	if k.Tracked() != 1 {
		t.Fatalf("tracked = %d after one lease was lost, want 1", k.Tracked())
	}
}

// A renewal that fails to reach the database is not evidence the lease is gone.
// Cancelling on a transport error would abort healthy deliveries every time
// PostgreSQL hiccups.
func TestRenewErrorDoesNotAbandonAttempts(t *testing.T) {
	q := newFakeQueue()
	q.failWith(errors.New("connection refused"))
	k := NewLeaseKeeper(q, "wrk_a", 30*time.Second, discardLogger())

	ctx, done := k.Track(context.Background(), "del_1")
	defer done()

	k.RenewOnce(context.Background())

	select {
	case <-ctx.Done():
		t.Fatal("a failed renewal round cancelled an attempt whose lease may well still be held")
	default:
	}
	if k.Tracked() != 1 {
		t.Fatalf("tracked = %d, want the attempt still held", k.Tracked())
	}
}

func TestFinishedAttemptsAreNotRenewed(t *testing.T) {
	q := newFakeQueue()
	k := NewLeaseKeeper(q, "wrk_a", 30*time.Second, discardLogger())

	_, done := k.Track(context.Background(), "del_1")
	done()
	done() // idempotent

	if k.Tracked() != 0 {
		t.Fatalf("tracked = %d after the attempt finished, want 0", k.Tracked())
	}
	k.RenewOnce(context.Background())
	if q.rounds() != 0 {
		t.Fatalf("renewed %d times with nothing in flight; a worker at rest must not touch the database", q.rounds())
	}
}

// Shutdown must not leave a goroutine believing it holds a lease nobody renews.
func TestRunCancelsEverythingOnShutdown(t *testing.T) {
	q := newFakeQueue()
	k := NewLeaseKeeper(q, "wrk_a", 30*time.Millisecond, discardLogger())

	attempt, done := k.Track(context.Background(), "del_1")
	defer done()

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- k.Run(ctx) }()

	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	select {
	case <-attempt.Done():
	case <-time.After(time.Second):
		t.Fatal("shutdown left an attempt running with nobody renewing its lease")
	}
	if k.Tracked() != 0 {
		t.Fatalf("tracked = %d after shutdown, want 0", k.Tracked())
	}
}

// The keeper is shared by every in-flight attempt in the process, so it must be
// safe under -race with tracks, renewals and completions overlapping.
func TestLeaseKeeperIsConcurrencySafe(t *testing.T) {
	q := newFakeQueue()
	k := NewLeaseKeeper(q, "wrk_a", time.Second, discardLogger())

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := "del_" + string(rune('a'+i%26))
			_, done := k.Track(context.Background(), id)
			if i%3 == 0 {
				q.steal(id)
			}
			k.RenewOnce(context.Background())
			done()
		}(i)
	}
	wg.Wait()
	if k.Tracked() != 0 {
		t.Fatalf("tracked = %d after every attempt finished", k.Tracked())
	}
}
