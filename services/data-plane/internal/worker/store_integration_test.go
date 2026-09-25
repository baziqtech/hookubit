package worker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// These run the real worker SQL against a migrated database. They are the only
// place column-name and enum drift against Prisma's schema is caught, and the
// only place the circuit breaker's SQL is checked against NextHealth - the pure
// function that is its specification. They skip rather than fail when there is
// nothing to talk to, matching internal/queue and internal/ingest.
//
// The pool points at THIS PACKAGE'S OWN database (see internal/testsupport).
func requirePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testsupport.Pool(t)
}

type dbFixture struct {
	pool       *pgxpool.Pool
	orgID      string
	projectID  string
	endpointID string
	eventID    string
	policyID   string
	payload    []byte
}

func seedWorkerFixture(t *testing.T, pool *pgxpool.Pool) *dbFixture {
	t.Helper()
	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}

	f := &dbFixture{
		pool:       pool,
		orgID:      ids.New(ids.Organization),
		projectID:  ids.New(ids.Project),
		endpointID: ids.New(ids.Endpoint),
		eventID:    ids.New(ids.Event),
		policyID:   ids.New(ids.RetryPolicy),
		// Deliberately not what jsonb would give back: key order and spacing
		// are preserved only by payload_raw.
		payload: []byte(`{ "b": 1,  "a": 2 }`),
	}

	mustExec(t, pool, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
	                   VALUES ($1, 'worker test', $2, 'active', now(), now())`,
		f.orgID, "worker-test-"+suffix)
	mustExec(t, pool, `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
	                   VALUES ($1, $2, 'worker test', $3, 'test', 'active', now(), now())`,
		f.projectID, f.orgID, "worker-test-"+suffix)
	mustExec(t, pool, `INSERT INTO retry_policies
	                     (id, project_id, name, is_default, strategy, max_attempts, initial_delay_ms,
	                      max_delay_ms, multiplier, jitter_ratio, max_retry_duration_ms, created_at, updated_at)
	                   VALUES ($1, $2, 'worker test', false, 'exponential', 4, 1000, 60000, 3, 0.1, 7200000, now(), now())`,
		f.policyID, f.projectID)
	mustExec(t, pool, `INSERT INTO endpoints
	                     (id, project_id, name, url, status, enabled, timeout_ms, max_concurrency,
	                      rate_limit, rate_limit_window_seconds, retry_policy_id, custom_headers, created_at, updated_at)
	                   VALUES ($1, $2, 'worker test', 'https://example.com/hook', 'active', true, 9000, 7,
	                           25, 2, $3, '{"X-Tenant":"acme","X-Bogus":5}'::jsonb, now(), now())`,
		f.endpointID, f.projectID, f.policyID)
	mustExec(t, pool, `INSERT INTO events
	                     (id, organization_id, project_id, event_type, payload, payload_raw,
	                      payload_size, payload_hash, ordering_key, status, created_at)
	                   VALUES ($1, $2, $3, 'order.created', $4::jsonb, $5, $6, repeat('0', 64), 'cust_1', 'received', now())`,
		f.eventID, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload))

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM deliveries WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoint_secrets WHERE endpoint_id = $1`, f.endpointID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoints WHERE id = $1`, f.endpointID)
		_, _ = pool.Exec(bg, `DELETE FROM retry_policies WHERE id = $1`, f.policyID)
		_, _ = pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, f.orgID)
	})
	return f
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("seed (%s): %v", sql[:min(48, len(sql))], err)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (f *dbFixture) insertDelivery(t *testing.T, lockedBy string) string {
	t.Helper()
	id := ids.New(ids.Delivery)
	var by any
	var until any
	if lockedBy != "" {
		by = lockedBy
		until = time.Now().Add(time.Minute).UTC()
	}
	mustExec(t, f.pool, `INSERT INTO deliveries
	                       (id, event_id, endpoint_id, organization_id, project_id, status,
	                        attempt_count, max_attempts, next_attempt_at, locked_by, locked_until,
	                        created_at, updated_at)
	                     VALUES ($1, $2, $3, $4, $5, 'processing', 0, 6, now(), $6, $7, now(), now())`,
		id, f.newEvent(t), f.endpointID, f.orgID, f.projectID, by, until)
	return id
}

// newEvent mints a fresh event for each delivery.
//
// Sharing one event across deliveries is what the in-memory fake allowed and
// PostgreSQL does not: deliveries_event_endpoint_original_key is UNIQUE on
// (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL. That index is
// the router's ON CONFLICT arbiter - the thing that stops a re-run
// double-routing an event to every subscriber - so the constraint is
// correct and the fixture was modelling a row the router cannot produce.
func (f *dbFixture) newEvent(t *testing.T) string {
	t.Helper()
	id := ids.New(ids.Event)
	// Carry the fixture's payload. An event minted without payload_raw makes
	// Load return empty bytes, which is indistinguishable from the worker
	// failing to read the column - and the worker would go on to sign and
	// deliver an empty body.
	mustExec(t, f.pool, `INSERT INTO events
	                       (id, organization_id, project_id, event_type, payload, payload_raw,
	                        payload_size, payload_hash, ordering_key, status, created_at)
	                     VALUES ($1, $2, $3, 'order.created', $4::jsonb, $5, $6, repeat('0', 64), 'cust_1', 'received', now())`,
		id, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload))
	// Track the most recently minted event so single-delivery tests can still
	// assert against f.eventID.
	f.eventID = id
	return id
}

func (f *dbFixture) insertSecret(t *testing.T, envelope string, active bool, expiresAt *time.Time, version int) string {
	t.Helper()
	id := ids.New(ids.Secret)
	var expires any
	if expiresAt != nil {
		expires = expiresAt.UTC()
	}
	mustExec(t, f.pool, `INSERT INTO endpoint_secrets (id, endpoint_id, secret_encrypted, version, active, created_at, expires_at)
	                     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
		id, f.endpointID, envelope, version, active, expires)
	return id
}

