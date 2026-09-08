// Package testsupport gives every test package its own PostgreSQL database.
//
// # Why this exists
//
// Two production queries are deliberately GLOBAL - queue.PostgresQueue.Claim
// orders the whole ready set by (next_attempt_at, created_at) and takes a
// LIMIT, and router.PostgresStore.ClaimOutbox does the same over event_outbox.
// Neither carries a tenant predicate, and that is correct: draining a queue
// means draining it.
//
// The consequence is that any assertion about WHICH rows a batch contains
// depends on every row in the database, including rows another test package
// left behind. On one shared database that is not flakiness, it is a global
// query meeting shared state - it passes alone, fails after its neighbours, and
// reads as a race, an ordering bug or an idempotency bug in turn.
//
// Fixtures that DELETE the tables their global query reads before seeding fix
// the symptom and do not compose: the delete is itself a race between packages,
// and it silently destroys another package's in-flight data.
//
// The fix is real isolation. PostgreSQL can create a database from a template
// as a file copy, so each test package gets its own copy of the already
// migrated schema for the cost of that copy and no migration run. A global
// query is then global over one package's rows, which is exactly the scope the
// tests mean.
//
// A per-package SCHEMA (search_path) would be lighter, but the Prisma
// migrations create every object in `public`; each schema would have to be
// migrated separately, and the data plane deliberately never runs migrations
// (ADR-0002). The template copy needs neither.
package testsupport

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/db"
)

// maxIdentifier is PostgreSQL's NAMEDATALEN - 1.
const maxIdentifier = 63

// prepared caches one prepare-the-database attempt per derived name, so a
// package that calls Pool from thirty tests pays the copy once.
var (
	preparedMu sync.Mutex
	prepared   = map[string]preparedDB{}
)

type preparedDB struct {
	dsn string
	err error
}

// DSN returns a connection string pointing at this test package's own database,
// creating that database from the DATABASE_URL one if it does not already
// exist.
//
// It keeps the existing contract exactly: with DATABASE_URL unset the calling
// test skips, it does not fail.
func DSN(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	// The caller is the package under test; its import path names the database.
	suffix := callerPackageSuffix(2)
	dsn, err := prepare(raw, suffix)
	if err != nil {
		t.Fatalf("prepare per-package test database: %v", err)
	}
	return dsn
}

// Pool opens a bounded pool on this test package's own database and closes it
// when the test finishes.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	suffix := callerPackageSuffix(2)
	dsn, err := prepare(raw, suffix)
	if err != nil {
		t.Fatalf("prepare per-package test database: %v", err)
	}

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

// prepare creates the per-package database once per process and hands back the
// DSN that points at it.
func prepare(raw, suffix string) (string, error) {
	template, err := databaseName(raw)
	if err != nil {
		return "", err
	}
	name := derivedName(template, suffix)

	preparedMu.Lock()
	defer preparedMu.Unlock()
	if got, ok := prepared[name]; ok {
		return got.dsn, got.err
	}

	dsn, err := createFromTemplate(raw, template, name)
	prepared[name] = preparedDB{dsn: dsn, err: err}
	return dsn, err
}

// createFromTemplate drops and recreates name from template.
//
// Dropping first rather than reusing an existing copy is deliberate: a run
// starts from the migrated schema and nothing else, so a package cannot inherit
// rows from its own previous run either. The database is left in place
// afterwards - it costs nothing until the next run drops it, and it is the only
// thing left to look at when a failure needs a postmortem.
func createFromTemplate(raw, template, name string) (string, error) {
	if err := validIdentifier(name); err != nil {
		return "", err
	}
	if err := validIdentifier(template); err != nil {
		return "", err
	}

	adminDSN, err := withDatabase(raw, "postgres")
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// A single connection, not a pool, and closed before the caller connects to
	// anything: CREATE DATABASE ... TEMPLATE fails outright while any session is
	// connected to the template, so this must never hold one open on it.
	conn, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		return "", fmt.Errorf("connect to the `postgres` maintenance database to create %q: %w", name, err)
	}
	defer func() { _ = conn.Close(context.Background()) }()

	drop := fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, quoteIdentifier(name))
	create := fmt.Sprintf(`CREATE DATABASE %s TEMPLATE %s`, quoteIdentifier(name), quoteIdentifier(template))

	if err := retrying(ctx, conn, drop, template); err != nil {
		return "", explain(err, name, template)
	}

	// Evict BEFORE the first attempt, not after a failure. A CREATE DATABASE
	// that finds the template in use does not fail fast - PostgreSQL waits
	// several seconds for the other backends to leave before raising 55006 - so
	// discovering the problem by hitting it costs about eight seconds every
	// time, per package. Clearing the idle sessions up front makes the common
	// case (a database GUI left open on the template) free.
	evictIdleSessions(ctx, conn, template)

	if err := retrying(ctx, conn, create, template); err != nil {
		return "", explain(err, name, template)
	}

	return withDatabase(raw, name)
}

