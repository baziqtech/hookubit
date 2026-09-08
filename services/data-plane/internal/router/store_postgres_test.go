package router

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
)

// These tests run the real fan-out SQL against a migrated database. They are
// the only place the ON CONFLICT arbiter, the partial unique index and the
// atomicity of the route transaction are actually verified, so they skip rather
// than fail when there is nothing to talk to - the same convention as
// internal/ingest and internal/queue.
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
	pool      *pgxpool.Pool
	orgID     string
	projectID string
	eventID   string
	outboxID  string
}

// seed creates one organisation, one project, one event and its outbox row -
// exactly the state ingest leaves behind after a 202.
//
// Cleanup order is forced by the review-fixes migration: Delivery -> Event and
// Delivery -> Endpoint are ON DELETE RESTRICT, so the delivery ledger has to be
// removed explicitly before anything it points at. That restriction is the
// point of the migration; it is not an inconvenience to work around.
func seed(t *testing.T, pool *pgxpool.Pool, eventType string) *fixture {
	t.Helper()

	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	// ClaimOutbox is a GLOBAL claim: it orders by (available_at, created_at) and
	// takes a LIMIT, with no tenant predicate - correctly, since the router
	// drains the whole queue. That makes every test in this package
	// order-dependent on a shared database: a pending outbox row left by
	// ANOTHER package sorts ahead of this fixture's row and consumes the batch,
	// so RunOnce silently never reaches the row under test.
	//
	// Observed as TestPostgresRerunningAPartiallyAppliedBatchIsANoOp failing
	// only when the router package ran after the worker package - and passing
	// in isolation, which made it look like flakiness twice. It is not
	// flakiness; it is a global query meeting shared state.
	if _, err := pool.Exec(context.Background(), `DELETE FROM event_outbox`); err != nil {
		t.Fatalf("clear outbox before seeding: %v", err)
	}

	f := &fixture{
		pool:      pool,
		orgID:     ids.New(ids.Organization),
		projectID: ids.New(ids.Project),
		eventID:   ids.New(ids.Event),
		outboxID:  ids.New(ids.Outbox),
	}

	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM deliveries WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(ctx,
			`DELETE FROM endpoints WHERE project_id IN (SELECT id FROM projects WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, f.orgID)
	})

	mustExec(t, pool,
		`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
		 VALUES ($1, 'router test', $2, 'active', now(), now())`,
		f.orgID, "router-test-"+suffix)

	mustExec(t, pool,
		`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
		 VALUES ($1, $2, 'router test', $3, 'test', 'active', now(), now())`,
		f.projectID, f.orgID, "router-test-"+suffix)

	mustExec(t, pool,
		`INSERT INTO events (id, organization_id, project_id, event_type, payload, payload_size,
		                     payload_hash, headers, status, created_at)
		 VALUES ($1, $2, $3, $4, '{}'::jsonb, 2, 'sha256:test', '{}'::jsonb, 'received', now())`,
		f.eventID, f.orgID, f.projectID, eventType)

	mustExec(t, pool,
		`INSERT INTO event_outbox (id, event_id, type, status, attempts, available_at, created_at)
		 VALUES ($1, $2, 'event.created', 'pending', 0, now(), now())`,
		f.outboxID, f.eventID)

	return f
}

// addEndpoint creates an endpoint and a subscription bound to it, in the
// fixture's project. retryPolicyMaxAttempts of 0 attaches no policy.
func (f *fixture) addEndpoint(t *testing.T, eventTypes []string, opts endpointOpts) (endpointID, subscriptionID string) {
	t.Helper()
	endpointID = ids.New(ids.Endpoint)
	subscriptionID = ids.New(ids.Subscription)

	status := opts.status
	if status == "" {
		status = "active"
	}
	projectID := opts.projectID
	if projectID == "" {
		projectID = f.projectID
	}

	var policyID any
	if opts.maxAttempts > 0 {
		id := ids.New(ids.RetryPolicy)
		mustExec(t, f.pool,
			`INSERT INTO retry_policies (id, project_id, name, is_default, strategy, max_attempts,
			                             initial_delay_ms, max_delay_ms, multiplier, jitter_ratio,
			                             max_retry_duration_ms, created_at, updated_at)
			 VALUES ($1, $2, 'endpoint policy', false, 'exponential', $3,
			         5000, 3600000, 2.0, 0.2, 86400000, now(), now())`,
			id, projectID, opts.maxAttempts)
		policyID = id
	}

	mustExec(t, f.pool,
		`INSERT INTO endpoints (id, project_id, name, url, status, enabled, retry_policy_id, created_at, updated_at)
		 VALUES ($1, $2, 'router test', 'https://example.invalid/hook', $3::text::"EndpointStatus", $4, $5, now(), now())`,
		endpointID, projectID, status, !opts.endpointDisabled, policyID)

	mustExec(t, f.pool,
		`INSERT INTO webhook_subscriptions (id, project_id, endpoint_id, event_types, enabled, created_at, updated_at)
		 VALUES ($1, $2, $3, $4::text[], $5, now(), now())`,
		subscriptionID, projectID, endpointID, eventTypes, !opts.subscriptionDisabled)

	return endpointID, subscriptionID
}

type endpointOpts struct {
	status               string
	endpointDisabled     bool
	subscriptionDisabled bool
	maxAttempts          int
	projectID            string
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %.60q: %v", sql, err)
	}
}

type deliveryRow struct {
	ID             string
	EndpointID     string
	SubscriptionID *string
	OrganizationID string
	ProjectID      string
	Status         string
	MaxAttempts    int
	AttemptCount   int
	NextAttemptAt  *time.Time
	OrderingKey    *string
}

func loadDeliveries(t *testing.T, pool *pgxpool.Pool, eventID string) []deliveryRow {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id, endpoint_id, subscription_id, organization_id, project_id, status::text,
		        max_attempts, attempt_count, next_attempt_at, ordering_key
		 FROM deliveries WHERE event_id = $1 ORDER BY id`, eventID)
	if err != nil {
		t.Fatalf("load deliveries: %v", err)
	}
	defer rows.Close()

	var out []deliveryRow
	for rows.Next() {
		var d deliveryRow
		if err := rows.Scan(&d.ID, &d.EndpointID, &d.SubscriptionID, &d.OrganizationID, &d.ProjectID,
			&d.Status, &d.MaxAttempts, &d.AttemptCount, &d.NextAttemptAt, &d.OrderingKey); err != nil {
			t.Fatalf("scan delivery: %v", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate deliveries: %v", err)
	}
	return out
}

func outboxState(t *testing.T, pool *pgxpool.Pool, outboxID string) (status string, attempts int, lockedBy *string, processedAt *time.Time) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT status::text, attempts, locked_by, processed_at FROM event_outbox WHERE id = $1`, outboxID).
		Scan(&status, &attempts, &lockedBy, &processedAt)
	if err != nil {
		t.Fatalf("read outbox row: %v", err)
	}
	return
}

func eventStatus(t *testing.T, pool *pgxpool.Pool, eventID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status::text FROM events WHERE id = $1`, eventID).Scan(&status); err != nil {
		t.Fatalf("read event: %v", err)
	}
	return status
}

