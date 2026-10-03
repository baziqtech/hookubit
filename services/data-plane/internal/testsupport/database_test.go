package testsupport

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/shaq/hookubit/services/data-plane/internal/db"
)

// The guard that makes emptying the database safe. Every test package
// TRUNCATEs this database before it runs, so the only thing standing between a
// mistyped DATABASE_URL and someone's development data is this check.
func TestRefusesAnyDatabaseNotNamedAsATest(t *testing.T) {
	refused := []string{
		"hookubit",            // the development database - the one that matters
		"postgres",            //
		"hookubit_production", //
		"test",                // "test" is not the same as "_test"
		"hookubit_test_old",   // a leftover from the old per-package scheme
	}
	for _, name := range refused {
		t.Run(name, func(t *testing.T) {
			err := assertTestDatabase(name)
			if err == nil {
				t.Fatalf("assertTestDatabase(%q) allowed a database that is not a test database", name)
			}
			// The message has to say what to do, not just what went wrong.
			if !strings.Contains(err.Error(), "hookubit_test") {
				t.Fatalf("refusal does not name the database to use: %v", err)
			}
		})
	}

	for _, name := range []string{"hookubit_test", "webhook_platform_test", "anything_test"} {
		if err := assertTestDatabase(name); err != nil {
			t.Fatalf("assertTestDatabase(%q) refused a legitimate test database: %v", name, err)
		}
	}
}

func TestLockKeyIsStablePerDatabaseAndDiffersBetweenThem(t *testing.T) {
	if lockKey("hookubit_test") != lockKey("hookubit_test") {
		t.Fatal("lock key is not stable for one database, so two runs would not queue")
	}
	if lockKey("hookubit_test") == lockKey("other_test") {
		t.Fatal("two databases share a lock key, so unrelated suites would queue behind each other")
	}
}

func TestDatabaseNameReadsTheDatabaseOutOfTheURL(t *testing.T) {
	dsn, err := db.NormaliseDSN("postgresql://u:p@localhost:5432/hookubit_test?schema=public&sslmode=disable")
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	name, err := databaseName(dsn)
	if err != nil {
		t.Fatalf("databaseName: %v", err)
	}
	if name != "hookubit_test" {
		t.Fatalf("databaseName = %q, want hookubit_test", name)
	}

	if _, err := databaseName("postgresql://u:p@localhost:5432/"); err == nil {
		t.Fatal("a URL naming no database was accepted")
	}
}

// The lock is what replaces the per-package databases, so it is worth proving
// that it actually excludes a second holder rather than trusting the SQL.
func TestAdvisoryLockExcludesASecondHolder(t *testing.T) {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	dsn, err := db.NormaliseDSN(raw)
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// A key of this test's own, so it cannot collide with the lock the suite
	// itself is holding on the real database.
	key := lockKey("testsupport_lock_probe_test")

	first, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer first.Close(context.Background())

	var got bool
	if err := first.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
		t.Fatalf("first lock: %v", err)
	}
	if !got {
		t.Fatal("could not take a lock nobody else should hold")
	}

	second, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect second: %v", err)
	}
	defer second.Close(context.Background())

	if err := second.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
		t.Fatalf("second lock: %v", err)
	}
	if got {
		t.Fatal("two sessions hold the same advisory lock, so test packages would not be isolated")
	}

	// Releasing by closing the session is what the real code relies on: it
	// never calls pg_advisory_unlock, it lets the process exit.
	if err := first.Close(context.Background()); err != nil {
		t.Fatalf("close first: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := second.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
			t.Fatalf("retry lock: %v", err)
		}
		if got {
			return // the lock followed the closed session, as designed
		}
		if time.Now().After(deadline) {
			t.Fatal("the advisory lock outlived the session that held it")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The whole point of the change: running the suite must not leave databases
// behind. This asserts the process it is running in created none.
func TestLeavesNoDatabasesBehind(t *testing.T) {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	pool := Pool(t) // takes the lock and truncates, exactly as a real package does

	var strays int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM pg_database WHERE datname LIKE 'hookubit\_test\_%'`).Scan(&strays)
	if err != nil {
		t.Fatalf("count databases: %v", err)
	}
	if strays != 0 {
		t.Fatalf("%d per-package test databases exist; testsupport must use only the DATABASE_URL one", strays)
	}
}