// retryable are the transient failures of concurrent CREATE/DROP DATABASE.
// `go test ./...` runs packages in parallel, so several processes reach this at
// once: 55006 is the template or target being momentarily in use, 23505 is two
// processes racing to create rows in pg_database, and the deadlock and
// serialisation codes are catalogue contention.
var retryable = map[string]bool{
	"55006": true, // object_in_use
	"55P03": true, // lock_not_available
	"40001": true, // serialization_failure
	"40P01": true, // deadlock_detected
	"23505": true, // unique_violation - lost a create race
	"42P04": true, // duplicate_database - lost a create race
	"XX000": true, // internal_error, e.g. "tuple concurrently updated"
}

func retrying(ctx context.Context, conn *pgx.Conn, sql, template string) error {
	var last error
	for attempt := 0; attempt < 10; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("%s: gave up after %d attempts (%v): %w", sql, attempt, ctx.Err(), last)
			case <-time.After(time.Duration(attempt) * 150 * time.Millisecond):
			}
		}

		// Each statement gets its own deadline. A copy of a 10MB template is a
		// second or two; a statement still running after a minute is blocked on a
		// lock, and waiting out the whole budget on the first attempt would spend
		// the retries that would have cleared it.
		attemptCtx, cancel := context.WithTimeout(ctx, time.Minute)
		_, err := conn.Exec(attemptCtx, sql)
		cancel()
		if err == nil {
			return nil
		}
		last = err

		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) {
			if ctx.Err() != nil {
				return fmt.Errorf("%s: gave up after %d attempts (%v): %w", sql, attempt+1, ctx.Err(), err)
			}
			if attemptCtx.Err() != nil {
				// Blocked, most likely behind another package's copy of the same
				// template. Worth another go.
				continue
			}
			return err
		}
		if !retryable[pgErr.Code] {
			return err
		}
		if pgErr.Code == "55006" {
			// Something is connected to the template. In practice that is a database
			// GUI a developer left open on it, or a test process that crashed with a
			// pool still up - either way an idle session that will never close on its
			// own, and it blocks EVERY package, not just this one.
			//
			// Evicting it is a deliberate, narrow licence: this only runs against the
			// database DATABASE_URL names during a test run, which this helper is
			// already copying and dropping databases from, and it kills only idle
			// sessions - never one running a statement. Without it a perfectly healthy
			// checkout fails with a SQLSTATE that names no cause.
			//
			// If there was nothing idle to evict, retrying is not worth its cost: a
			// CREATE DATABASE that finds the template busy spends several seconds
			// discovering it. A session that is not idle will not leave on its own, so
			// report it now rather than after the whole budget.
			if evictIdleSessions(ctx, conn, template) == 0 {
				return err
			}
		}
	}
	return fmt.Errorf("%s: still failing after 10 attempts: %w", sql, last)
}

