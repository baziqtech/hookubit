package ratelimit

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"golang.org/x/sync/errgroup"
)

// countingSource records every call so the cache's effect on database load is
// measurable rather than asserted.
type countingSource struct {
	mu    sync.Mutex
	rows  []Row
	err   error
	calls int
	block chan struct{}
}

func (c *countingSource) Policies(context.Context, string, string) ([]Row, error) {
	c.mu.Lock()
	c.calls++
	block, rows, err := c.block, c.rows, c.err
	c.mu.Unlock()
	if block != nil {
		<-block
	}
	return rows, err
}

func (c *countingSource) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *countingSource) set(rows []Row) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rows = rows
}

// The cache exists so the limiter does not re-create the database pressure it
// was added to prevent: one query per accepted event, on the same pool.
func TestCacheServesRepeatedLookupsFromMemory(t *testing.T) {
	clk := newClock()
	inner := &countingSource{rows: []Row{{Scope: ScopeProject, Limit: 1, WindowSeconds: 1}}}
	c := NewCachingSource(inner, 30*time.Second, clk.now)

	for i := 0; i < 100; i++ {
		if _, err := c.Policies(context.Background(), orgID, projectID); err != nil {
			t.Fatal(err)
		}
	}
	if inner.count() != 1 {
		t.Fatalf("100 lookups made %d queries, want 1", inner.count())
	}
}

// An EMPTY result is cached too. Most projects have no policies at all, so a
// cache that only remembers hits does nothing for the common case - it would
// leave a query per event on the hot path for exactly the projects that have
// no limits configured.
func TestCacheRemembersAnEmptyResult(t *testing.T) {
	clk := newClock()
	inner := &countingSource{}
	c := NewCachingSource(inner, 30*time.Second, clk.now)

	for i := 0; i < 10; i++ {
		c.Policies(context.Background(), orgID, projectID)
	}
	if inner.count() != 1 {
		t.Fatalf("an empty policy set was re-queried %d times; negative results must be cached", inner.count())
	}
}

// The staleness contract: a policy change is picked up within the TTL, with no
// operator action and no push invalidation (ARCHITECTURE.md 55 - bounded,
// never indefinite).
func TestStalenessIsBoundedByTheTTL(t *testing.T) {
	clk := newClock()
	inner := &countingSource{rows: []Row{{Scope: ScopeProject, Limit: 10, WindowSeconds: 1}}}
	c := NewCachingSource(inner, 30*time.Second, clk.now)

	first, _ := c.Policies(context.Background(), orgID, projectID)
	if first[0].Limit != 10 {
		t.Fatal("wrong first read")
	}

	inner.set([]Row{{Scope: ScopeProject, Limit: 99, WindowSeconds: 1}})

	// Just inside the window: still the old value. This is the staleness an
	// operator is told to expect.
	clk.advance(29 * time.Second)
	stale, _ := c.Policies(context.Background(), orgID, projectID)
	if stale[0].Limit != 10 {
		t.Fatalf("limit = %d inside the TTL, want the cached 10", stale[0].Limit)
	}

	// Past it: the new value, without anything having invalidated anything.
	clk.advance(2 * time.Second)
	fresh, _ := c.Policies(context.Background(), orgID, projectID)
	if fresh[0].Limit != 99 {
		t.Fatalf("limit = %d past the TTL, want the updated 99: staleness must be time-bounded", fresh[0].Limit)
	}
}

func TestDifferentProjectsDoNotShareACacheEntry(t *testing.T) {
	clk := newClock()
	inner := &countingSource{}
	c := NewCachingSource(inner, time.Minute, clk.now)
	c.Policies(context.Background(), orgID, "prj_a")
	c.Policies(context.Background(), orgID, "prj_b")
	if inner.count() != 2 {
		t.Fatalf("two projects made %d queries, want 2; one project's policies were served for another", inner.count())
	}
}

// A stampede on expiry must not become a query per concurrent request, which
// is the failure the cache exists to prevent, arriving a TTL late.
func TestConcurrentMissesCollapseToOneQuery(t *testing.T) {
	clk := newClock()
	inner := &countingSource{block: make(chan struct{})}
	c := NewCachingSource(inner, time.Minute, clk.now)

	var g errgroup.Group
	for i := 0; i < 100; i++ {
		g.Go(func() error {
			_, err := c.Policies(context.Background(), orgID, projectID)
			return err
		})
	}
	// Let them all pile onto the in-flight lookup, then release it.
	time.Sleep(20 * time.Millisecond)
	close(inner.block)
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	if n := inner.count(); n > 2 {
		t.Fatalf("100 concurrent misses made %d queries; the stampede was not collapsed", n)
	}
}

// A database blip must not silently widen every customer's limit. Serving the
// last known policy set is strictly safer than falling back to the built-in
// default, which is looser than anything an operator configured.
func TestLookupErrorServesTheLastKnownPolicies(t *testing.T) {
	clk := newClock()
	inner := &countingSource{rows: []Row{{Scope: ScopeProject, Limit: 10, WindowSeconds: 1}}}
	c := NewCachingSource(inner, 5*time.Second, clk.now)
	c.Policies(context.Background(), orgID, projectID)

	inner.mu.Lock()
	inner.err = errors.New("connection reset")
	inner.mu.Unlock()

	clk.advance(time.Minute) // expire it
	rows, err := c.Policies(context.Background(), orgID, projectID)
	if err != nil {
		t.Fatalf("a failed refresh surfaced as an error instead of serving the stale set: %v", err)
	}
	if len(rows) != 1 || rows[0].Limit != 10 {
		t.Fatalf("stale set was not served: %+v", rows)
	}
}

// With nothing ever cached, an error is an error - the limiter turns it into a
// degradation, not the cache.
func TestFirstLookupErrorIsReported(t *testing.T) {
	c := NewCachingSource(&countingSource{err: errors.New("boom")}, time.Minute, newClock().now)
	if _, err := c.Policies(context.Background(), orgID, projectID); err == nil {
		t.Fatal("a cold-cache failure was swallowed")
	}
}