func newIntegrationRouter(t *testing.T, pool *pgxpool.Pool, routerID string) *Router {
	t.Helper()
	r, err := New(Options{
		Store:                    NewPostgresStore(pool),
		RouterID:                 routerID,
		Logger:                   quietLogger(),
		BatchSize:                50,
		Concurrency:              4,
		Lease:                    30 * time.Second,
		MaxSubscriptionsPerEvent: 100,
		MaxOutboxAttempts:        3,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

// ---------------------------------------------------------------------------

func TestPostgresRouteMaterialisesFanOut(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")
	mustExec(t, pool, `UPDATE events SET ordering_key = 'customer_123' WHERE id = $1`, f.eventID)

	epA, subA := f.addEndpoint(t, []string{"payment.settled"}, endpointOpts{maxAttempts: 3})
	epB, _ := f.addEndpoint(t, []string{"payment.*"}, endpointOpts{})
	// Filtered out: a subscription that selects a different type must not
	// receive this event. Silently widening a filter is the Convoy data-leak
	// bug this platform exists to avoid.
	f.addEndpoint(t, []string{"order.created"}, endpointOpts{})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	deliveries := loadDeliveries(t, pool, f.eventID)
	if len(deliveries) != 2 {
		t.Fatalf("created %d deliveries, want 2", len(deliveries))
	}

	byEndpoint := map[string]deliveryRow{}
	for _, d := range deliveries {
		byEndpoint[d.EndpointID] = d
	}
	for _, ep := range []string{epA, epB} {
		if _, ok := byEndpoint[ep]; !ok {
			t.Fatalf("endpoint %s did not get a delivery", ep)
		}
	}

	a := byEndpoint[epA]
	if a.OrganizationID != f.orgID || a.ProjectID != f.projectID {
		t.Fatalf("tenant columns not copied from the event: org=%s project=%s", a.OrganizationID, a.ProjectID)
	}
	if a.SubscriptionID == nil || *a.SubscriptionID != subA {
		t.Fatalf("subscription_id = %v, want %s", a.SubscriptionID, subA)
	}
	if a.Status != "pending" || a.AttemptCount != 0 {
		t.Fatalf("delivery starts at status=%s attempt_count=%d, want pending/0", a.Status, a.AttemptCount)
	}
	if a.MaxAttempts != 3 {
		t.Fatalf("max_attempts = %d, want the endpoint's own retry policy (3)", a.MaxAttempts)
	}
	if b := byEndpoint[epB]; b.MaxAttempts != retry.DefaultPolicy().MaxAttempts {
		t.Fatalf("max_attempts = %d with no policy, want the built-in default %d",
			b.MaxAttempts, retry.DefaultPolicy().MaxAttempts)
	}
	// next_attempt_at MUST be set. The claim query orders by
	// `next_attempt_at NULLS FIRST`, so a NULL here sorts every brand-new
	// delivery ahead of every due retry and starves retries under sustained
	// ingest.
	for _, d := range deliveries {
		if d.NextAttemptAt == nil {
			t.Fatalf("delivery %s has a NULL next_attempt_at; it would sort ahead of every due retry", d.ID)
		}
		if d.OrderingKey == nil || *d.OrderingKey != "customer_123" {
			t.Fatalf("ordering_key = %v, want customer_123", d.OrderingKey)
		}
	}

	status, attempts, lockedBy, processedAt := outboxState(t, pool, f.outboxID)
	if status != "processed" || processedAt == nil {
		t.Fatalf("outbox row = %s processed_at=%v, want processed", status, processedAt)
	}
	if attempts != 1 {
		t.Fatalf("outbox attempts = %d, want 1 (incremented by the claim)", attempts)
	}
	if lockedBy != nil {
		t.Fatalf("outbox row is still locked by %v after completing", *lockedBy)
	}
	if got := eventStatus(t, pool, f.eventID); got != "processed" {
		t.Fatalf("event status = %s, want processed", got)
	}
}

// TestPostgresRouteFallsBackToTheProjectDefaultRetryPolicy covers the middle
// rung of the attempt-budget ladder: endpoint policy, then project default,
// then the built-in. Getting it wrong stamps the wrong retry contract onto
// every delivery, and the row records the contract it was created under.
func TestPostgresRouteFallsBackToTheProjectDefaultRetryPolicy(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")

	// A project default policy, attached to no endpoint.
	mustExec(t, pool,
		`INSERT INTO retry_policies (id, project_id, name, is_default, strategy, max_attempts,
		                             initial_delay_ms, max_delay_ms, multiplier, jitter_ratio,
		                             max_retry_duration_ms, created_at, updated_at)
		 VALUES ($1, $2, 'project default', true, 'exponential', 11,
		         5000, 3600000, 2.0, 0.2, 86400000, now(), now())`,
		ids.New(ids.RetryPolicy), f.projectID)

	withOwn, _ := f.addEndpoint(t, []string{"*"}, endpointOpts{maxAttempts: 3})
	f.addEndpoint(t, []string{"*"}, endpointOpts{})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	deliveries := loadDeliveries(t, pool, f.eventID)
	if len(deliveries) != 2 {
		t.Fatalf("created %d deliveries, want 2", len(deliveries))
	}
	for _, d := range deliveries {
		want := 11 // the project default
		if d.EndpointID == withOwn {
			want = 3 // the endpoint's own policy wins
		}
		if d.MaxAttempts != want {
			t.Fatalf("endpoint %s max_attempts = %d, want %d", d.EndpointID, d.MaxAttempts, want)
		}
	}
}

func TestPostgresRouteReadsOrderingKeyFromHeadersFallback(t *testing.T) {
	// Ingest currently stores ordering_key in events.headers; the dedicated
	// column landed later. The router must keep working whichever side moves
	// first.
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")
	mustExec(t, pool, `UPDATE events SET headers = '{"ordering_key":"from_headers"}'::jsonb WHERE id = $1`, f.eventID)
	f.addEndpoint(t, []string{"*"}, endpointOpts{})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	deliveries := loadDeliveries(t, pool, f.eventID)
	if len(deliveries) != 1 {
		t.Fatalf("created %d deliveries, want 1", len(deliveries))
	}
	if deliveries[0].OrderingKey == nil || *deliveries[0].OrderingKey != "from_headers" {
		t.Fatalf("ordering_key = %v, want from_headers", deliveries[0].OrderingKey)
	}
}

// TestPostgresRerunningAPartiallyAppliedBatchIsANoOp is the single most
// important test in this package.
//
// It simulates the crash the partial unique index exists for: the fan-out
// committed, the outbox row was put back on the queue (by a reclaim, a manual
// replay, an operator), and the router runs it again. The second run must
// insert NOTHING. If it inserts, every subscriber receives the event twice.
func TestPostgresRerunningAPartiallyAppliedBatchIsANoOp(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")
	f.addEndpoint(t, []string{"*"}, endpointOpts{})
	f.addEndpoint(t, []string{"payment.settled"}, endpointOpts{})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("first RunOnce: %v", err)
	}
	first := loadDeliveries(t, pool, f.eventID)
	if len(first) != 2 {
		t.Fatalf("first run created %d deliveries, want 2", len(first))
	}

	// Put the row back exactly as a lease reclaim would.
	mustExec(t, pool,
		`UPDATE event_outbox SET status = 'pending', processed_at = NULL,
		        locked_by = NULL, locked_until = NULL, available_at = now()
		 WHERE id = $1`, f.outboxID)

	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}

	second := loadDeliveries(t, pool, f.eventID)
	if len(second) != len(first) {
		t.Fatalf("re-run created duplicates: %d deliveries, want %d", len(second), len(first))
	}
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatalf("delivery ids changed on re-run: %s -> %s", first[i].ID, second[i].ID)
		}
	}
	if status, attempts, _, _ := outboxState(t, pool, f.outboxID); status != "processed" || attempts != 2 {
		t.Fatalf("outbox row after re-run: status=%s attempts=%d, want processed/2", status, attempts)
	}
}

