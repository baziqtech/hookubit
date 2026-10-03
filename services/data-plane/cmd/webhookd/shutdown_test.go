package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/httpx"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/logging"
)

// freePort binds :0, reads the port and releases it. Racy in principle, fine
// here: nothing else in this test binary binds ports.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("release port: %v", err)
	}
	return port
}

func readyStatus(t *testing.T, url string) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("probe request: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func dialable(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// The regression this pins: readiness must report draining BEFORE the ingest
// listener stops accepting. Before the fix, SetReady(false) ran only after
// dispatch unwound, so /health/ready answered 200 for the whole 15s drain while
// port 8080 was already refusing connections - 502s on the write path during a
// rolling update.
func TestBeginDrainFlipsReadinessBeforeListenerCloses(t *testing.T) {
	t.Parallel()

	health := httpx.NewHealth(nil) // no dependency checks: no database needed
	health.SetReady(true)
	probes := httptest.NewServer(health.Handler())
	defer probes.Close()
	readyURL := probes.URL + "/health/ready"

	if got := readyStatus(t, readyURL); got != http.StatusOK {
		t.Fatalf("before signal: ready status = %d, want %d", got, http.StatusOK)
	}

	signalCtx, signal := context.WithCancel(context.Background())
	defer signal()

	const readinessDelay = 750 * time.Millisecond
	runCtx, cancelRun, drainStartedAt := beginDrain(
		signalCtx, health, readinessDelay, logging.New("error", "test"), "ingest")
	defer cancelRun()

	port := freePort(t)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	served := make(chan error, 1)
	go func() {
		served <- ingest.Serve(runCtx, port,
			http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }),
			logging.New("error", "test"))
	}()

	waitUntil(t, 2*time.Second, func() bool { return dialable(addr) })

	signal()

	// The ordering assertion. Poll for the readiness flip, and require that the
	// listener is STILL accepting at the moment we observe it.
	deadline := time.Now().Add(readinessDelay)
	flipped := false
	for time.Now().Before(deadline) {
		if readyStatus(t, readyURL) == http.StatusServiceUnavailable {
			if !dialable(addr) {
				t.Fatal("listener stopped accepting before or with the readiness flip; " +
					"load balancers would still be sending to a closed socket")
			}
			flipped = true
			break
		}
	}
	if !flipped {
		t.Fatalf("readiness never reported draining within the %s propagation delay", readinessDelay)
	}

	select {
	case <-drainStartedAt:
	default:
		t.Fatal("drain start instant was not published")
	}

	// And the delay really does end in a drain.
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("ingest server did not drain after the propagation delay")
	}
	if dialable(addr) {
		t.Fatal("listener still accepting after drain")
	}
}

// A zero delay must not be a special case that hangs: SIGTERM has to terminate
// promptly when an operator opts out of the propagation window.
func TestBeginDrainZeroDelayCancelsImmediately(t *testing.T) {
	t.Parallel()

	health := httpx.NewHealth(nil)
	health.SetReady(true)

	signalCtx, signal := context.WithCancel(context.Background())
	defer signal()
	runCtx, cancelRun, _ := beginDrain(signalCtx, health, 0, logging.New("error", "test"), "worker")
	defer cancelRun()

	if runCtx.Err() != nil {
		t.Fatal("role context cancelled before the signal")
	}
	signal()

	select {
	case <-runCtx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("zero readiness delay did not cancel the role context promptly")
	}
	waitUntil(t, time.Second, func() bool { return !healthReady(health) })
}

// healthReady reads readiness through the handler, which is the only public
// surface for it.
func healthReady(h *httpx.Health) bool {
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	return rec.Code == http.StatusOK
}

func waitUntil(t *testing.T, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", within)
}