func TestStoreLoadReadsEverythingTheAttemptNeeds(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)

	live := f.insertSecret(t, "v1.k1.iv.tag.ct", true, nil, 1)
	future := time.Now().Add(time.Hour)
	rotating := f.insertSecret(t, "v1.k1.iv2.tag2.ct2", true, &future, 2)
	past := time.Now().Add(-time.Hour)
	f.insertSecret(t, "v1.k1.expired.tag.ct", true, &past, 3) // active but expired
	f.insertSecret(t, "v1.k1.revoked.tag.ct", false, nil, 4)  // explicitly revoked

	deliveryID := f.insertDelivery(t, "wrk_1")
	job, err := store.Load(context.Background(), deliveryID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if string(job.Payload) != string(f.payload) {
		t.Fatalf("payload = %q, want the exact payload_raw bytes %q; the jsonb column would have normalised it",
			job.Payload, f.payload)
	}
	if job.EventType != "order.created" || job.OrderingKey != "cust_1" {
		t.Fatalf("event fields wrong: %+v", job)
	}
	if job.AttemptNumber != 1 {
		t.Fatalf("attempt number = %d, want 1", job.AttemptNumber)
	}
	if job.Endpoint.Timeout != 9*time.Second || job.Endpoint.MaxConcurrency != 7 {
		t.Fatalf("endpoint limits wrong: %+v", job.Endpoint)
	}
	if job.Endpoint.RateLimit != 25 || job.Endpoint.RateLimitWindow != 2*time.Second {
		t.Fatalf("endpoint rate limit wrong: %+v", job.Endpoint)
	}
	if job.Endpoint.CustomHeaders["X-Tenant"] != "acme" {
		t.Fatalf("custom headers = %v", job.Endpoint.CustomHeaders)
	}
	if _, present := job.Endpoint.CustomHeaders["X-Bogus"]; present {
		t.Fatal("a non-string custom_headers value was stringified into a header the customer never wrote")
	}

	// The policy comes from the endpoint's retry_policies row, except
	// max_attempts, which the delivery froze at creation time.
	if job.Policy.Strategy != "exponential" || job.Policy.InitialDelay != time.Second ||
		job.Policy.Multiplier != 3 || job.Policy.MaxRetryDuration != 2*time.Hour {
		t.Fatalf("retry policy not loaded: %+v", job.Policy)
	}
	if job.Policy.MaxAttempts != 6 {
		t.Fatalf("max attempts = %d, want the delivery's frozen 6, not the policy's 4", job.Policy.MaxAttempts)
	}

	if len(job.Secrets) != 2 {
		t.Fatalf("loaded %d secrets, want 2 (an expired-but-active row and a revoked row must not sign): %+v",
			len(job.Secrets), job.Secrets)
	}
	if job.Secrets[0].ID != rotating || job.Secrets[1].ID != live {
		t.Fatalf("secrets must arrive newest version first, got %s then %s", job.Secrets[0].ID, job.Secrets[1].ID)
	}
}