// TestPostgresPartialIndexArbitratesButPermitsReplay proves both halves of the
// arbiter: an original delivery for a pair may exist only once, and a replay -
// which carries replay_of_delivery_id - is deliberately outside the index and
// therefore allowed.
func TestPostgresPartialIndexArbitratesButPermitsReplay(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	endpointID, _ := f.addEndpoint(t, []string{"*"}, endpointOpts{})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	original := loadDeliveries(t, pool, f.eventID)
	if len(original) != 1 {
		t.Fatalf("created %d deliveries, want 1", len(original))
	}

	// A second ORIGINAL row for the same pair must be refused by the index.
	_, err := pool.Exec(ctx,
		`INSERT INTO deliveries (id, event_id, endpoint_id, organization_id, project_id, status,
		                         attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'pending', 0, 8, now(), now(), now())`,
		ids.New(ids.Delivery), f.eventID, endpointID, f.orgID, f.projectID)
	if err == nil {
		t.Fatal("a second original delivery for (event, endpoint) was accepted; the arbiter index is not doing its job")
	}
	var pgErr interface{ SQLState() string }
	if !errors.As(err, &pgErr) || pgErr.SQLState() != "23505" {
		t.Fatalf("want a unique violation (23505), got %v", err)
	}

	// A REPLAY row for the same pair must be accepted: that is why the index is
	// partial.
	replayID := ids.New(ids.Delivery)
	mustExec(t, pool,
		`INSERT INTO deliveries (id, event_id, endpoint_id, organization_id, project_id, status,
		                         attempt_count, max_attempts, next_attempt_at, replay_of_delivery_id,
		                         created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'pending', 0, 8, now(), $6, now(), now())`,
		replayID, f.eventID, endpointID, f.orgID, f.projectID, original[0].ID)

	if got := loadDeliveries(t, pool, f.eventID); len(got) != 2 {
		t.Fatalf("after replay there are %d rows, want 2 (one original, one replay)", len(got))
	}

	// And the router re-running must still not add a third: the replay row is
	// invisible to the arbiter, but the original still conflicts.
	mustExec(t, pool,
		`UPDATE event_outbox SET status = 'pending', processed_at = NULL, locked_by = NULL,
		        locked_until = NULL, available_at = now() WHERE id = $1`, f.outboxID)
	if _, err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce after replay: %v", err)
	}
	if got := loadDeliveries(t, pool, f.eventID); len(got) != 2 {
		t.Fatalf("re-run after a replay created %d rows, want 2", len(got))
	}
}

