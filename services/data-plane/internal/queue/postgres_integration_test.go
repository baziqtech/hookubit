package queue

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
)

// These tests run the real claim, renew and release SQL against a migrated
// database. They are the only place column-name drift against Prisma's schema
// is caught, so they skip rather than fail when there is nothing to talk to -
// the same convention as internal/ingest.
func requirePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
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

type fixture struct {
	pool     *pgxpool.Pool
	orgID    string
	projects []string
	endpoint string
	eventID  string
}

// seed creates one organisation with n projects, an endpoint and an event.
// Deleting the organisation cascades to events; deliveries and endpoints are
// removed explicitly because Delivery -> Event/Endpoint is Restrict, not
// Cascade (the delivery ledger is deliberately hard to erase).
func seed(t *testing.T, pool *pgxpool.Pool, projects int) *fixture {
	t.Helper()
	ctx := context.Background()

	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{pool: pool, orgID: ids.New(ids.Organization), eventID: ids.New(ids.Event)}

	if _, err := pool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
		 VALUES ($1, 'queue test', $2, 'active', now(), now())`,
		f.orgID, "queue-test-"+suffix); err != nil {
		t.Fatalf("seed organization: %v", err)
	}

	for i := 0; i < projects; i++ {
		id := ids.New(ids.Project)
		if _, err := pool.Exec(ctx,
			`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
			 VALUES ($1, $2, 'queue test', $3, 'test', 'active', now(), now())`,
			id, f.orgID, "queue-test-"+suffix+"-"+id[len(id)-6:]); err != nil {
			t.Fatalf("seed project: %v", err)
		}
		f.projects = append(f.projects, id)
	}

	f.endpoint = ids.New(ids.Endpoint)
	if _, err := pool.Exec(ctx,
		`INSERT INTO endpoints (id, project_id, name, url, status, enabled, created_at, updated_at)
		 VALUES ($1, $2, 'queue test', 'https://example.com/hook', 'active', true, now(), now())`,
		f.endpoint, f.projects[0]); err != nil {
		t.Fatalf("seed endpoint: %v", err)
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO events (id, organization_id, project_id, event_type, payload_size, payload_hash, status, created_at)
		 VALUES ($1, $2, $3, 'queue.test', 2, repeat('0', 64), 'received', now())`,
		f.eventID, f.orgID, f.projects[0]); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM deliveries WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoints WHERE id = $1`, f.endpoint)
		_, _ = pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, f.orgID)
	})
	return f
}

// insertDelivery writes one delivery row in an arbitrary lease state.
func (f *fixture) insertDelivery(t *testing.T, projectID, status, lockedBy string, lockedUntil *time.Time, due time.Duration) string {
	t.Helper()
	id := ids.New(ids.Delivery)
	var by any
	if lockedBy != "" {
		by = lockedBy
	}
	var until any
	if lockedUntil != nil {
		until = *lockedUntil
	}
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO deliveries
		   (id, event_id, endpoint_id, organization_id, project_id, status,
		    attempt_count, max_attempts, next_attempt_at, locked_by, locked_until,
		    created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6::"DeliveryStatus", 0, 5, now() + $7::interval, $8, $9, now(), now())`,
		id, f.newEvent(t, projectID), f.endpoint, f.orgID, projectID, status,
		intervalOf(due), by, until); err != nil {
		t.Fatalf("insert delivery: %v", err)
	}
	return id
}

// newEvent mints a fresh event per delivery.
//
// The fixture used to share one event across every delivery it created, which
// the in-memory fake accepted and PostgreSQL does not: deliveries_event_endpoint
// _original_key is UNIQUE on (event_id, endpoint_id) WHERE replay_of_delivery_id
// IS NULL, so a second original delivery for the same pair is a 23505. That
// index is the router's ON CONFLICT arbiter and the reason a re-run cannot
// double-fan-out, so the constraint is right and the old fixture was modelling
// a row production cannot produce.
func (f *fixture) newEvent(t *testing.T, projectID string) string {
	t.Helper()
	id := ids.New(ids.Event)
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO events (id, organization_id, project_id, event_type, payload_size, payload_hash, status, created_at)
		 VALUES ($1, $2, $3, 'queue.test', 2, repeat('0', 64), 'received', now())`,
		id, f.orgID, projectID); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return id
}

func (f *fixture) status(t *testing.T, id string) (status, lockedBy string) {
	t.Helper()
	var by *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status::text, locked_by FROM deliveries WHERE id = $1`, id).Scan(&status, &by); err != nil {
		t.Fatalf("read delivery %s: %v", id, err)
	}
	if by != nil {
		lockedBy = *by
	}
	return status, lockedBy
}

