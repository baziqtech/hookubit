package ratelimit

import (
	"sync"
	"testing"
	"time"

	"golang.org/x/sync/errgroup"
)

// clock is a manually advanced clock. Time in a rate limiter is an input, and
// a test that sleeps is measuring the scheduler rather than the limiter.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock { return &clock{t: time.Unix(1_700_000_000, 0)} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// TestBurstIsAllowedThenRefused: a full bucket spends its capacity, then says
// no - and says how long to wait when it does.
func TestBurstIsAllowedThenRefused(t *testing.T) {
	clk := newClock()
	l := NewLocal(clk.now, 0)

	// 10 tokens per second, capacity 10.
	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("k", 10, 10, 1); !ok {
			t.Fatalf("request %d of the burst was refused; the whole burst must be allowed", i+1)
		}
	}
	ok, wait := l.Allow("k", 10, 10, 1)
	if ok {
		t.Fatal("the 11th request was allowed; the burst is the capacity, not a suggestion")
	}
	if wait <= 0 {
		t.Fatal("a refusal advertised no wait; a Retry-After of zero invites an immediate retry")
	}
	if wait > 200*time.Millisecond {
		t.Fatalf("wait = %s, want ~100ms (one token at 10/s)", wait)
	}
}

// TestWindowRefills: the bucket earns tokens back at limit/window, and never
// more than capacity however long it idles.
func TestWindowRefills(t *testing.T) {
	clk := newClock()
	l := NewLocal(clk.now, 0)

	for i := 0; i < 5; i++ {
		l.Allow("k", 5, 5, 1) // 5 per second, capacity 5: drain it
	}
	if ok, _ := l.Allow("k", 5, 5, 1); ok {
		t.Fatal("bucket was not drained")
	}

	// Half a window buys back half the tokens, not all of them.
	clk.advance(400 * time.Millisecond)
	allowed := 0
	for i := 0; i < 5; i++ {
		if ok, _ := l.Allow("k", 5, 5, 1); ok {
			allowed++
		}
	}
	if allowed != 2 {
		t.Fatalf("400ms at 5/s refilled %d tokens, want 2", allowed)
	}

	// An hour idle does not accrue an hour of tokens: capacity is the ceiling.
	clk.advance(time.Hour)
	allowed = 0
	for i := 0; i < 50; i++ {
		if ok, _ := l.Allow("k", 5, 5, 1); ok {
			allowed++
		}
	}
	if allowed != 5 {
		t.Fatalf("after idling an hour the bucket allowed %d, want the capacity (5)", allowed)
	}
}

// A refusal must not charge the bucket. If it did, a client politely retrying
// at the advertised interval would push its own bucket further into debt and
// never be served.
func TestRefusalDoesNotChargeTheBucket(t *testing.T) {
	clk := newClock()
	l := NewLocal(clk.now, 0)

	l.Allow("k", 1, 1, 1) // spend the single token
	for i := 0; i < 100; i++ {
		l.Allow("k", 1, 1, 1) // hammer it while empty
	}
	clk.advance(time.Second) // exactly one token's worth of refill
	if ok, _ := l.Allow("k", 1, 1, 1); !ok {
		t.Fatal("100 refused requests left the bucket in debt; a refusal must cost nothing")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	l := NewLocal(newClock().now, 0)
	l.Allow("a", 1, 1, 1)
	if ok, _ := l.Allow("b", 1, 1, 1); !ok {
		t.Fatal("draining one key drained another")
	}
}

// A degenerate bucket (no capacity, no refill) must not refuse everything
// forever. The control plane's CHECK constraints make it unreachable from the
// API; a hand-written row must still not be an outage.
func TestDegenerateBucketFailsOpen(t *testing.T) {
	l := NewLocal(newClock().now, 0)
	for _, c := range []struct{ cap, rate float64 }{{0, 10}, {10, 0}, {-1, -1}} {
		if ok, _ := l.Allow("k", c.cap, c.rate, 1); !ok {
			t.Fatalf("capacity=%v rate=%v refused; a nonsensical policy must fail open", c.cap, c.rate)
		}
	}
}

// TestConcurrentCallersCannotExceedTheLimit asserts the PROPERTY, not the
// mechanism: however the goroutines interleave, the number of requests the
// limiter admits is exactly the bucket's capacity - never capacity+1 because
// two callers read the same token count and both spent it.
//
// Run with -race, which the package's verify command already does.
func TestConcurrentCallersCannotExceedTheLimit(t *testing.T) {
	const capacity = 50
	const callers = 500

	// A frozen clock is deliberate: with real time the bucket would refill
	// mid-run and the assertion would become "roughly capacity", which cannot
	// distinguish a lost update from a refill.
	clk := newClock()
	l := NewLocal(clk.now, 0)

	var mu sync.Mutex
	var admitted int

	var g errgroup.Group
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		g.Go(func() error {
			<-start // maximise the overlap
			if ok, _ := l.Allow("shared", capacity, capacity, 1); ok {
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
		t.Fatalf("%d of %d concurrent callers were admitted, want exactly the capacity (%d)",
			admitted, callers, capacity)
	}
}

// The map must not grow without bound: an attacker cycling source addresses
// would otherwise turn the limiter into an allocation.
func TestLocalIsBounded(t *testing.T) {
	clk := newClock()
	l := NewLocal(clk.now, 64)
	for i := 0; i < 5_000; i++ {
		l.Allow(string(rune(i%1114111))+"-"+time.Duration(i).String(), 10, 10, 1)
	}
	if n := l.Len(); n > 64 {
		t.Fatalf("tracked %d buckets, want at most the configured maximum (64)", n)
	}
}