func TestStoreLoadReportsAMissingDelivery(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	_, err := store.Load(context.Background(), "del_does_not_exist")
	if !errors.Is(err, ErrDeliveryGone) {
		t.Fatalf("err = %v, want ErrDeliveryGone", err)
	}
}

func TestStoreCompleteWritesAttemptAndTransitionAtomically(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	deliveryID := f.insertDelivery(t, "wrk_1")
	started := time.Now().Add(-250 * time.Millisecond)
	err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
		Number:          1,
		StartedAt:       started,
		CompletedAt:     time.Now(),
		Status:          AttemptFailure,
		HTTPStatus:      503,
		RequestHeaders:  map[string]string{"Webhook-Id": "evt_1", "Authorization": "[redacted]"},
		ResponseHeaders: map[string]string{"Retry-After": "5"},
		ResponseBody:    "upstream unavailable",
		ResponseSize:    20,
		ErrorCode:       "http_503",
		Duration:        250 * time.Millisecond,
		WorkerID:        "wrk_1",
	}, Transition{State: StateRetrying, Reason: ReasonRetryScheduled, Delay: 30 * time.Second, AttemptCount: 1})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}

	var (
		status       string
		attemptCount int
		lockedBy     *string
		nextAttempt  *time.Time
		completedAt  *time.Time
		lastError    *string
	)
	if err := pool.QueryRow(ctx,
		`SELECT status::text, attempt_count, locked_by, next_attempt_at, completed_at, last_error
		 FROM deliveries WHERE id = $1`, deliveryID).
		Scan(&status, &attemptCount, &lockedBy, &nextAttempt, &completedAt, &lastError); err != nil {
		t.Fatalf("read delivery: %v", err)
	}
	if status != "retrying" || attemptCount != 1 {
		t.Fatalf("status = %s attempt_count = %d", status, attemptCount)
	}
	if lockedBy != nil {
		t.Fatalf("the lease must be released as part of the transition, still locked by %q", *lockedBy)
	}
	if nextAttempt == nil || !nextAttempt.After(time.Now().Add(20*time.Second)) {
		t.Fatalf("next_attempt_at = %v; the retry delay was not applied server-side", nextAttempt)
	}
	if completedAt != nil {
		t.Fatal("a retrying delivery is not completed")
	}
	if lastError == nil || *lastError != string(ReasonRetryScheduled) {
		t.Fatalf("last_error = %v; every transition must carry its reason where an operator can see it", lastError)
	}

	var (
		attemptStatus string
		httpStatus    *int
		durationMS    *int
		body          *string
		errorCode     *string
	)
	if err := pool.QueryRow(ctx,
		`SELECT status::text, http_status, duration_ms, response_body, error_code
		 FROM delivery_attempts WHERE delivery_id = $1 AND attempt_number = 1`, deliveryID).
		Scan(&attemptStatus, &httpStatus, &durationMS, &body, &errorCode); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	if attemptStatus != "failure" || httpStatus == nil || *httpStatus != 503 {
		t.Fatalf("attempt row wrong: %s %v", attemptStatus, httpStatus)
	}
	if durationMS == nil || *durationMS < 200 {
		t.Fatalf("duration_ms = %v", durationMS)
	}
	if body == nil || *body != "upstream unavailable" || errorCode == nil || *errorCode != "http_503" {
		t.Fatalf("attempt body/code wrong: %v %v", body, errorCode)
	}
}