func contains(leases []Lease, id string) bool {
	for _, l := range leases {
		if l.Job.DeliveryID == id {
			return true
		}
	}
	return false
}

// THE regression test for the reclaim hole. A row abandoned by a dead worker is
// 'processing' with an expired lease. Before the fix the claim predicate did
// not list 'processing', so this row was invisible to every worker forever and
// only the scheduler's sweep could rescue it - which is not an availability
// story when the scheduler is a separate deployment that can be down.
func TestClaimReclaimsExpiredLeasesWithoutTheScheduler(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, 1)
	ctx := context.Background()

	expired := time.Now().Add(-time.Minute)
	live := time.Now().Add(10 * time.Minute)

	abandoned := f.insertDelivery(t, f.projects[0], "processing", "wrk_dead", &expired, -time.Minute)
	inFlight := f.insertDelivery(t, f.projects[0], "processing", "wrk_alive", &live, -time.Minute)
	fresh := f.insertDelivery(t, f.projects[0], "pending", "", nil, -time.Minute)
	future := f.insertDelivery(t, f.projects[0], "pending", "", nil, time.Hour)

	q := NewPostgresQueue(pool, StrategyFIFO)
	leases, err := q.Claim(ctx, "wrk_new", 10, time.Minute)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}

	if !contains(leases, abandoned) {
		t.Error("a delivery abandoned by a dead worker was NOT reclaimed by Claim; " +
			"with no scheduler running it would sit in 'processing' forever, never retried and never exhausted")
	}
	if !contains(leases, fresh) {
		t.Error("an ordinary due delivery was not claimed")
	}
	if contains(leases, inFlight) {
		t.Error("Claim stole a LIVE lease from another worker; the locked_until guard is not doing its job")
	}
	if contains(leases, future) {
		t.Error("Claim took a delivery that is not due yet")
	}

	if _, by := f.status(t, inFlight); by != "wrk_alive" {
		t.Errorf("live lease owner changed to %q", by)
	}
	for _, l := range leases {
		if l.HeadOfLineDelay < 0 {
			t.Errorf("negative head-of-line delay %s", l.HeadOfLineDelay)
		}
	}
}

// The duplicate-delivery race. Worker A holds a lease, loses it, and must be
// able to find that out - Renew used to discard RowsAffected and return nil
// whether it had renewed N rows or none.
func TestRenewReportsStolenLeasesAndReleaseSaysSo(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, 1)
	ctx := context.Background()

	q := NewPostgresQueue(pool, StrategyFIFO)
	mine := f.insertDelivery(t, f.projects[0], "pending", "", nil, -time.Minute)
	stolen := f.insertDelivery(t, f.projects[0], "pending", "", nil, -time.Minute)

	leases, err := q.Claim(ctx, "wrk_a", 10, time.Minute)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if len(leases) != 2 {
		t.Fatalf("claimed %d deliveries, want 2", len(leases))
	}

	// Simulate the failover: A's renewal misses, the lease lapses, and B claims.
	if _, err := pool.Exec(ctx,
		`UPDATE deliveries SET locked_by = 'wrk_b', locked_until = now() + interval '1 minute' WHERE id = $1`,
		stolen); err != nil {
		t.Fatalf("simulate steal: %v", err)
	}

	lost, err := q.Renew(ctx, "wrk_a", []string{mine, stolen}, time.Minute)
	if err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if len(lost) != 1 || lost[0] != stolen {
		t.Fatalf("Renew reported lost = %v, want exactly [%s]; without this the worker "+
			"writes a second delivery_attempts row and races the new owner over the terminal status", lost, stolen)
	}

	// Releasing a lease we no longer hold must say so, and must not clobber the
	// new owner's claim.
	err = q.Release(ctx, "wrk_a", stolen)
	if !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Release of a stolen lease returned %v, want ErrLeaseLost", err)
	}
	if status, by := f.status(t, stolen); by != "wrk_b" || status != "processing" {
		t.Fatalf("stolen delivery is now status=%s locked_by=%s; the previous owner clobbered the new one", status, by)
	}

	// Releasing one we do hold succeeds and puts it back in the ready set.
	if err := q.Release(ctx, "wrk_a", mine); err != nil {
		t.Fatalf("Release of a held lease: %v", err)
	}
	if status, by := f.status(t, mine); status != "pending" || by != "" {
		t.Fatalf("released delivery is status=%s locked_by=%s, want pending with no owner", status, by)
	}
}