// TestPostgresRouteRollsBackEverythingWhenTheLeaseIsLost is the atomicity test.
// If another router took the row, the deliveries this transaction wrote must
// not survive - otherwise both routers materialise the same fan-out and the
// created counts stop meaning anything.
func TestPostgresRouteRollsBackEverythingWhenTheLeaseIsLost(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	f.addEndpoint(t, []string{"*"}, endpointOpts{})

	store := NewPostgresStore(pool)
	claimed, err := store.ClaimOutbox(ctx, "rtr_a", 10, 30*time.Second)
	if err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}
	if len(claimed) != 1 {
		t.Fatalf("claimed %d rows, want 1", len(claimed))
	}

	// Another router steals the row while rtr_a is mid-flight.
	mustExec(t, pool, `UPDATE event_outbox SET locked_by = 'rtr_b' WHERE id = $1`, f.outboxID)

	res, err := store.Route(ctx, RouteRequest{RouterID: "rtr_a", Row: claimed[0], FanOutCap: 100})
	if err != nil {
		t.Fatalf("Route: %v", err)
	}
	if res.Outcome != OutcomeLeaseLost {
		t.Fatalf("outcome = %s, want %s", res.Outcome, OutcomeLeaseLost)
	}
	if got := loadDeliveries(t, pool, f.eventID); len(got) != 0 {
		t.Fatalf("%d deliveries survived a rolled-back transaction; the fan-out is not atomic", len(got))
	}
	if got := eventStatus(t, pool, f.eventID); got == "processed" {
		t.Fatal("the event was marked processed by a transaction that rolled back")
	}
}

