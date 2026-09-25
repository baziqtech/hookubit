package egress

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Regression: Do wrapped its two structurally-permanent failures with
// fmt.Errorf, which package retry could only see as "some error" - and package
// retry retried every error. The marker interface is how the call site, which
// is the only place that knows, tells the classifier.
func TestBuildRequestFailureIsMarkedPermanent(t *testing.T) {
	guard, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	c := NewClient(guard, DefaultLimits())

	// An invalid method fails before any socket is opened, so this test does no
	// network I/O.
	_, err = c.Do(context.Background(), "BAD METHOD", "https://example.com/hook", nil, nil)
	if err == nil {
		t.Fatal("Do accepted an invalid HTTP method")
	}

	var pe *PermanentError
	if !errors.As(err, &pe) {
		t.Fatalf("error %v (%T) is not a *PermanentError", err, err)
	}
	if !pe.PermanentDeliveryError() {
		t.Fatal("PermanentError does not report itself as permanent")
	}
	if pe.Unwrap() == nil {
		t.Fatal("PermanentError discarded the cause")
	}
}

// transportOf reaches into the client for the one thing no observable
// behaviour reveals cheaply: the connection ceiling the transport is actually
// enforcing. A wrong value here shows up in production as latency, never as an
// error, which is exactly why it needs pinning.
func transportOf(t *testing.T, c *Client) *http.Transport {
	t.Helper()
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("client transport is %T, not *http.Transport", c.http.Transport)
	}
	return tr
}

// REGRESSION, and the reason this file exists in its current shape.
//
// MaxConnsPerHost was derived - `limits.IdleConnsPerHost * 4` off a hard-coded
// 4 - so the whole data plane held at most 16 connections to any one host:port,
// shared across every endpoint and every tenant resolving there. net/http
// BLOCKS requests over that ceiling, so it silently outranked
// WORKER_CONCURRENCY, MAX_CONCURRENCY_PER_ENDPOINT and the delivery gate.
// Measured: fast-group p95 of 119.9 s with the load suite's endpoints on one
// host against 16.6 s with the same endpoints on eight.
//
// The configured value must reach the transport unchanged.
func TestTransportUsesTheConfiguredPerHostCeiling(t *testing.T) {
	guard, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}

	limits := DefaultLimits()
	limits.MaxConnsPerHost = 128
	limits.IdleConnsPerHost = 12
	tr := transportOf(t, NewClient(guard, limits))

	if tr.MaxConnsPerHost != 128 {
		t.Fatalf("MaxConnsPerHost = %d, want 128 (the configured value, not a multiple of the idle pool)", tr.MaxConnsPerHost)
	}
	if tr.MaxIdleConnsPerHost != 12 {
		t.Fatalf("MaxIdleConnsPerHost = %d, want 12", tr.MaxIdleConnsPerHost)
	}
	// The idle pool must never be what decides concurrency again.
	if tr.MaxConnsPerHost == tr.MaxIdleConnsPerHost*4 {
		t.Fatal("MaxConnsPerHost is still being derived from MaxIdleConnsPerHost")
	}
}

// Zero must not mean unlimited. Every other bound in Limits treats zero as a
// configuration mistake; net/http treats MaxConnsPerHost == 0 as "no ceiling",
// so an unset field has to fall back to a real number rather than pass through.
func TestTransportRefusesAnUnboundedPerHostCeiling(t *testing.T) {
	guard, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}

	tr := transportOf(t, NewClient(guard, Limits{}))
	if tr.MaxConnsPerHost != DefaultMaxConnsPerHost {
		t.Fatalf("MaxConnsPerHost = %d, want the default %d; zero reaches net/http as UNLIMITED", tr.MaxConnsPerHost, DefaultMaxConnsPerHost)
	}
	if tr.MaxIdleConnsPerHost != DefaultIdleConnsPerHost {
		t.Fatalf("MaxIdleConnsPerHost = %d, want the default %d", tr.MaxIdleConnsPerHost, DefaultIdleConnsPerHost)
	}

	// An idle pool larger than the ceiling describes slots that can never be
	// filled; the two numbers must describe one pool.
	limits := DefaultLimits()
	limits.MaxConnsPerHost = 2
	limits.IdleConnsPerHost = 50
	tr = transportOf(t, NewClient(guard, limits))
	if tr.MaxIdleConnsPerHost != 2 {
		t.Fatalf("MaxIdleConnsPerHost = %d, want it clamped to MaxConnsPerHost (2)", tr.MaxIdleConnsPerHost)
	}
	if tr.MaxConnsPerHost != 2 {
		t.Fatalf("MaxConnsPerHost = %d, want 2; clamping must not raise the ceiling", tr.MaxConnsPerHost)
	}
}

// The ceiling is only meaningful if it is actually enforced concurrently, and
// enforcement is net/http's job - this asserts we asked for it correctly rather
// than trusting the field name. Two connections allowed, four requests to a
// handler that blocks until it has seen the expected overlap.
func TestPerHostCeilingBoundsConcurrentRequests(t *testing.T) {
	var inFlight, peak int64
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&inFlight, 1)
		for {
			p := atomic.LoadInt64(&peak)
			if n <= p || atomic.CompareAndSwapInt64(&peak, p, n) {
				break
			}
		}
		<-release
		atomic.AddInt64(&inFlight, -1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	guard, err := NewGuard(true, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	limits := DefaultLimits()
	limits.MaxConnsPerHost = 2
	limits.IdleConnsPerHost = 2
	limits.TotalTimeout = 10 * time.Second
	c := NewClient(guard, limits)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Do(context.Background(), http.MethodPost, srv.URL, nil, []byte(`{}`))
		}()
	}

	// Give the four goroutines time to pile up against the ceiling, then let
	// them all through.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt64(&inFlight) < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	got := atomic.LoadInt64(&peak)
	close(release)
	wg.Wait()

	if got > 2 {
		t.Fatalf("peak concurrent requests = %d, want at most MaxConnsPerHost (2)", got)
	}
	if got < 2 {
		t.Fatalf("peak concurrent requests = %d, want 2; the ceiling is lower than configured", got)
	}
}