// evictIdleSessions closes idle connections to the template so it can be copied,
// and reports how many it closed. Best effort: on error it reports none, and the
// caller falls back to the original 55006.
func evictIdleSessions(ctx context.Context, conn *pgx.Conn, database string) int {
	evictCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := conn.Query(evictCtx,
		`SELECT pg_terminate_backend(pid)
		   FROM pg_stat_activity
		  WHERE datname = $1
		    AND pid <> pg_backend_pid()
		    AND state = 'idle'`, database)
	if err != nil {
		return 0
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	if rows.Err() != nil {
		return 0
	}
	return n
}

// explain turns the two failures an operator will actually hit into a sentence
// that names the cause, rather than leaving a bare SQLSTATE to be decoded.
func explain(err error, name, template string) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "42501": // insufficient_privilege
		return fmt.Errorf(
			"the DATABASE_URL role lacks the CREATEDB privilege, so per-package test databases cannot be created "+
				"(grant it with: ALTER ROLE <role> CREATEDB): %w", err)
	case "55006": // object_in_use
		return fmt.Errorf(
			"cannot copy template database %q: a session is still connected to it and could not be evicted because it "+
				"is not idle. Check `SELECT pid, application_name, state FROM pg_stat_activity WHERE datname = '%s'`; "+
				"note that every test package must connect through testsupport rather than to DATABASE_URL directly: %w",
			template, template, err)
	case "3D000": // invalid_catalog_name
		return fmt.Errorf(
			"template database %q does not exist; run the migrations against it first (pnpm test:db:migrate): %w", template, err)
	default:
		return fmt.Errorf("preparing test database %q from template %q: %w", name, template, err)
	}
}

// withDatabase rewrites the DSN to point at a different database, reusing
// db.NormaliseDSN so the Prisma-only parameters an operator's URL may carry are
// handled in exactly one place.
func withDatabase(raw, name string) (string, error) {
	normalised, err := db.NormaliseDSN(raw)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(normalised)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL is not a URL, so testsupport cannot retarget it at a per-package database: %w", err)
	}
	u.Path = "/" + name
	return u.String(), nil
}

// databaseName reads the template database out of DATABASE_URL.
func databaseName(raw string) (string, error) {
	normalised, err := db.NormaliseDSN(raw)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(normalised)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL is not a URL: %w", err)
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return "", fmt.Errorf("DATABASE_URL names no database, so there is no template to copy")
	}
	return name, nil
}

// derivedName is template + "_" + suffix, kept inside NAMEDATALEN. When it does
// not fit, the tail is replaced by a hash of the full name rather than simply
// truncated, so two long package paths cannot collapse onto one database.
func derivedName(template, suffix string) string {
	name := template + "_" + suffix
	if len(name) <= maxIdentifier {
		return name
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(name))
	digest := fmt.Sprintf("%016x", h.Sum64())
	return name[:maxIdentifier-len(digest)-1] + "_" + digest
}

// callerPackageSuffix names the database after the package under test.
func callerPackageSuffix(skip int) string {
	pc, _, _, ok := runtime.Caller(skip)
	if !ok {
		return "pkg"
	}
	fn := runtime.FuncForPC(pc)
	if fn == nil {
		return "pkg"
	}
	return packageSuffix(importPathOf(fn.Name()))
}

// importPathOf strips the function (and any receiver) off a runtime function
// name, leaving the import path:
//
//	github.com/o/r/internal/router.requirePool        -> github.com/o/r/internal/router
//	github.com/o/r/internal/queue.(*fixture).status   -> github.com/o/r/internal/queue
func importPathOf(fullName string) string {
	slash := strings.LastIndex(fullName, "/")
	dot := strings.Index(fullName[slash+1:], ".")
	if dot < 0 {
		return fullName
	}
	return fullName[:slash+1+dot]
}

// packageSuffix turns an import path into a database-name fragment: everything
// below the module root, flattened. `internal/router` becomes
// `internal_router`, which keeps two same-named packages in different
// directories apart.
//
// A trailing `_test` is dropped so a package's external test package (which the
// compiler names `.../db_test`) shares its database rather than getting a
// second copy for no reason.
func packageSuffix(importPath string) string {
	path := importPath
	if i := strings.Index(path, "/internal/"); i >= 0 {
		path = path[i+1:]
	} else if i := strings.LastIndex(path, "/"); i >= 0 {
		path = path[i+1:]
	}
	path = strings.TrimSuffix(path, "_test")

	var b strings.Builder
	for _, r := range strings.ToLower(path) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "pkg"
	}
	return out
}

// validIdentifier is belt and braces. Both names are derived here rather than
// supplied by a caller, but they are interpolated into DDL, which parameters
// cannot carry - so the assumption is checked rather than assumed.
func validIdentifier(name string) error {
	if name == "" || len(name) > maxIdentifier {
		return fmt.Errorf("database name %q is not a usable PostgreSQL identifier", name)
	}
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			continue
		}
		return fmt.Errorf("database name %q contains %q, which testsupport will not interpolate into DDL", name, r)
	}
	return nil
}

func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