func TestPostgresRouteSkipsIneligibleSubscriptions(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")

	wanted, _ := f.addEndpoint(t, []string{"*"}, endpointOpts{})
	f.addEndpoint(t, []string{"*"}, endpointOpts{subscriptionDisabled: true})
	f.addEndpoint(t, []string{"*"}, endpointOpts{endpointDisabled: true}) // circuit-breaker auto-disable
	f.addEndpoint(t, []string{"*"}, endpointOpts{status: "deleted"})      // soft-deleted endpoint
	f.addEndpoint(t, []string{"*"}, endpointOpts{status: "paused"})       // paused endpoint

	// A subscription in a DIFFERENT project of the same organisation. The
	// router scopes its subscription query to the event's project, so this must
	// never be considered - tenant isolation at the project level.
	otherProject := ids.New(ids.Project)
	mustExec(t, pool,
		`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
		 VALUES ($1, $2, 'other project', $3, 'test', 'active', now(), now())`,
		otherProject, f.orgID, "router-other-"+otherProject[len(otherProject)-8:])
	f.addEndpoint(t, []string{"*"}, endpointOpts{projectID: otherProject})

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	deliveries := loadDeliveries(t, pool, f.eventID)
	if len(deliveries) != 1 {
		t.Fatalf("created %d deliveries, want 1 (only the healthy endpoint)", len(deliveries))
	}
	if deliveries[0].EndpointID != wanted {
		t.Fatalf("delivered to %s, want %s", deliveries[0].EndpointID, wanted)
	}
	if got := eventStatus(t, pool, f.eventID); got != "processed" {
		t.Fatalf("event status = %s, want processed", got)
	}
}

