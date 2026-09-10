package testsupport

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5"
	"strings"
	"testing"
)

// The database name is derived, not supplied, and it is interpolated into DDL
// that cannot take parameters - so the derivation is the safety property, not a
// convenience.
func TestPackageSuffixNamesThePackageUnderTest(t *testing.T) {
	cases := map[string]string{
		"github.com/shaq/hookubit/services/data-plane/internal/router": "internal_router",
		"github.com/shaq/hookubit/services/data-plane/internal/queue":  "internal_queue",
		// The compiler names an external test package `<pkg>_test`; it must share
		// the database of the package it tests rather than take a second copy.
		"github.com/shaq/hookubit/services/data-plane/internal/db_test": "internal_db",
		// Two packages with the same base name in different directories stay
		// apart, because the path below the module root is kept.
		"github.com/shaq/hookubit/services/data-plane/internal/egress/store": "internal_egress_store",
		"example.com/mod/toplevel": "toplevel",
	}
	for in, want := range cases {
		if got := packageSuffix(in); got != want {
			t.Errorf("packageSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestImportPathOfStripsFunctionAndReceiver(t *testing.T) {
	cases := map[string]string{
		"github.com/o/r/internal/router.requirePool":      "github.com/o/r/internal/router",
		"github.com/o/r/internal/queue.(*fixture).status": "github.com/o/r/internal/queue",
		"github.com/o/r/internal/db_test.TestOpen":        "github.com/o/r/internal/db_test",
	}
	for in, want := range cases {
		if got := importPathOf(in); got != want {
			t.Errorf("importPathOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// Nothing that reaches quoteIdentifier may carry anything but [a-z0-9_], so a
// derivation bug fails loudly here rather than becoming DDL.
func TestValidIdentifierRejectsAnythingUnquotable(t *testing.T) {
	for _, bad := range []string{"", `foo"; DROP DATABASE x --`, "Mixed_Case", "with-dash", strings.Repeat("a", 64)} {
		if err := validIdentifier(bad); err == nil {
			t.Errorf("validIdentifier(%q) = nil, want an error", bad)
		}
	}
	if err := validIdentifier("hookubit_test_internal_router"); err != nil {
		t.Errorf("validIdentifier rejected a name it produces itself: %v", err)
	}
}

// NAMEDATALEN is 63. A long path must hash rather than truncate, or two
// packages silently share one database - the exact failure this package exists
// to remove.
func TestDerivedNameStaysWithinNamedatalenWithoutColliding(t *testing.T) {
	template := "hookubit_test"
	long := strings.Repeat("verylongsegment_", 6)
	a := derivedName(template, long+"one")
	b := derivedName(template, long+"two")
	for _, n := range []string{a, b} {
		if len(n) > maxIdentifier {
			t.Fatalf("derived name %q is %d bytes, over NAMEDATALEN-1", n, len(n))
		}
		if err := validIdentifier(n); err != nil {
			t.Fatalf("derived name is not a usable identifier: %v", err)
		}
	}
	if a == b {
		t.Fatalf("two different packages collapsed onto database %q", a)
	}
	if got, want := derivedName(template, "internal_router"), "hookubit_test_internal_router"; got != want {
		t.Errorf("derivedName = %q, want %q", got, want)
	}
}

// The Prisma-only parameters are handled in exactly one place (db.NormaliseDSN);
// retargeting must not lose the operator's own parameters on the way through.
func TestWithDatabaseRetargetsAndKeepsOperatorParameters(t *testing.T) {
	got, err := withDatabase("postgresql://postgres:root@localhost:5432/hookubit_test?sslmode=disable&schema=public", "hookubit_test_internal_queue")
	if err != nil {
		t.Fatalf("withDatabase: %v", err)
	}
	if !strings.Contains(got, "/hookubit_test_internal_queue?") {
		t.Errorf("database was not retargeted: %s", got)
	}
	if !strings.Contains(got, "sslmode=disable") {
		t.Errorf("operator parameter lost: %s", got)
	}
	if strings.Contains(got, "schema=") || !strings.Contains(got, "search_path=public") {
		t.Errorf("NormaliseDSN was not applied: %s", got)
	}
}

func TestDatabaseNameReadsTheTemplateOutOfTheURL(t *testing.T) {
	got, err := databaseName("postgresql://postgres:root@localhost:5432/hookubit_test?sslmode=disable")
	if err != nil {
		t.Fatalf("databaseName: %v", err)
	}
	if got != "hookubit_test" {
		t.Errorf("databaseName = %q, want hookubit_test", got)
	}
	if _, err := databaseName("postgresql://postgres:root@localhost:5432/"); err == nil {
		t.Error("a URL naming no database was accepted; there is no template to copy")
	}
}

// Two concurrent test runs against one DATABASE_URL derive the same database
// names, so the second drops the first's database out from under it. A run ID
// separates them.
func TestRunIDSeparatesConcurrentRuns(t *testing.T) {
	const template = "hookubit_test"
	const suffix = "internal_failure"

	t.Setenv("TEST_DB_RUN_ID", "")
	shared := derivedName(template, suffixWithRunID(suffix))

	t.Setenv("TEST_DB_RUN_ID", "agent-a")
	a := derivedName(template, suffixWithRunID(suffix))

	t.Setenv("TEST_DB_RUN_ID", "agent-b")
	b := derivedName(template, suffixWithRunID(suffix))

	if a == b {
		t.Fatalf("two run IDs derived the same name %q; concurrent runs would still collide", a)
	}
	if a == shared || b == shared {
		t.Fatalf("a run ID did not change the name (%q, %q, unset=%q)", a, b, shared)
	}
	for _, name := range []string{shared, a, b} {
		if err := validIdentifier(name); err != nil {
			t.Fatalf("derived name %q is not a usable identifier: %v", name, err)
		}
	}
}

// A run ID is arbitrary text from an environment variable; it must not be able
// to produce an unusable or overlong identifier.
func TestRunIDIsSanitisedAndBounded(t *testing.T) {
	t.Setenv("TEST_DB_RUN_ID", `weird/id-"with' spaces;`)
	name := derivedName("hookubit_test", suffixWithRunID("internal_failure"))
	if err := validIdentifier(name); err != nil {
		t.Fatalf("hostile run ID produced %q: %v", name, err)
	}

	t.Setenv("TEST_DB_RUN_ID", strings.Repeat("x", 200))
	long := derivedName("hookubit_test", suffixWithRunID("internal_failure"))
	if len(long) > maxIdentifier {
		t.Fatalf("run ID overran NAMEDATALEN: %d chars", len(long))
	}
	if err := validIdentifier(long); err != nil {
		t.Fatalf("long run ID produced %q: %v", long, err)
	}
}

// Creating a per-package database must not evict a run that is already using
// one by that name.
//
// Two runs against one DATABASE_URL derive the same names, and DROP DATABASE
// ... WITH (FORCE) makes stealing one silent. The victim sees 3D000 plus
// "terminating connection due to administrator command"; the thief inherits the
// victim's rows, which is worse, because Claim and ClaimOutbox are deliberately
// GLOBAL queries with no tenant predicate - a scheduler test that asks for one
// delivery gets five, and reads as a broken LIMIT. Both symptoms have been
// misdiagnosed as flaky tests here.
func TestRefusesToDropADatabaseAnotherRunIsUsing(t *testing.T) {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}

	template, err := databaseName(raw)
	if err != nil {
		t.Fatalf("derive template name: %v", err)
	}
	name := derivedName(template, "testsupport_guard_probe")

	dsn, err := createFromTemplate(raw, template, name)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}

	// Stand in for the other run: one connection, idle, exactly as a pgxpool
	// holds them between queries.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("hold a connection on %s: %v", name, err)
	}
	defer func() { _ = conn.Close(context.Background()) }()

	_, err = createFromTemplate(raw, template, name)
	if err == nil {
		t.Fatal("a second run recreated the database while a connection was open on it; " +
			"the first run would have lost its database mid-test")
	}
	if !strings.Contains(err.Error(), "live connection") {
		t.Fatalf("error does not name the cause: %v", err)
	}
	if !strings.Contains(err.Error(), "TEST_DB_RUN_ID") {
		t.Fatalf("error does not name the remedy: %v", err)
	}
}
