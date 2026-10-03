// Package testsupport gives every test package the same PostgreSQL database,
// one package at a time.
//
// # The problem it solves
//
// Two production queries are deliberately GLOBAL - queue.PostgresQueue.Claim
// orders the whole ready set by (next_attempt_at, created_at) and takes a
// LIMIT, and router.PostgresStore.ClaimOutbox does the same over event_outbox.
// Neither carries a tenant predicate, and that is correct: draining a queue
// means draining it.
//
// The consequence is that any assertion about WHICH rows a batch contains
// depends on every row in the database, including rows another test package
// left behind. Sharing a database naively is not flakiness, it is a global
// query meeting shared state - it passes alone, fails after its neighbours, and
// reads as a race, an ordering bug or an idempotency bug in turn.
//
// # How it is solved
//
// ONE database, held exclusively. A test binary takes a PostgreSQL session
// advisory lock on the database named by DATABASE_URL, truncates every table
// once, and holds that lock until the process exits. A second test binary
// blocks on the lock until the first is done. A global query is then global
// over one package's rows, which is exactly the scope the tests mean.
//
// The cost is honest and worth naming: DB-backed packages no longer run
// concurrently with each other. `go test ./...` still starts them in parallel,
// they just queue at the lock, so wall time is the sum of the database suites
// rather than the longest one. Packages with no database tests are unaffected.
//
// # Why not a database per package
//
// It used to create one, as a template copy - `hookubit_test_internal_worker`
// and so on. It was fast and it was correct, and it left one database per
// package per TEST_DB_RUN_ID behind after every run, because a copy is only
// dropped when that exact name is next used. On one developer machine that had
// reached 314 databases and 3.3 GB. The lock costs wall time; the copies cost
// disk that nobody ever reclaims, and a `\l` nobody can read.
//
// The lock is also stricter than the old scheme in the way that matters: two
// concurrent RUNS against one DATABASE_URL used to clobber each other's
// databases (hence the TEST_DB_RUN_ID escape hatch, now gone). They now simply
// queue.
//
// A per-package SCHEMA (search_path) would avoid the queueing, but the Prisma
// migrations create every object in `public`; each schema would have to be
// migrated separately, and the data plane deliberately never runs migrations
// (ADR-0002).
package testsupport

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/db"
)

// lockWait bounds how long a test binary queues behind another one. It exists
// so the failure is a sentence naming the other run rather than Go's bare
// "panic: test timed out", which says nothing about why.
const lockWait = 5 * time.Minute

// pollInterval is how often the queueing binary retries the lock. Short enough
// that a 3-second package does not add a second to the next one.
const pollInterval = 150 * time.Millisecond

// acquired caches the one acquire-and-truncate per process. `held` keeps the
// locking connection alive for the lifetime of the test binary: the advisory
// lock is SESSION scoped, so it is released by the connection closing, which
// happens when the process exits - including when it panics or is killed.
var (
	acquireOnce sync.Once
	acquired    struct {
		dsn string
		err error
	}
	held *pgx.Conn //nolint:unused // kept alive on purpose; see above.
)

// DSN returns a connection string for the shared test database, having
// exclusively acquired it and emptied it for this package.
//
// It keeps the existing contract exactly: with DATABASE_URL unset the calling
// test skips, it does not fail.
func DSN(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	dsn, err := acquire(raw)
	if err != nil {
		t.Fatalf("acquire the shared test database: %v", err)
	}
	return dsn
}

// Pool opens a bounded pool on the shared test database and closes it when the
// test finishes. The advisory lock is NOT released with the pool - it belongs
// to the process, not to one test.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := DSN(t)

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// acquire locks the test database for this process and empties it, once.
func acquire(raw string) (string, error) {
	acquireOnce.Do(func() {
		acquired.dsn, acquired.err = lockAndReset(raw)
	})
	return acquired.dsn, acquired.err
}

func lockAndReset(raw string) (string, error) {
	dsn, err := db.NormaliseDSN(raw)
	if err != nil {
		return "", err
	}
	name, err := databaseName(dsn)
	if err != nil {
		return "", err
	}
	if err := assertTestDatabase(name); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), lockWait+30*time.Second)
	defer cancel()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return "", explain(err, name)
	}
	if err := lock(ctx, conn, name); err != nil {
		_ = conn.Close(context.Background())
		return "", err
	}
	if err := truncateAll(ctx, conn, name); err != nil {
		_ = conn.Close(context.Background())
		return "", err
	}

	held = conn
	return dsn, nil
}