// TestPostgresRouteSkipsSoftDeletedTenants covers the case the endpoint-level
// tests cannot: the event's OWN project or organisation has been soft-deleted
// between acceptance and routing. Nothing may be delivered, and the outbox row
// must still leave the queue rather than being retried until it poisons.
func TestPostgresRouteSkipsSoftDeletedTenants(t *testing.T) {
	for _, tc := range []struct {
		name  string
		spoil func(*testing.T, *pgxpool.Pool, *fixture)
	}{
		{"soft-deleted project", func(t *testing.T, pool *pgxpool.Pool, f *fixture) {
			mustExec(t, pool, `UPDATE projects SET status = 'deleted' WHERE id = $1`, f.projectID)
		}},
		{"suspended project", func(t *testing.T, pool *pgxpool.Pool, f *fixture) {
			mustExec(t, pool, `UPDATE projects SET status = 'suspended' WHERE id = $1`, f.projectID)
		}},
		{"soft-deleted organization", func(t *testing.T, pool *pgxpool.Pool, f *fixture) {
			mustExec(t, pool, `UPDATE organizations SET status = 'deleted' WHERE id = $1`, f.orgID)
		}},
		{"suspended organization", func(t *testing.T, pool *pgxpool.Pool, f *fixture) {
			mustExec(t, pool, `UPDATE organizations SET status = 'suspended' WHERE id = $1`, f.orgID)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := requirePool(t)
			f := seed(t, pool, "payment.settled")
			f.addEndpoint(t, []string{"*"}, endpointOpts{})
			tc.spoil(t, pool, f)

			r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
			if _, err := r.RunOnce(context.Background()); err != nil {
				t.Fatalf("RunOnce: %v", err)
			}

			if got := loadDeliveries(t, pool, f.eventID); len(got) != 0 {
				t.Fatalf("created %d deliveries for a soft-deleted tenant, want none", len(got))
			}
			if status, _, _, _ := outboxState(t, pool, f.outboxID); status != "processed" {
				t.Fatalf("outbox status = %s, want processed; the row must not sit pending forever", status)
			}
		})
	}
}

