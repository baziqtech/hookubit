package retention

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// These tests run the real retention SQL against a migrated database. They are
// the only place the partial-index predicates, the data-modifying CTEs and -
// most importantly - the status filter are actually verified, so they skip
// rather than fail when there is nothing to talk to, like every other
// PostgreSQL suite here.
//
// Both statements are GLOBAL: they carry no tenant predicate, because pruning a
// ledger means pruning it. "Which rows did this batch take?" is therefore only
// a well-posed question when the database holds nothing but this package's
// rows, which is what internal/testsupport arranges.

// The wiring in cmd/webhookd/roles.go passes the *pgxpool.Pool straight in, so
// the pool has to satisfy DB. Asserted at compile time HERE rather than
// discovered when that one line is added: this package cannot edit roles.go, and
// a handover that does not build is a handover that bounces.
var _ DB = (*pgxpool.Pool)(nil)

type ledger struct {
	pool       *pgxpool.Pool
	orgID      string
	projectID  string
	endpointID string
	eventID    string
}

func seedLedger(t *testing.T, pool *pgxpool.Pool) *ledger {
	t.Helper()

	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	l := &ledger{
		pool:       pool,
		orgID:      ids.New(ids.Organization),
		projectID:  ids.New(ids.Project),
		endpointID: ids.New(ids.Endpoint),
		eventID:    ids.New(ids.Event),
	}

	// Cleanup order is forced by the review-fixes migration: Delivery -> Event
	// and Delivery -> Endpoint are ON DELETE RESTRICT, so the ledger has to go
	// before anything it points at.
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM deliveries WHERE organization_id = $1`, l.orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE organization_id = $1`, l.orgID)
		_, _ = pool.Exec(ctx,
			`DELETE FROM endpoints WHERE project_id IN (SELECT id FROM projects WHERE organization_id = $1)`, l.orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, l.orgID)
	})

	mustExec(t, pool,
		`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
		 VALUES ($1, 'retention test', $2, 'active', now(), now())`,
		l.orgID, "retention-test-"+suffix)
	mustExec(t, pool,
		`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
		 VALUES ($1, $2, 'retention test', $3, 'test', 'active', now(), now())`,
		l.projectID, l.orgID, "retention-test-"+suffix)
	mustExec(t, pool,
		`INSERT INTO endpoints (id, project_id, name, url, status, enabled, created_at, updated_at)
		 VALUES ($1, $2, 'retention test', 'https://example.test/hook', 'active', true, now(), now())`,
		l.endpointID, l.projectID)
	mustExec(t, pool,
		`INSERT INTO events (id, organization_id, project_id, event_type, payload, payload_size,
		                     payload_hash, headers, status, created_at)
		 VALUES ($1, $2, $3, 'payment.settled', '{}'::jsonb, 2, 'sha256:test', '{}'::jsonb, 'received', now())`,
		l.eventID, l.orgID, l.projectID)

	return l
}

// addDelivery inserts one delivery aged `age` in the past, with `attempts`
// attempt rows hanging off it.
//
// Each delivery gets its OWN event. `deliveries_event_endpoint_original_key` is
// a partial unique index on (event_id, endpoint_id) WHERE replay_of_delivery_id
// IS NULL - the fan-out idempotency arbiter - so one endpoint may hold exactly
// one original delivery per event. A fixture that reused the event would be
// modelling a state the router cannot produce.
func (l *ledger) addDelivery(t *testing.T, status string, age time.Duration, attempts int) string {
	t.Helper()
	id := ids.New(ids.Delivery)
	eventID := ids.New(ids.Event)
	mustExec(t, l.pool,
		`INSERT INTO events (id, organization_id, project_id, event_type, payload, payload_size,
		                     payload_hash, headers, status, created_at)
		 VALUES ($1, $2, $3, 'payment.settled', '{}'::jsonb, 2, 'sha256:test', '{}'::jsonb, 'received', now())`,
		eventID, l.orgID, l.projectID)
	mustExec(t, l.pool,
		`INSERT INTO deliveries (id, event_id, endpoint_id, organization_id, project_id,
		                         status, attempt_count, max_attempts, next_attempt_at,
		                         created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6::text::"DeliveryStatus", $7, 8, now(),
		         now() - $8::interval, now())`,
		id, eventID, l.endpointID, l.orgID, l.projectID, status, attempts, intervalOf(age))
	for i := 1; i <= attempts; i++ {
		mustExec(t, l.pool,
			`INSERT INTO delivery_attempts (id, delivery_id, attempt_number, started_at, completed_at,
			                                status, http_status, created_at)
			 VALUES ($1, $2, $3, now(), now(), 'failure'::"AttemptStatus", 500, now())`,
			ids.New(ids.Attempt), id, i)
	}
	return id
}

