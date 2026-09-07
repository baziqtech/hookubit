package worker

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestGateEnforcesEveryCeiling(t *testing.T) {
	g := NewGate(GateLimits{Global: 3, Org: 2, Project: 1, Endpoint: 1})

	r1, _, ok := g.AcquireTenant("org_a", "proj_a")
	if !ok {
		t.Fatal("first acquire refused")
	}
	if _, scope, ok := g.AcquireTenant("org_a", "proj_a"); ok {
		t.Fatal("the project ceiling of 1 admitted a second delivery")
	} else if scope != "project" {
		t.Fatalf("blocking scope = %q, want project; the reason has to name the ceiling that was hit", scope)
	}

	// A different project in the same org is still within the org ceiling.
	r2, _, ok := g.AcquireTenant("org_a", "proj_b")
	if !ok {
		t.Fatal("a second project in the same org was refused below the org ceiling")
	}
	if _, scope, ok := g.AcquireTenant("org_a", "proj_c"); ok {
		t.Fatal("the org ceiling of 2 admitted a third delivery")
	} else if scope != "organization" {
		t.Fatalf("blocking scope = %q, want organization", scope)
	}

	// A different org is unaffected - that is the entire point.
	r3, _, ok := g.AcquireTenant("org_b", "proj_z")
	if !ok {
		t.Fatal("one noisy org blocked another org entirely")
	}
	if _, scope, ok := g.AcquireTenant("org_c", "proj_y"); ok {
		t.Fatal("the global ceiling of 3 admitted a fourth delivery")
	} else if scope != "global" {
		t.Fatalf("blocking scope = %q, want global", scope)
	}

	r1()
	r2()
	r3()
	if g.InFlight() != 0 {
		t.Fatalf("in flight = %d after every release; a leaked slot permanently shrinks this process's capacity", g.InFlight())
	}
}

func TestGateReleaseIsIdempotent(t *testing.T) {
	g := NewGate(GateLimits{Global: 1, Org: 1, Project: 1, Endpoint: 1})
	release, _, ok := g.AcquireTenant("org", "proj")
	if !ok {
		t.Fatal("acquire refused")
	}
	release()
	release()
	release()
	if g.InFlight() != 0 {
		t.Fatalf("in flight = %d; a double release must not hand out phantom capacity", g.InFlight())
	}
	if _, _, ok := g.AcquireTenant("org", "proj"); !ok {
		t.Fatal("capacity was not returned")
	}
}

func TestEndpointCeilingTakesTheLowerOfConfigAndEndpoint(t *testing.T) {
	g := NewGate(GateLimits{Global: 10, Org: 10, Project: 10, Endpoint: 4})

	// The endpoint asks for 2, below the configured ceiling of 4.
	var releases []Release
	for i := 0; i < 2; i++ {
		r, ok := g.AcquireEndpoint("ep_1", 2, 4)
		if !ok {
			t.Fatalf("acquire %d refused below the endpoint's own limit", i)
		}
		releases = append(releases, r)
	}
	if _, ok := g.AcquireEndpoint("ep_1", 2, 4); ok {
		t.Fatal("the endpoint's own max_concurrency of 2 was exceeded")
	}
	for _, r := range releases {
		r()
	}

	// The endpoint asks for 100; the deployment's ceiling of 4 wins, so a
	// customer cannot raise their own limit past what the platform allows.
	releases = nil
	for i := 0; i < 4; i++ {
		r, ok := g.AcquireEndpoint("ep_2", 100, 4)
		if !ok {
			t.Fatalf("acquire %d refused below the configured ceiling", i)
		}
		releases = append(releases, r)
	}
	if _, ok := g.AcquireEndpoint("ep_2", 100, 4); ok {
		t.Fatal("an endpoint raised its own concurrency past the configured ceiling")
	}
	for _, r := range releases {
		r()
	}
}

func TestGateFreesEntriesSoTheMapIsBoundedByActiveTenants(t *testing.T) {
	g := NewGate(GateLimits{Global: 1000, Org: 4, Project: 4, Endpoint: 4})
	for i := 0; i < 500; i++ {
		key := string(rune('a'+i%26)) + string(rune('a'+i/26))
		r, _, ok := g.AcquireTenant(key, key)
		if !ok {
			t.Fatalf("acquire for %s refused", key)
		}
		r()
	}
	if n := g.org.keys(); n != 0 {
		t.Fatalf("%d organisation entries retained; the map must be bounded by CONCURRENT tenants, not by the customer list", n)
	}
	if n := g.project.keys(); n != 0 {
		t.Fatalf("%d project entries retained", n)
	}
}

func TestGateNeverAdmitsMoreThanTheGlobalLimitUnderLoad(t *testing.T) {
	const limit = 8
	g := NewGate(GateLimits{Global: limit, Org: limit, Project: limit, Endpoint: limit})

	var (
		mu      sync.Mutex
		current int
		peak    int
		wg      sync.WaitGroup
	)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, _, ok := g.AcquireTenant("org", "proj")
			if !ok {
				return
			}
			mu.Lock()
			current++
			if current > peak {
				peak = current
			}
			mu.Unlock()

			time.Sleep(time.Millisecond)

			mu.Lock()
			current--
			mu.Unlock()
			release()
		}()
	}
	wg.Wait()

	if peak > limit {
		t.Fatalf("peak concurrency %d exceeded the ceiling of %d", peak, limit)
	}
	if g.InFlight() != 0 {
		t.Fatalf("in flight = %d after all releases", g.InFlight())
	}
}

func TestTokenBucketRefills(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	tb := NewTokenBucket(clock)

	// Three per second: three go through, the fourth does not.
	for i := 0; i < 3; i++ {
		if ok, _ := tb.Allow(context.Background(), "ep_1", 3, time.Second); !ok {
			t.Fatalf("request %d refused inside the burst", i)
		}
	}
	ok, wait := tb.Allow(context.Background(), "ep_1", 3, time.Second)
	if ok {
		t.Fatal("the bucket admitted a fourth request in the same instant")
	}
	if wait <= 0 || wait > time.Second {
		t.Fatalf("retry-after = %s; it must say when a token is next available", wait)
	}

	// Another endpoint has its own bucket.
	if ok, _ := tb.Allow(context.Background(), "ep_2", 3, time.Second); !ok {
		t.Fatal("one endpoint's rate limit throttled another endpoint")
	}

	now = now.Add(time.Second)
	for i := 0; i < 3; i++ {
		if ok, _ := tb.Allow(context.Background(), "ep_1", 3, time.Second); !ok {
			t.Fatalf("request %d refused after a full window elapsed", i)
		}
	}
}

func TestTokenBucketTreatsZeroLimitAsUnlimited(t *testing.T) {
	tb := NewTokenBucket(time.Now)
	for i := 0; i < 100; i++ {
		if ok, _ := tb.Allow(context.Background(), "ep", 0, time.Second); !ok {
			t.Fatal("an endpoint with no configured rate limit was throttled")
		}
	}
}

func TestTokenBucketIsSafeUnderConcurrency(t *testing.T) {
	tb := NewTokenBucket(time.Now)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tb.Allow(context.Background(), "ep", 10, time.Second)
		}()
	}
	wg.Wait()
}