func TestPostgresRouteWithNoSubscriptionsStillProcessesTheEvent(t *testing.T) {
	pool := requirePool(t)
	f := seed(t, pool, "payment.settled")

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if got := loadDeliveries(t, pool, f.eventID); len(got) != 0 {
		t.Fatalf("created %d deliveries, want none", len(got))
	}
	status, _, _, processedAt := outboxState(t, pool, f.outboxID)
	if status != "processed" || processedAt == nil {
		t.Fatalf("outbox row = %s; an unmatched event must leave the queue, not sit pending forever", status)
	}
	if got := eventStatus(t, pool, f.eventID); got != "processed" {
		t.Fatalf("event status = %s, want processed", got)
	}
}

func TestPostgresRouteReportsAMissingEvent(t *testing.T) {
	// event_outbox -> events is ON DELETE CASCADE, so a genuine orphan cannot
	// be created without disabling the constraint. Route is asked about an
	// event id that does not exist, which exercises exactly the branch a
	// retention job bypassing the FK would hit.
	pool := requirePool(t)
	store := NewPostgresStore(pool)

	res, err := store.Route(context.Background(), RouteRequest{
		RouterID:  "rtr_a",
		Row:       OutboxRow{ID: ids.New(ids.Outbox), EventID: ids.New(ids.Event), Type: OutboxTypeEventCreated, Attempts: 1},
		FanOutCap: 10,
	})
	if err != nil {
		t.Fatalf("Route: %v", err)
	}
	if res.Outcome != OutcomeEventMissing {
		t.Fatalf("outcome = %s, want %s", res.Outcome, OutcomeEventMissing)
	}
}

func TestPostgresClaimRespectsLivesLeasesAndReclaimsExpiredOnes(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	store := NewPostgresStore(pool)

	claimed, err := store.ClaimOutbox(ctx, "rtr_a", 10, time.Hour)
	if err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}
	if len(claimed) != 1 || claimed[0].Attempts != 1 {
		t.Fatalf("first claim = %+v, want one row at attempt 1", claimed)
	}
	if got := eventStatus(t, pool, f.eventID); got != "processing" {
		t.Fatalf("event status after claim = %s, want processing", got)
	}

	// A live lease is not stealable.
	again, err := store.ClaimOutbox(ctx, "rtr_b", 10, time.Hour)
	if err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}
	for _, row := range again {
		if row.ID == f.outboxID {
			t.Fatal("a live lease was stolen by a second router")
		}
	}

	// An expired lease is. This is how a crashed router's rows come back.
	mustExec(t, pool, `UPDATE event_outbox SET locked_until = now() - interval '1 second' WHERE id = $1`, f.outboxID)
	reclaimed, err := store.ClaimOutbox(ctx, "rtr_b", 10, time.Hour)
	if err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}
	found := false
	for _, row := range reclaimed {
		if row.ID == f.outboxID {
			found = true
			if row.Attempts != 2 {
				t.Fatalf("attempts = %d after reclaim, want 2; without the increment a poisoned row cycles forever", row.Attempts)
			}
		}
	}
	if !found {
		t.Fatal("an expired lease was not reclaimable; a crashed router's rows would be stuck forever")
	}
}

func TestPostgresParkAndReleaseRespectTheLease(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	store := NewPostgresStore(pool)

	if _, err := store.ClaimOutbox(ctx, "rtr_a", 10, time.Hour); err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}

	// A router that does not hold the lease may not touch the row.
	if err := store.ParkOutbox(ctx, "rtr_b", f.outboxID, f.eventID, "not mine"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("ParkOutbox by a non-owner returned %v, want ErrLeaseLost", err)
	}
	if err := store.ReleaseOutbox(ctx, "rtr_b", f.outboxID, "not mine", time.Second); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("ReleaseOutbox by a non-owner returned %v, want ErrLeaseLost", err)
	}
	if status, _, _, _ := outboxState(t, pool, f.outboxID); status != "processing" {
		t.Fatalf("a non-owner changed the row to %s", status)
	}

	// The owner can release it back into the ready set, with a reason.
	if err := store.ReleaseOutbox(ctx, "rtr_a", f.outboxID, "transient failure", 50*time.Millisecond); err != nil {
		t.Fatalf("ReleaseOutbox: %v", err)
	}
	var lastError *string
	if err := pool.QueryRow(ctx, `SELECT last_error FROM event_outbox WHERE id = $1`, f.outboxID).Scan(&lastError); err != nil {
		t.Fatalf("read last_error: %v", err)
	}
	if lastError == nil || *lastError != "transient failure" {
		t.Fatalf("last_error = %v, want the recorded reason", lastError)
	}
	if status, _, lockedBy, _ := outboxState(t, pool, f.outboxID); status != "pending" || lockedBy != nil {
		t.Fatalf("after release: status=%s locked_by=%v, want pending and unlocked", status, lockedBy)
	}
}

