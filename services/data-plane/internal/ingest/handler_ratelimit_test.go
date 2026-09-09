package ingest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sync/errgroup"
)

// countingStore wraps the fake store to prove a NEGATIVE: that the pre-auth
// limit refuses before any database call happens.
//
// This is the whole point of the ceiling. FindAPIKey takes one of
// DATABASE_MAX_CONNECTIONS and holds it for up to DBTimeout, so a limiter that
// runs after it has not prevented the attack, it has only counted it.
type countingStore struct {
	*fakeStore
	mu     sync.Mutex
	lookup int
}

func (c *countingStore) FindAPIKey(ctx context.Context, keyHash string) (*APIKeyRecord, error) {
	c.mu.Lock()
	c.lookup++
	c.mu.Unlock()
	return c.fakeStore.FindAPIKey(ctx, keyHash)
}

func (c *countingStore) lookups() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lookup
}

func TestPreAuthLimitRefusesBeforeAnyDatabaseCall(t *testing.T) {
	f := newFixture(t)
	counting := &countingStore{fakeStore: f.store}
	f.handler.store = counting
	// Two requests' worth of budget, then nothing.
	f.handler.source = NewSourceLimiter(SourceLimits{Limit: 2, Window: time.Second, Burst: 2}, nil)

	for i := 0; i < 2; i++ {
		if rec := f.post(t, goodBody, nil); rec.Code != http.StatusAccepted {
			t.Fatalf("request %d: status %d, want 202", i+1, rec.Code)
		}
	}
	before := counting.lookups()
	if before != 2 {
		t.Fatalf("%d key lookups for 2 accepted requests", before)
	}

	// Everything past the burst must be refused WITHOUT touching the store.
	for i := 0; i < 20; i++ {
		rec := f.post(t, goodBody, nil)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("flooding request %d: status %d, want 429", i+1, rec.Code)
		}
	}
	if after := counting.lookups(); after != before {
		t.Fatalf("%d database key lookups happened while rate limited; the ceiling must hold BEFORE the pool is touched", after-before)
	}
	if f.store.eventCount() != 2 {
		t.Fatalf("%d events created, want 2", f.store.eventCount())
	}
}

// The attack in the finding needs no valid credential at all. Garbage bearer
// tokens of valid shape must be bounded too - and faster, because of the
// auth-failure penalty.
func TestUnauthenticatedFloodIsBoundedBeforeTheDatabase(t *testing.T) {
	f := newFixture(t)
	counting := &countingStore{fakeStore: f.store}
	f.handler.store = counting
	f.handler.source = NewSourceLimiter(
		SourceLimits{Limit: 50, Window: time.Second, Burst: 50, Penalty: 9}, nil)

	garbage := "wk_live_" + strings.Repeat("z", 32)
	for i := 0; i < 200; i++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+f.projectID+"/events", strings.NewReader(goodBody))
		req.Header.Set("Authorization", "Bearer "+garbage)
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "203.0.113.66:44444"
		f.handler.ServeHTTP(httptest.NewRecorder(), req)
	}

	// 50 tokens, 10 per failed attempt: about five lookups reach the pool,
	// not two hundred.
	if n := counting.lookups(); n > 10 {
		t.Fatalf("%d unauthenticated key lookups reached the database out of 200 requests; the pool is still exposed", n)
	}
	if n := counting.lookups(); n == 0 {
		t.Fatal("no lookups at all: the test is not exercising the authentication path")
	}
}

// The 429 contract the dashboard and the control plane already agree on.
func TestRateLimitedResponseCarriesTheRetryContract(t *testing.T) {
	f := newFixture(t)
	f.handler.limiter = denyLimiter{} // refuses with a 7s hint

	rec := f.post(t, goodBody, nil)
	body := assertErrorShape(t, rec, http.StatusTooManyRequests, CodeRateLimited)

	if got := rec.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q, want \"7\"", got)
	}
	seconds, ok := body.Error.Details["retry_after_seconds"]
	if !ok {
		t.Fatalf("body carries no details.retry_after_seconds; the dashboard reads that field: %s", rec.Body.String())
	}
	if n, ok := seconds.(float64); !ok || n != 7 {
		t.Fatalf("details.retry_after_seconds = %v, want 7", seconds)
	}

	// Header and body must never disagree - a client that trusts one and logs
	// the other should not see two different numbers.
	if strconv.Itoa(int(seconds.(float64))) != rec.Header().Get("Retry-After") {
		t.Fatal("Retry-After header and details.retry_after_seconds disagree")
	}
}

// A pre-auth refusal uses the same contract. A client must not have to work out
// which of two ceilings refused it to know how long to wait.
func TestPreAuthRefusalCarriesTheSameContract(t *testing.T) {
	f := newFixture(t)
	f.handler.source = NewSourceLimiter(SourceLimits{Limit: 1, Window: time.Second, Burst: 1}, nil)
	f.post(t, goodBody, nil)

	rec := f.post(t, goodBody, nil)
	body := assertErrorShape(t, rec, http.StatusTooManyRequests, CodeRateLimited)
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("a pre-auth 429 carried no Retry-After")
	}
	if _, ok := body.Error.Details["retry_after_seconds"]; !ok {
		t.Fatal("a pre-auth 429 carried no details.retry_after_seconds")
	}
}

// A 429 must never leak which ceiling refused it. Telling an anonymous caller
// "the project ceiling" confirms the project exists, which is the disclosure
// ARCHITECTURE.md 8 refuses elsewhere in this handler.
func TestRateLimitedResponseDoesNotNameTheScope(t *testing.T) {
	f := newFixture(t)
	f.handler.limiter = denyLimiter{}
	rec := f.post(t, goodBody, nil)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.Body.String(), "project") {
		t.Fatalf("the 429 body names the ceiling that refused: %s", rec.Body.String())
	}
}

// A limiter fault is a fault, not a refusal - and it must not have left a
// Retry-After behind on a 202 either.
func TestLimiterFaultLeavesNoRetryHeader(t *testing.T) {
	f := newFixture(t)
	f.handler.limiter = faultyLimiter{}
	rec := f.post(t, goodBody, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "" {
		t.Fatal("a fail-open request advertised a Retry-After")
	}
}

// Concurrency at the HTTP boundary: the property is that the number of requests
// admitted past the pre-auth ceiling equals its capacity, however the requests
// interleave.
func TestConcurrentRequestsCannotExceedThePreAuthCeiling(t *testing.T) {
	const capacity = 20
	const callers = 200

	f := newFixture(t)
	counting := &countingStore{fakeStore: f.store}
	f.handler.store = counting
	f.handler.source = NewSourceLimiter(SourceLimits{Limit: capacity, Window: time.Hour, Burst: capacity}, nil)

	var mu sync.Mutex
	accepted := 0

	var g errgroup.Group
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		g.Go(func() error {
			<-start
			req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+f.projectID+"/events", strings.NewReader(goodBody))
			req.Header.Set("Authorization", "Bearer "+f.apiKey)
			req.Header.Set("Content-Type", "application/json")
			req.RemoteAddr = "198.51.100.10:12345"
			rec := httptest.NewRecorder()
			f.handler.ServeHTTP(rec, req)
			if rec.Code == http.StatusAccepted {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
			return nil
		})
	}
	close(start)
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}

	if accepted != capacity {
		t.Fatalf("%d of %d concurrent requests were accepted, want exactly the capacity (%d)", accepted, callers, capacity)
	}
	if counting.lookups() != capacity {
		t.Fatalf("%d database lookups for %d admitted requests; refused requests reached the pool", counting.lookups(), capacity)
	}
}