// The crash-safety guard, in SQL. A worker whose lease was reclaimed must write
// NOTHING - not the attempt row, not the transition.
func TestStoreCompleteRollsBackWhenTheLeaseWasReclaimed(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	deliveryID := f.insertDelivery(t, "wrk_other") // owned by somebody else

	err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
		Number: 1, StartedAt: time.Now(), CompletedAt: time.Now(),
		Status: AttemptSuccess, HTTPStatus: 200, WorkerID: "wrk_1",
	}, Transition{State: StateSucceeded, Reason: ReasonDelivered, AttemptCount: 1})

	if !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("err = %v, want ErrLeaseNotHeld", err)
	}

	attempts, status := 0, ""
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM delivery_attempts WHERE delivery_id = $1`, deliveryID).
		Scan(&attempts); err != nil {
		t.Fatalf("count attempts: %v", err)
	}
	if attempts != 0 {
		t.Fatalf("%d attempt rows written by a worker that no longer held the lease; the transaction did not roll back", attempts)
	}
	if err := pool.QueryRow(ctx, `SELECT status::text FROM deliveries WHERE id = $1`, deliveryID).Scan(&status); err != nil {
		t.Fatalf("read delivery: %v", err)
	}
	if status != "processing" {
		t.Fatalf("status = %s; the other worker's claim was clobbered", status)
	}
}

func TestStoreDeferSchedulesWithoutRecordingAnAttempt(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	deliveryID := f.insertDelivery(t, "wrk_1")
	if err := store.Defer(ctx, "wrk_1", deliveryID, Transition{
		State: StateScheduled, Reason: ReasonBreakerOpen, Delay: 45 * time.Second,
	}); err != nil {
		t.Fatalf("defer: %v", err)
	}

	var (
		status       string
		attemptCount int
		lockedBy     *string
		nextAttempt  *time.Time
		lastError    *string
		attempts     int
	)
	if err := pool.QueryRow(ctx,
		`SELECT d.status::text, d.attempt_count, d.locked_by, d.next_attempt_at, d.last_error,
		        (SELECT count(*) FROM delivery_attempts a WHERE a.delivery_id = d.id)
		 FROM deliveries d WHERE d.id = $1`, deliveryID).
		Scan(&status, &attemptCount, &lockedBy, &nextAttempt, &lastError, &attempts); err != nil {
		t.Fatalf("read delivery: %v", err)
	}
	if status != "scheduled" {
		t.Fatalf("status = %s, want scheduled (which internal/queue's ready predicate includes)", status)
	}
	if attemptCount != 0 {
		t.Fatalf("attempt_count = %d; a deferral must not burn an attempt", attemptCount)
	}
	if attempts != 0 {
		t.Fatalf("%d attempt rows written for a delivery that was never attempted", attempts)
	}
	if lockedBy != nil {
		t.Fatalf("still locked by %q after a deferral", *lockedBy)
	}
	if nextAttempt == nil || !nextAttempt.After(time.Now().Add(30*time.Second)) {
		t.Fatalf("next_attempt_at = %v", nextAttempt)
	}
	if lastError == nil || *lastError != string(ReasonBreakerOpen) {
		t.Fatalf("last_error = %v; a delivery sitting in scheduled must say why", lastError)
	}
}

func TestStoreCompleteMarksTerminalStates(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	for _, state := range []State{StateSucceeded, StateFailed, StateExhausted, StateCancelled} {
		deliveryID := f.insertDelivery(t, "wrk_1")
		var attempt *AttemptRecord
		count := 0
		if state != StateCancelled {
			attempt = &AttemptRecord{
				Number: 1, StartedAt: time.Now(), CompletedAt: time.Now(),
				Status: AttemptSuccess, HTTPStatus: 200, WorkerID: "wrk_1",
			}
			count = 1
		}
		if err := store.Complete(ctx, "wrk_1", deliveryID, attempt,
			Transition{State: state, Reason: ReasonDelivered, AttemptCount: count}); err != nil {
			t.Fatalf("complete %s: %v", state, err)
		}

		var got string
		var completedAt, nextAttempt *time.Time
		if err := pool.QueryRow(ctx,
			`SELECT status::text, completed_at, next_attempt_at FROM deliveries WHERE id = $1`, deliveryID).
			Scan(&got, &completedAt, &nextAttempt); err != nil {
			t.Fatalf("read delivery: %v", err)
		}
		if got != string(state) {
			t.Fatalf("status = %s, want %s (the Go constant must be a member of the DeliveryStatus enum)", got, state)
		}
		if completedAt == nil {
			t.Fatalf("%s is terminal and must stamp completed_at", state)
		}
		// A terminal delivery still carries a next_attempt_at, and that is
		// deliberate - see advanceSQL. The column is NOT NULL, and NULL was
		// never a neutral value here: while it was allowed, the claim's NULLS
		// FIRST ordering put it at the front of the queue. Nothing re-attempts
		// this row (its status is outside the ready set, which
		// TestTerminalDeliveriesAreNeverClaimed in internal/queue proves), so
		// the value is inert; what it must never be is absent - and the
		// database now says so, not just this test.
		if nextAttempt == nil {
			t.Fatalf("%s left next_attempt_at NULL; the NOT NULL constraint would have rejected this transition", state)
		}
		if nextAttempt.After(time.Now().Add(time.Second)) {
			t.Fatalf("%s wrote a FUTURE next_attempt_at (%v); a terminal row must not look scheduled to an operator", state, nextAttempt)
		}
	}

	// The constraint is table-wide, not per-transition: assert it over every
	// row this fixture touched. With NOT NULL applied a NULL cannot be written
	// at all, so a non-zero count here means the database under test is
	// missing 20260911000000 - which is worth failing loudly on, because every
	// other assertion in this package would then be running against the wrong
	// schema.
	var nulls int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM deliveries WHERE organization_id = $1 AND next_attempt_at IS NULL`, f.orgID).
		Scan(&nulls); err != nil {
		t.Fatalf("count null next_attempt_at: %v", err)
	}
	if nulls != 0 {
		t.Fatalf("%d deliveries have a NULL next_attempt_at; the column is NOT NULL, so this database is missing 20260911000000_next_attempt_at_not_null", nulls)
	}
}

