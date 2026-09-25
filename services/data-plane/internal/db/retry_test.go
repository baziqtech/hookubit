package db_test

import (
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/db"
)

// closedPortDSN returns a DSN pointing at a port that was bound and then
// released, so a connection attempt is refused immediately rather than hanging
// on an unroutable address.
func closedPortDSN(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatalf("release the port: %v", err)
	}
	return "postgresql://postgres:root@" + addr + "/hookubit?sslmode=disable"
}

// A PostgreSQL outage during boot must be waited out, not exited on.
//
// The regression this guards: run() used to open the pool BEFORE binding the
// probe server, so a database outage exited the process with :9090 never bound.
// Every pod then crash-looped, and recovery was gated on kubelet's exponential
// backoff rather than on the database - the same fleet-wide restart the
// liveness probe avoids by never touching PostgreSQL (ARCHITECTURE.md 46),
// moved to a different point in the lifecycle. A startupProbe cannot rescue a
// process that has already exited, which is why the wait lives here.
func TestOpenWithRetryWaitsForAnUnreachableDatabase(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()

	var attempts int
	var lastBackoff time.Duration
	start := time.Now()

	pool, err := db.OpenWithRetry(ctx, closedPortDSN(t), 2, 0,
		func(attempt int, _ error, retryIn time.Duration) {
			attempts = attempt
			lastBackoff = retryIn
		})

	if err == nil {
		pool.Close()
		t.Fatal("expected an error against a closed port, got a usable pool")
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Fatalf("gave up after %v; it should have kept retrying until the context expired", elapsed)
	}
	if attempts < 2 {
		t.Fatalf("retried %d time(s); a single attempt is the fast-fail behaviour this function exists to replace", attempts)
	}
	if lastBackoff < 250*time.Millisecond {
		t.Fatalf("backoff %v never grew; a tight loop against a down database is its own problem", lastBackoff)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error should unwrap to the context cause, got %v", err)
	}
	// The operator needs the connection error, not just "context deadline
	// exceeded", or the logs name the shutdown and hide why it was waiting.
	if !strings.Contains(err.Error(), "last connection error") {
		t.Fatalf("error dropped the standing connection failure: %v", err)
	}
}

// A malformed DATABASE_URL is a configuration error, not an outage. Retrying it
// looks identical from the outside to waiting out a database that is coming
// back, and those two need telling apart: one clears on its own, the other
// never will.
func TestOpenWithRetryDoesNotRetryAMalformedURL(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	retried := false
	start := time.Now()
	pool, err := db.OpenWithRetry(ctx, "://not-a-url", 2, 0,
		func(int, error, time.Duration) { retried = true })

	if err == nil {
		pool.Close()
		t.Fatal("expected a malformed URL to be rejected")
	}
	if retried {
		t.Fatal("a malformed URL was retried; it will never become valid")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %v to reject a malformed URL; it should not have waited at all", elapsed)
	}
}

// The happy path must not pay for the retry loop: a reachable database is
// opened on the first attempt with no backoff at all.
func TestOpenWithRetryOpensAReachableDatabaseImmediately(t *testing.T) {
	t.Parallel()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	retried := false
	pool, err := db.OpenWithRetry(ctx, url, 2, 0, func(int, error, time.Duration) { retried = true })
	if err != nil {
		t.Fatalf("open a reachable database: %v", err)
	}
	defer pool.Close()

	if retried {
		t.Fatal("a reachable database should be opened on the first attempt")
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("pool is not usable: %v", err)
	}
}