// ADR-0007's core promise, exercised against the real lateral statement: a
// burst in one project must not fill the batch and lock out a neighbour.
func TestTenantFairClaimDoesNotLetOneProjectMonopoliseTheBatch(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, 2)
	ctx := context.Background()

	noisy, quiet := f.projects[0], f.projects[1]
	for i := 0; i < 60; i++ {
		f.insertDelivery(t, noisy, "pending", "", nil, -time.Hour)
	}
	// The quiet tenant's single delivery is NEWER, so FIFO would put it behind
	// all sixty.
	quietDelivery := f.insertDelivery(t, quiet, "pending", "", nil, -time.Second)

	q := NewPostgresQueue(pool, StrategyTenantFair)
	leases, err := q.Claim(ctx, "wrk_a", 10, time.Minute)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if !contains(leases, quietDelivery) {
		t.Fatalf("the quiet tenant's delivery was not claimed in a batch of %d; "+
			"it is parked behind the noisy tenant's burst, which is the starvation ADR-0007 exists to prevent", len(leases))
	}

	var fromNoisy int
	for _, l := range leases {
		if l.Job.ProjectID == noisy {
			fromNoisy++
		}
	}
	if fromNoisy > perTenantCap(10, 2) {
		t.Fatalf("the noisy tenant took %d of 10 slots, above the derived cap of %d", fromNoisy, perTenantCap(10, 2))
	}
}

// With one active tenant the fair strategy must behave exactly like FIFO - a
// lone tenant throttled by its own fairness mechanism is the obvious way to get
// this wrong (ADR-0007).
func TestTenantFairClaimIsNotSelfThrottlingWithOneTenant(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, 1)
	ctx := context.Background()

	for i := 0; i < 40; i++ {
		f.insertDelivery(t, f.projects[0], "pending", "", nil, -time.Minute)
	}

	q := NewPostgresQueue(pool, StrategyTenantFair)
	leases, err := q.Claim(ctx, "wrk_a", 25, time.Minute)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if len(leases) != 25 {
		t.Fatalf("claimed %d of a possible 25 with a single active tenant; "+
			"the cap must be derived (K=1 => cap=limit), never constant", len(leases))
	}
}

// TestTerminalDeliveriesAreNeverClaimed is the safety proof behind the choice
// internal/worker's advanceSQL makes: a terminal delivery now keeps a non-NULL
// next_attempt_at (now()) instead of writing NULL, so that the column can
// become NOT NULL and a stray NULL can no longer jump the `NULLS FIRST`
// ordering.
//
// The obvious worry about that choice is "does a succeeded delivery with a
// next_attempt_at in the past get delivered a second time?". It cannot: status
// decides claimability, and none of the terminal states is in claimStatuses.
// These rows are seeded an hour overdue - the most claimable a timestamp can
// make a row - under both strategies.
func TestTerminalDeliveriesAreNeverClaimed(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, 1)
	ctx := context.Background()

	terminal := map[string]string{}
	for _, status := range []string{"succeeded", "failed", "exhausted", "cancelled"} {
		terminal[status] = f.insertDelivery(t, f.projects[0], status, "", nil, -time.Hour)
	}
	// One genuinely due row, so a claim of zero cannot pass this test by
	// accident (a broken predicate, an empty table, a bad fixture).
	due := f.insertDelivery(t, f.projects[0], "pending", "", nil, -time.Minute)

	for _, strategy := range []Strategy{StrategyFIFO, StrategyTenantFair} {
		q := NewPostgresQueue(pool, strategy)
		leases, err := q.Claim(ctx, "wrk_"+string(strategy), 50, time.Minute)
		if err != nil {
			t.Fatalf("Claim (%s): %v", strategy, err)
		}
		for status, id := range terminal {
			if contains(leases, id) {
				t.Fatalf("%s claimed a %s delivery; a completed webhook would be re-sent to the customer",
					strategy, status)
			}
		}
		if strategy == StrategyFIFO && !contains(leases, due) {
			t.Fatal("the due delivery was not claimed, so this test proves nothing about the terminal rows")
		}
		// Put it back for the next strategy.
		if _, err := pool.Exec(ctx,
			`UPDATE deliveries SET status = 'pending', locked_by = NULL, locked_until = NULL WHERE id = $1`,
			due); err != nil {
			t.Fatalf("reset due delivery: %v", err)
		}
	}
}