func TestAttemptsAreAppendOnly(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	deliveryID := f.insertDelivery(t, "wrk_1")
	for n := 1; n <= 3; n++ {
		// Re-take the lease: Complete releases it on every transition.
		mustExec(t, pool, `UPDATE deliveries SET locked_by = 'wrk_1', locked_until = now() + interval '1 minute' WHERE id = $1`, deliveryID)
		if err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
			Number: n, StartedAt: time.Now(), CompletedAt: time.Now(),
			Status: AttemptFailure, HTTPStatus: 500, WorkerID: "wrk_1",
		}, Transition{State: StateRetrying, Reason: ReasonRetryScheduled, Delay: time.Minute, AttemptCount: n}); err != nil {
			t.Fatalf("attempt %d: %v", n, err)
		}
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM delivery_attempts WHERE delivery_id = $1`, deliveryID).
		Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 3 {
		t.Fatalf("%d attempt rows for 3 attempts; history must accumulate, never be updated in place", rows)
	}

	// The unique (delivery_id, attempt_number) index is what stops a
	// re-delivered attempt number from silently duplicating history.
	mustExec(t, pool, `UPDATE deliveries SET locked_by = 'wrk_1', locked_until = now() + interval '1 minute' WHERE id = $1`, deliveryID)
	err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
		Number: 3, StartedAt: time.Now(), CompletedAt: time.Now(),
		Status: AttemptSuccess, HTTPStatus: 200, WorkerID: "wrk_1",
	}, Transition{State: StateSucceeded, Reason: ReasonDelivered, AttemptCount: 3})
	if err == nil {
		t.Fatal("re-recording attempt number 3 succeeded; the unique index is not being relied on")
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM deliveries WHERE id = $1`, deliveryID).Scan(&status); err != nil {
		t.Fatalf("read delivery: %v", err)
	}
	if status == "succeeded" {
		t.Fatal("the transition committed even though its attempt row did not; the two must be one transaction")
	}
}

