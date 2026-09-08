package db

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// statement_timeout is the server-side backstop for a query that would
// otherwise hold a pooled connection for as long as PostgreSQL is willing to
// wait. It is applied per connection, so this checks a connection the pool
// handed out, not the configuration struct.
func TestOpenAppliesStatementTimeout(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	ctx := context.Background()

	pool, err := Open(ctx, url, 2, 750*time.Millisecond)
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
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	pool, err := Open(context.Background(), url, 2, 0)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	pool.Close()
}

// The control plane and the data plane are specified to read the SAME
// DATABASE_URL. Prisma's documented connection string carries `schema`, which
// PostgreSQL rejects with SQLSTATE 42704 - so without this the second plane
// simply cannot start against a URL the first one requires.
func TestNormaliseDSNStripsPrismaOnlyParameters(t *testing.T) {
	got, err := normaliseDSN("postgresql://u:p@localhost:5432/db?schema=public&connection_limit=5&sslmode=disable")
	if err != nil {
		t.Fatalf("normaliseDSN: %v", err)
	}
	if strings.Contains(got, "schema=") {
		t.Errorf("schema= survived: %s", got)
	}
	if strings.Contains(got, "connection_limit") {
		t.Errorf("connection_limit survived: %s", got)
	}
	if !strings.Contains(got, "search_path=public") {
		t.Errorf("schema was dropped rather than translated to search_path: %s", got)
	}
	if !strings.Contains(got, "sslmode=disable") {
		t.Errorf("an operator's own parameter was lost: %s", got)
	}
}

func TestNormaliseDSNLeavesAPlainURLAlone(t *testing.T) {
	in := "postgresql://u:p@localhost:5432/db?sslmode=require"
	got, err := normaliseDSN(in)
	if err != nil {
		t.Fatalf("normaliseDSN: %v", err)
	}
	if got != in {
		t.Errorf("rewrote a URL that needed no change:\n got %s\nwant %s", got, in)
	}
}
