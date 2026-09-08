package db_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/db"
	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
)

// These two tests open a real pool. They live in the EXTERNAL test package so
// they can route through testsupport - which imports db, and so cannot be
// imported from inside package db without a cycle.
//
// The isolation matters more here than anywhere else: CREATE DATABASE ...
// TEMPLATE refuses to run while any session is connected to the template, so a
// test in this package holding a pool open on DATABASE_URL would break every
// other package's setup rather than merely its own assertions.

// statement_timeout is the server-side backstop for a query that would
// otherwise hold a pooled connection for as long as PostgreSQL is willing to
// wait. It is applied per connection, so this checks a connection the pool
// handed out, not the configuration struct.
func TestOpenAppliesStatementTimeout(t *testing.T) {
	url := testsupport.DSN(t)
	ctx := context.Background()

	pool, err := db.Open(ctx, url, 2, 750*time.Millisecond)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var timeout string
	if err := pool.QueryRow(ctx, "SHOW statement_timeout").Scan(&timeout); err != nil {
		t.Fatalf("SHOW statement_timeout: %v", err)
	}
	if timeout != "750ms" {
		t.Fatalf("statement_timeout = %q, want 750ms", timeout)
	}

	// And it actually fires: a query with no deadline of its own is still cut
	// off rather than pinning the connection.
	_, err = pool.Exec(ctx, "SELECT pg_sleep(5)")
	if err == nil {
		t.Fatal("pg_sleep(5) completed; statement_timeout did not fire")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "statement timeout") {
		t.Fatalf("error = %v, want a statement timeout", err)
	}
}

// Zero disables it, which is the escape hatch for a deployment that sets the
// timeout on the role instead.
func TestOpenWithoutStatementTimeout(t *testing.T) {
	url := testsupport.DSN(t)
	pool, err := db.Open(context.Background(), url, 2, 0)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	pool.Close()
}