// TestStoreLoadFallsBackToTheProjectDefaultRetryPolicy pins a bug found by
// running the platform, not by a unit test.
//
// The router resolves max_attempts as endpoint policy -> project default ->
// built-in. Load used to join only on e.retry_policy_id, so an endpoint with no
// policy of its own skipped the project default and fell through to the
// built-in. The operator got max_attempts from their policy and backoff from
// somewhere else: observed live as 5s/10s/20s gaps under a policy specifying 1s
// capped at 5s.
func TestStoreLoadFallsBackToTheProjectDefaultRetryPolicy(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	// The fixture's endpoint points at its own policy. Detach it and make the
	// fixture policy the project default instead.
	mustExec(t, pool, `UPDATE endpoints SET retry_policy_id = NULL WHERE id = $1`, f.endpointID)
	mustExec(t, pool, `UPDATE retry_policies SET is_default = true WHERE id = $1`, f.policyID)

	job, err := store.Load(ctx, f.insertDelivery(t, "wrk_1"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if job.Policy.InitialDelay != time.Second {
		t.Fatalf("initial delay = %s, want 1s from the project default; the built-in is 5s, so this is the bug",
			job.Policy.InitialDelay)
	}
	if job.Policy.MaxAttempts != 6 {
		t.Fatalf("max attempts = %d, want 6 from the project default", job.Policy.MaxAttempts)
	}

	// An endpoint with its own policy must still prefer it over the default.
	mustExec(t, pool, `UPDATE endpoints SET retry_policy_id = $2 WHERE id = $1`, f.endpointID, f.policyID)
	if _, err := store.Load(ctx, f.insertDelivery(t, "wrk_1")); err != nil {
		t.Fatalf("load with endpoint policy: %v", err)
	}
}

// request_payload, against the real column.
//
// Two things only a database can prove. First, that the column exists and is
// named what the INSERT thinks it is - this package's SQL is hand-written, so
// this is the only place drift against Prisma's schema is caught. Second, that
// what the worker's sanitiser produces is actually insertable: `text` cannot
// hold a NUL byte, and a publisher's payload_raw is arbitrary bytes, so an
// unsanitised copy would fail the INSERT and lose the attempt row entirely -
// which is far worse than losing the bytes.
func TestStoreCompleteStoresTheRequestPayloadItWasGiven(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	// Exactly what the delivery path writes: sanitised, and bounded small enough
	// that the marker is present too.
	raw := []byte("{\"a\":\"\x00\x80z\",\"pad\":\"" + strings.Repeat("A", 128) + "\"}")
	sanitised := storableText(raw, 64, false)

	deliveryID := f.insertDelivery(t, "wrk_1")
	if err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
		Number: 1, StartedAt: time.Now(), CompletedAt: time.Now(),
		Status: AttemptSuccess, HTTPStatus: 200, WorkerID: "wrk_1",
		RequestHeaders: map[string]string{"Webhook-Id": f.eventID},
		RequestPayload: sanitised,
	}, Transition{State: StateSucceeded, Reason: ReasonDelivered, AttemptCount: 1}); err != nil {
		t.Fatalf("complete: %v", err)
	}

	var stored *string
	if err := pool.QueryRow(ctx,
		`SELECT request_payload FROM delivery_attempts WHERE delivery_id = $1 AND attempt_number = 1`,
		deliveryID).Scan(&stored); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	if stored == nil {
		t.Fatal("request_payload came back NULL; the column was not written")
	}
	if *stored != sanitised {
		t.Fatalf("request_payload round-tripped as %q, want %q", *stored, sanitised)
	}
	if !strings.Contains(*stored, "truncated") {
		t.Fatalf("the bound marker did not survive storage: %q", *stored)
	}
}

// An attempt that never reached the network writes NULL, not "". The difference
// is the difference between "we have no record of what this attempt sent" and
// "this attempt sent an empty body", and an operator reading the ledger at 2am
// has to be able to tell them apart.
func TestStoreCompleteWritesNullWhenNothingWasSent(t *testing.T) {
	pool := requirePool(t)
	f := seedWorkerFixture(t, pool)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	deliveryID := f.insertDelivery(t, "wrk_1")
	if err := store.Complete(ctx, "wrk_1", deliveryID, &AttemptRecord{
		Number: 1, StartedAt: time.Now(), CompletedAt: time.Now(),
		Status: AttemptError, ErrorCode: "signing_failed", WorkerID: "wrk_1",
	}, Transition{State: StateRetrying, Reason: ReasonSigningFailed, Delay: time.Minute, AttemptCount: 1}); err != nil {
		t.Fatalf("complete: %v", err)
	}

	var stored *string
	if err := pool.QueryRow(ctx,
		`SELECT request_payload FROM delivery_attempts WHERE delivery_id = $1 AND attempt_number = 1`,
		deliveryID).Scan(&stored); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	if stored != nil {
		t.Fatalf("request_payload = %q for an attempt that sent nothing; it must be NULL", *stored)
	}
}