// assertTestDatabase is the guard that makes emptying the database safe.
//
// Every test now runs against the database DATABASE_URL names, and the first
// thing it does is TRUNCATE every table in it. If that URL ever points at a
// development or - unthinkably - a production database, the run would destroy
// it. The old per-package scheme could not do this: it copied the database and
// never wrote to the original.
//
// So the name has to say it is a test database. `hookubit_test` is the one this
// repo uses; any `*_test` is accepted so a fork or a second checkout is not
// forced to rename.
func assertTestDatabase(name string) error {
	if strings.HasSuffix(name, "_test") {
		return nil
	}
	return fmt.Errorf(
		"refusing to run tests against database %q: every test package empties this database before it runs, "+
			"so its name must end in _test to prove it is not a development or production one. "+
			"Point DATABASE_URL at hookubit_test (create it with: pnpm test:db:migrate)", name)
}

// lock takes the session advisory lock, queueing behind any other test binary.
//
// `pg_try_advisory_lock` in a loop rather than the blocking `pg_advisory_lock`:
// blocking forever means the operator sees Go's test timeout, which names
// neither this database nor the run that is holding it.
func lock(ctx context.Context, conn *pgx.Conn, name string) error {
	key := lockKey(name)
	deadline := time.Now().Add(lockWait)

	for {
		var got bool
		if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
			return fmt.Errorf("taking the advisory lock on %q: %w", name, err)
		}
		if got {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf(
				"waited %s for exclusive use of test database %q and another test binary still holds it. "+
					"Every DB-backed package takes this lock for its whole run, so they queue; if nothing else is "+
					"running, a stale session is holding it - find it with "+
					"`SELECT pid, application_name, state FROM pg_locks l JOIN pg_stat_activity a USING (pid) "+
					"WHERE l.locktype = 'advisory' AND l.objid = %d`", lockWait, name, uint32(key))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// truncateAll empties every table so the package starts from the migrated
// schema and nothing else - the same guarantee the template copy gave.
//
// `_prisma_migrations` is excluded: it IS the schema's identity, and truncating
// it would make the next `prisma migrate deploy` try to replay every migration
// against a database that already has the objects.
func truncateAll(ctx context.Context, conn *pgx.Conn, name string) error {
	var list *string
	err := conn.QueryRow(ctx, `
		SELECT string_agg(quote_ident(tablename), ', ')
		FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`).Scan(&list)
	if err != nil {
		return fmt.Errorf("listing the tables of %q: %w", name, err)
	}
	if list == nil || *list == "" {
		return fmt.Errorf(
			"test database %q has no tables: run the migrations against it first (pnpm test:db:migrate)", name)
	}

	// RESTART IDENTITY so a sequence cannot carry values across packages;
	// CASCADE because the ledger is a graph of foreign keys and truncating it
	// piecemeal is an ordering problem with no stable answer.
	if _, err := conn.Exec(ctx, "TRUNCATE TABLE "+*list+" RESTART IDENTITY CASCADE"); err != nil {
		return fmt.Errorf("emptying %q: %w", name, err)
	}
	return nil
}

// lockKey derives the advisory-lock key from the database name, so two
// different test databases on one server do not queue behind each other.
func lockKey(name string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("hookubit-testsupport:" + name))
	return int64(h.Sum64()) //nolint:gosec // any 64-bit value is a valid key.
}

// databaseName reads the database out of a normalised DSN.
func databaseName(dsn string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL is not a URL: %w", err)
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return "", errors.New("DATABASE_URL names no database")
	}
	return name, nil
}

// explain turns the failure an operator will actually hit into a sentence that
// names the cause, rather than leaving a bare SQLSTATE to be decoded.
func explain(err error, name string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "3D000" { // invalid_catalog_name
		return fmt.Errorf(
			"test database %q does not exist; create and migrate it first (pnpm test:db:migrate): %w", name, err)
	}
	return fmt.Errorf("connecting to test database %q: %w", name, err)
}