func (l *ledger) deliveryExists(t *testing.T, id string) bool {
	t.Helper()
	var n int
	if err := l.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM deliveries WHERE id = $1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

func (l *ledger) attemptCount(t *testing.T, id string) int {
	t.Helper()
	var n int
	if err := l.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM delivery_attempts WHERE delivery_id = $1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (l *ledger) prunedAt(t *testing.T, id string) *time.Time {
	t.Helper()
	var at *time.Time
	if err := l.pool.QueryRow(context.Background(),
		`SELECT attempts_pruned_at FROM deliveries WHERE id = $1`, id).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec: %v\n%s", err, sql)
	}
}

func postgresConfig() Config {
	c := DefaultConfig()
	c.AttemptAge = 30 * 24 * time.Hour
	c.DeliveryAge = 90 * 24 * time.Hour
	c.BatchSize = 100
	c.MaxDeletesPerRun = 1000
	return c
}

// The two-horizon split, end to end: past the SHORT horizon the attempt detail
// goes and the summary row stays, so "did finance ever receive this?" is still
// answerable long after the response bodies have been reclaimed.
func TestPostgresShortHorizonTakesTheDetailAndKeepsTheSummary(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)

	old := l.addDelivery(t, "exhausted", 45*24*time.Hour, 3)

	s, err := New(pool, postgresConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.AttemptsDeleted != 3 || report.DeliveriesMarked != 1 {
		t.Fatalf("report = %+v, want 3 attempts deleted and 1 delivery marked", report)
	}
	if !l.deliveryExists(t, old) {
		t.Fatal("the summary row was deleted at the ATTEMPT horizon")
	}
	if n := l.attemptCount(t, old); n != 0 {
		t.Fatalf("%d attempt rows survived the attempt horizon", n)
	}
	if l.prunedAt(t, old) == nil {
		t.Fatal("attempts_pruned_at was not set, so every future pass will re-select this row")
	}
}

// The marker is what makes the sweep self-terminating. Without it the second
// pass re-selects the same rows, deletes nothing, and does so forever.
func TestPostgresASecondPassFindsNothingLeftToDo(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)
	l.addDelivery(t, "succeeded", 45*24*time.Hour, 2)

	s, err := New(pool, postgresConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	second, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !second.Empty() {
		t.Fatalf("the second pass did work: %+v", second)
	}
}

// The safety property this whole package hangs on. A delivery that is STILL
// BEING RETRIED must survive both sweeps regardless of its age - deleting it
// would lose an event the platform has already answered 202 for, with no ledger
// row left to explain the loss.
func TestPostgresANonTerminalDeliveryIsNeverPrunedHoweverOldItIs(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)

	live := map[string]string{}
	for _, status := range []string{"pending", "scheduled", "queued", "processing", "retrying"} {
		live[status] = l.addDelivery(t, status, 400*24*time.Hour, 2)
	}

	s, err := New(pool, postgresConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Empty() {
		t.Fatalf("a non-terminal delivery was pruned: %+v", report)
	}
	for status, id := range live {
		if !l.deliveryExists(t, id) {
			t.Fatalf("a %q delivery was deleted", status)
		}
		if n := l.attemptCount(t, id); n != 2 {
			t.Fatalf("a %q delivery lost attempt rows: %d left", status, n)
		}
	}
}

// Inside the horizon, nothing is touched. The boundary is the whole contract.
func TestPostgresDeliveriesInsideTheHorizonAreUntouched(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)

	recent := l.addDelivery(t, "succeeded", 3*24*time.Hour, 2)

	s, err := New(pool, postgresConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Empty() {
		t.Fatalf("a delivery inside the horizon was pruned: %+v", report)
	}
	if n := l.attemptCount(t, recent); n != 2 {
		t.Fatalf("attempt rows inside the horizon were deleted: %d left", n)
	}
}

// Past the LONG horizon the row itself goes, and its remaining attempts go with
// it by cascade rather than being left as orphans.
func TestPostgresLongHorizonDeletesTheRowAndCascadesItsAttempts(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)

	ancient := l.addDelivery(t, "failed", 200*24*time.Hour, 4)

	s, err := New(pool, postgresConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	// The DELIVERY sweep is driven directly rather than through RunOnce,
	// because the point is that it stands on its own: a row past the long
	// horizon must take its attempts with it whether or not the short sweep
	// reached it first. Going through RunOnce would let the attempt sweep
	// remove them and prove nothing about the cascade.
	deleted, truncated, err := s.pruneDeliveries(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 || truncated {
		t.Fatalf("deleted=%d truncated=%v, want one delivery deleted", deleted, truncated)
	}
	if l.deliveryExists(t, ancient) {
		t.Fatal("the delivery survived the long horizon")
	}
	if n := l.attemptCount(t, ancient); n != 0 {
		t.Fatalf("%d attempt rows were orphaned by the delete", n)
	}
}

// One statement may only touch BatchSize rows. This is the bound that keeps a
// retention pass from holding row locks long enough for live traffic to notice.
func TestPostgresBatchSizeBoundsOneStatement(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)

	for i := 0; i < 5; i++ {
		l.addDelivery(t, "succeeded", 45*24*time.Hour, 1)
	}

	cfg := postgresConfig()
	cfg.BatchSize = 2
	cfg.MaxDeletesPerRun = 2

	s, err := New(pool, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.DeliveriesMarked != 2 {
		t.Fatalf("marked %d, want exactly the 2-row ceiling", report.DeliveriesMarked)
	}
	if !report.Truncated {
		t.Fatal("the pass stopped on its ceiling and did not say so")
	}
	var unmarked int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM deliveries WHERE organization_id = $1 AND attempts_pruned_at IS NULL`,
		l.orgID).Scan(&unmarked); err != nil {
		t.Fatal(err)
	}
	if unmarked != 3 {
		t.Fatalf("%d deliveries left unpruned, want 3 - the rest must wait for the next pass", unmarked)
	}
}

// The candidate scans MUST be able to use the partial indexes from
// 20260909100000_delivery_retention. If the status test is ever parameterised
// the planner cannot prove the predicate implies the index's, silently rejects
// it, and every batch becomes a sequential scan of the largest table in the
// system - which no functional test would notice.
//
// enable_seqscan is turned off for the plan only: on a table of five rows a
// sequential scan is genuinely cheaper, so the question "would the planner
// CONSIDER this index" cannot be asked any other way.
func TestPostgresTheCandidateScansCanUseTheRetentionIndexes(t *testing.T) {
	pool := testsupport.Pool(t)
	l := seedLedger(t, pool)
	l.addDelivery(t, "succeeded", 45*24*time.Hour, 1)

	for _, tc := range []struct {
		name  string
		sql   string
		index string
	}{
		{"attempt sweep", pruneAttemptsSQL, "deliveries_attempt_pruning_idx"},
		{"delivery sweep", pruneDeliveriesSQL, "deliveries_retention_idx"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			// An explicit transaction, because SET LOCAL outside one is a
			// WARNING that pgx does not surface as an error - the setting would
			// silently not apply and the test would assert nothing. The
			// rollback also puts the setting back, so the pooled connection is
			// not handed to another test with sequential scans disabled.
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
				t.Fatal(err)
			}
			rows, err := tx.Query(ctx, "EXPLAIN "+tc.sql, intervalOf(30*24*time.Hour), 100)
			if err != nil {
				t.Fatalf("explain: %v", err)
			}
			defer rows.Close()
			var plan strings.Builder
			for rows.Next() {
				var line string
				if err := rows.Scan(&line); err != nil {
					t.Fatal(err)
				}
				fmt.Fprintln(&plan, line)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(plan.String(), tc.index) {
				t.Fatalf("the planner did not reach for %s. Plan:\n%s", tc.index, plan.String())
			}
		})
	}
}