// TestPostgresPoisonedRowLeavesTheQueue is the guarantee that one bad row
// cannot block the queue forever.
func TestPostgresPoisonedRowLeavesTheQueue(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	// Already claimed three times without completing; the bound is 3.
	mustExec(t, pool, `UPDATE event_outbox SET attempts = 3 WHERE id = $1`, f.outboxID)

	r := newIntegrationRouter(t, pool, "rtr_"+f.orgID)
	if _, err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	status, attempts, lockedBy, _ := outboxState(t, pool, f.outboxID)
	if status != "failed" {
		t.Fatalf("outbox status = %s (attempts %d), want failed", status, attempts)
	}
	if lockedBy != nil {
		t.Fatalf("parked row is still locked by %v", *lockedBy)
	}
	var lastError *string
	if err := pool.QueryRow(ctx, `SELECT last_error FROM event_outbox WHERE id = $1`, f.outboxID).Scan(&lastError); err != nil {
		t.Fatalf("read last_error: %v", err)
	}
	if lastError == nil || *lastError == "" {
		t.Fatal("a parked row must record why it was parked")
	}
	if got := eventStatus(t, pool, f.eventID); got != "failed" {
		t.Fatalf("event status = %s, want failed", got)
	}

	// And it must never be claimed again.
	store := NewPostgresStore(pool)
	claimed, err := store.ClaimOutbox(ctx, "rtr_c", 50, time.Minute)
	if err != nil {
		t.Fatalf("ClaimOutbox: %v", err)
	}
	for _, row := range claimed {
		if row.ID == f.outboxID {
			t.Fatal("a parked row was claimed again; the queue can still be blocked by it")
		}
	}
}

func TestPostgresOutboxLagSeconds(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	mustExec(t, pool, `UPDATE event_outbox SET available_at = now() - interval '30 seconds' WHERE id = $1`, f.outboxID)

	store := NewPostgresStore(pool)
	lag, err := store.OutboxLagSeconds(ctx)
	if err != nil {
		t.Fatalf("OutboxLagSeconds: %v", err)
	}
	if lag < 30 {
		t.Fatalf("lag = %.1fs, want at least 30s", lag)
	}
}

// TestPostgresConcurrentRoutersDoNotDoubleFanOut runs two routers at the same
// event. Whichever loses must leave no trace.
func TestPostgresConcurrentRoutersDoNotDoubleFanOut(t *testing.T) {
	pool := requirePool(t)
	ctx := context.Background()
	f := seed(t, pool, "payment.settled")
	f.addEndpoint(t, []string{"*"}, endpointOpts{})
	f.addEndpoint(t, []string{"*"}, endpointOpts{})

	a := newIntegrationRouter(t, pool, "rtr_a_"+f.orgID)
	b := newIntegrationRouter(t, pool, "rtr_b_"+f.orgID)

	done := make(chan error, 2)
	go func() { _, err := a.RunOnce(ctx); done <- err }()
	go func() { _, err := b.RunOnce(ctx); done <- err }()
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
	}

	if got := loadDeliveries(t, pool, f.eventID); len(got) != 2 {
		t.Fatalf("two routers produced %d deliveries, want 2", len(got))
	}
}
