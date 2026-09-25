package failure_test

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	crand "crypto/rand"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/egress"
	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/queue"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
	"github.com/shaq/hookubit/services/data-plane/internal/worker"
)

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

// requirePool hands back THIS PACKAGE'S OWN database, copied from the migrated
// template by testsupport. It matters here more than anywhere else: every claim
// query in the data plane is global by design - draining a queue means draining
// it - so "which rows did this batch contain" is only a well-posed question
// when the database holds nothing but this package's rows.
//
// It skips, never fails, when DATABASE_URL is unset.
func requirePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testsupport.Pool(t)
}

// separatePool opens a second pool on the same test database, for the
// tests that need two genuinely independent clients - two workers racing for
// one delivery, or an "ingest process" whose connections die while the rest of
// the test carries on.
func separatePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := testsupport.DSN(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open a second pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// resetQueue empties the work tables before a test that asserts WHICH rows a
// global claim returned.
//
// On a shared database this would be the anti-pattern testsupport's doc comment
// warns about - a delete that races other packages and destroys their in-flight
// data. It is safe here for exactly one reason: this database belongs to this
// package alone and Go runs a package's tests sequentially unless they call
// t.Parallel, which nothing here does.
func resetQueue(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	for _, stmt := range []string{
		`DELETE FROM delivery_attempts`,
		`DELETE FROM deliveries`,
		`DELETE FROM event_outbox`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("reset (%s): %v", stmt, err)
		}
	}
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %.70q: %v", sql, err)
	}
}

// ---------------------------------------------------------------------------
// encryption
// ---------------------------------------------------------------------------

const testKeyID = "k1"

// testKey is the 32-byte AES key both the fixture and the worker's keyring use.
// Fixed rather than random so a failure is reproducible.
var testKey = bytes.Repeat([]byte{0x2a}, 32)

func testKeyB64() string { return base64.StdEncoding.EncodeToString(testKey) }

// encryptSecret writes the control plane's envelope by hand:
//
//	v1.<kid>.<iv>.<tag>.<ciphertext>
//
// AES-256-GCM with AAD "endpoint_secrets:<secret id>:<endpoint id>", which is
// the row binding worker.EncryptionContext.AAD builds. Anything else and every
// delivery fails at signing time instead of reaching the endpoint - which is
// exactly the misdiagnosis crypto.go's comments warn about, so it is worth
// saying out loud that this helper is the only place the test side of that
// contract is expressed.
func encryptSecret(t *testing.T, secretID, endpointID, plaintext string) string {
	t.Helper()
	block, err := aes.NewCipher(testKey)
	if err != nil {
		t.Fatalf("aes cipher: %v", err)
	}
	aead, err := cipher.NewGCMWithNonceSize(block, 12)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, 12)
	if _, err := io.ReadFull(crand.Reader, iv); err != nil {
		t.Fatalf("iv: %v", err)
	}
	aad := []byte("endpoint_secrets:" + secretID + ":" + endpointID)
	sealed := aead.Seal(nil, iv, []byte(plaintext), aad)
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	enc := base64.RawURLEncoding.EncodeToString
	return strings.Join([]string{"v1", testKeyID, enc(iv), enc(tag), enc(ct)}, ".")
}

func testKeyring(t *testing.T) *worker.Keyring {
	t.Helper()
	ring, err := worker.ParseKeyring(testKeyB64(), testKeyID, "")
	if err != nil {
		t.Fatalf("build keyring: %v", err)
	}
	return ring
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

// fixture is one tenant: an organisation, a project and a retry policy, plus
// whatever endpoints and deliveries a test adds to it.
//
// The retry policy is CONSTANT with ZERO jitter on purpose. Every scenario here
// that asserts a retry schedule needs to distinguish "backed off by the policy"
// from "backed off by something else"; exponential-with-jitter turns that into
// a range wide enough to hide a bug.
type fixture struct {
	pool      *pgxpool.Pool
	orgID     string
	projectID string
	policyID  string

	payload     []byte
	payloadHash string
	secret      string
}

// retryDelay is the fixture policy's constant backoff. Long enough that nothing
// re-fires inside a test, short enough to read.
const retryDelay = 60 * time.Second

func seedTenant(t *testing.T, pool *pgxpool.Pool) *fixture {
	t.Helper()
	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately not what jsonb round-trips to: key order and spacing survive
	// only in payload_raw, and the worker verifies the bytes against
	// payload_hash before it signs them.
	payload := []byte(`{ "b": 1,  "a": 2 }`)

	f := &fixture{
		pool:        pool,
		orgID:       ids.New(ids.Organization),
		projectID:   ids.New(ids.Project),
		policyID:    ids.New(ids.RetryPolicy),
		payload:     payload,
		payloadHash: ingest.HashPayload(payload),
		secret:      "whsec_" + suffix,
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM delivery_attempts WHERE delivery_id IN
		                        (SELECT id FROM deliveries WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM deliveries WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM event_outbox WHERE event_id IN
		                        (SELECT id FROM events WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM events WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoint_health WHERE endpoint_id IN
		                        (SELECT id FROM endpoints WHERE project_id IN
		                          (SELECT id FROM projects WHERE organization_id = $1))`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoints WHERE project_id IN
		                        (SELECT id FROM projects WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, f.orgID)
	})

	mustExec(t, pool, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
	                   VALUES ($1, 'failure test', $2, 'active', now(), now())`,
		f.orgID, "failure-"+suffix)
	mustExec(t, pool, `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
	                   VALUES ($1, $2, 'failure test', $3, 'test', 'active', now(), now())`,
		f.projectID, f.orgID, "failure-"+suffix)
	mustExec(t, pool, `INSERT INTO retry_policies
	                     (id, project_id, name, is_default, strategy, max_attempts, initial_delay_ms,
	                      max_delay_ms, multiplier, jitter_ratio, max_retry_duration_ms, created_at, updated_at)
	                   VALUES ($1, $2, 'failure test', true, 'constant', 5, $3, 3600000, 2.0, 0, 86400000, now(), now())`,
		f.policyID, f.projectID, retryDelay.Milliseconds())
	return f
}

type endpointOpts struct {
	url            string
	timeoutMS      int
	maxConcurrency int
	// noSecret omits the signing secret. Only for tests that never deliver.
	noSecret bool
}

// newEndpoint creates an endpoint, its signing secret, and returns its id.
func (f *fixture) newEndpoint(t *testing.T, opts endpointOpts) string {
	t.Helper()
	if opts.url == "" {
		opts.url = "https://example.invalid/hook"
	}
	if opts.timeoutMS == 0 {
		opts.timeoutMS = 10000
	}
	if opts.maxConcurrency == 0 {
		opts.maxConcurrency = 4
	}
	id := ids.New(ids.Endpoint)
	mustExec(t, f.pool, `INSERT INTO endpoints
	                       (id, project_id, name, url, status, enabled, timeout_ms, max_concurrency,
	                        rate_limit, rate_limit_window_seconds, retry_policy_id, created_at, updated_at)
	                     VALUES ($1, $2, 'failure test', $3, 'active', true, $4, $5, NULL, 1, $6, now(), now())`,
		id, f.projectID, opts.url, opts.timeoutMS, opts.maxConcurrency, f.policyID)
	if !opts.noSecret {
		secretID := ids.New(ids.Secret)
		mustExec(t, f.pool, `INSERT INTO endpoint_secrets (id, endpoint_id, secret_encrypted, version, active, created_at)
		                     VALUES ($1, $2, $3, 1, true, now())`,
			secretID, id, encryptSecret(t, secretID, id, f.secret))
	}
	return id
}

// newSubscription binds an endpoint to the event types it should receive. Only
// the router path needs one; a delivery row created directly does not.
func (f *fixture) newSubscription(t *testing.T, endpointID string, eventTypes []string) string {
	t.Helper()
	id := ids.New(ids.Subscription)
	mustExec(t, f.pool, `INSERT INTO webhook_subscriptions
	                       (id, project_id, endpoint_id, event_types, enabled, created_at, updated_at)
	                     VALUES ($1, $2, $3, $4::text[], true, now(), now())`,
		id, f.projectID, endpointID, eventTypes)
	return id
}

// newEvent mints a fresh event carrying the fixture payload.
//
// One event per delivery, always: deliveries_event_endpoint_original_key is a
// partial UNIQUE index on (event_id, endpoint_id) WHERE replay_of_delivery_id
// IS NULL. It is the router's ON CONFLICT arbiter - the thing that stops a
// re-run double-routing - so a fixture that shares one event across two
// original deliveries is modelling a row production cannot create.
func (f *fixture) newEvent(t *testing.T) string {
	t.Helper()
	id := ids.New(ids.Event)
	mustExec(t, f.pool, `INSERT INTO events
	                       (id, organization_id, project_id, event_type, payload, payload_raw,
	                        payload_size, payload_hash, status, created_at)
	                     VALUES ($1, $2, $3, 'order.created', $4::jsonb, $5, $6, $7, 'received', now())`,
		id, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload), f.payloadHash)
	return id
}

type deliveryOpts struct {
	status       string
	lockedBy     string
	lockedUntil  time.Duration // relative to now(); ignored when lockedBy is empty
	due          time.Duration // relative to now(); negative means already due
	maxAttempts  int
	attemptCount int
	// projectID and orgID override the fixture's tenant, for fairness tests.
	projectID string
	orgID     string
}

// newDelivery writes one delivery row in an arbitrary lease state, which is how
// every "a worker crashed here" precondition is expressed in this suite.
func (f *fixture) newDelivery(t *testing.T, endpointID string, opts deliveryOpts) string {
	t.Helper()
	if opts.status == "" {
		opts.status = "pending"
	}
	if opts.maxAttempts == 0 {
		opts.maxAttempts = 5
	}
	orgID, projectID := f.orgID, f.projectID
	if opts.orgID != "" {
		orgID = opts.orgID
	}
	if opts.projectID != "" {
		projectID = opts.projectID
	}

	var by, until any
	if opts.lockedBy != "" {
		by = opts.lockedBy
		until = time.Now().Add(opts.lockedUntil).UTC()
	}

	id := ids.New(ids.Delivery)
	mustExec(t, f.pool, `INSERT INTO deliveries
	                       (id, event_id, endpoint_id, organization_id, project_id, status,
	                        attempt_count, max_attempts, next_attempt_at, locked_by, locked_until,
	                        created_at, updated_at)
	                     VALUES ($1, $2, $3, $4, $5, $6::text::"DeliveryStatus", $7, $8,
	                             now() + make_interval(secs => $9), $10, $11, now(), now())`,
		id, f.newEvent(t), endpointID, orgID, projectID, opts.status,
		opts.attemptCount, opts.maxAttempts, opts.due.Seconds(), by, until)
	return id
}

// expireLease is how a worker "dies": it stops renewing, so its lease lapses.
// Moving locked_until into the past is the state that produces, without waiting
// out a real lease.
func expireLease(t *testing.T, pool *pgxpool.Pool, deliveryID string) {
	t.Helper()
	mustExec(t, pool,
		`UPDATE deliveries SET locked_until = now() - interval '1 second' WHERE id = $1`, deliveryID)
}

// makeDue pulls a delivery's next_attempt_at into the past, standing in for the
// passage of time so no test has to sleep out a backoff.
func makeDue(t *testing.T, pool *pgxpool.Pool, deliveryID string) {
	t.Helper()
	mustExec(t, pool,
		`UPDATE deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, deliveryID)
}

// ---------------------------------------------------------------------------
// reading state back
// ---------------------------------------------------------------------------

type deliveryState struct {
	Status        string
	AttemptCount  int
	MaxAttempts   int
	NextAttemptAt *time.Time
	LockedBy      *string
	LockedUntil   *time.Time
	LastError     *string
	CompletedAt   *time.Time
}

func readDelivery(t *testing.T, pool *pgxpool.Pool, id string) deliveryState {
	t.Helper()
	var d deliveryState
	err := pool.QueryRow(context.Background(),
		`SELECT status::text, attempt_count, max_attempts, next_attempt_at,
		        locked_by, locked_until, last_error, completed_at
		   FROM deliveries WHERE id = $1`, id).
		Scan(&d.Status, &d.AttemptCount, &d.MaxAttempts, &d.NextAttemptAt,
			&d.LockedBy, &d.LockedUntil, &d.LastError, &d.CompletedAt)
	if err != nil {
		t.Fatalf("read delivery %s: %v", id, err)
	}
	return d
}

type attemptRow struct {
	Number       int
	Status       string
	HTTPStatus   *int
	ErrorCode    *string
	ErrorMessage *string
	WorkerID     *string
}

func readAttempts(t *testing.T, pool *pgxpool.Pool, deliveryID string) []attemptRow {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT attempt_number, status::text, http_status, error_code, error_message, worker_id
		   FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number, started_at`, deliveryID)
	if err != nil {
		t.Fatalf("read attempts: %v", err)
	}
	defer rows.Close()
	var out []attemptRow
	for rows.Next() {
		var a attemptRow
		if err := rows.Scan(&a.Number, &a.Status, &a.HTTPStatus, &a.ErrorCode, &a.ErrorMessage, &a.WorkerID); err != nil {
			t.Fatalf("scan attempt: %v", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate attempts: %v", err)
	}
	return out
}

func readHealth(t *testing.T, pool *pgxpool.Pool, endpointID string) (state string, failures, successes int, probeAfter *time.Time, found bool) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT state::text, consecutive_failures, consecutive_successes, probe_after
		   FROM endpoint_health WHERE endpoint_id = $1`, endpointID).
		Scan(&state, &failures, &successes, &probeAfter)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return "", 0, 0, nil, false
		}
		t.Fatalf("read endpoint health: %v", err)
	}
	return state, failures, successes, probeAfter, true
}

// dbNow reads the SERVER clock. Every scheduling comparison in the data plane
// happens between two values PostgreSQL produced (advanceSQL writes
// `now() + interval`, the claim predicate compares against `now()`), so an
// assertion about next_attempt_at must use the same clock or it is measuring
// the gap between two machines.
func dbNow(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	var now time.Time
	if err := pool.QueryRow(context.Background(), `SELECT now()`).Scan(&now); err != nil {
		t.Fatalf("read database clock: %v", err)
	}
	return now
}

// ---------------------------------------------------------------------------
// polling helpers
// ---------------------------------------------------------------------------

// eventually polls cond until it holds or the deadline passes. Every wait in
// this suite goes through it rather than through a bare sleep: a sleep long
// enough to be reliable on a loaded CI box makes the suite slow, and a short
// one makes it flaky.
func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}

// ---------------------------------------------------------------------------
// endpoints under test
// ---------------------------------------------------------------------------

// testEndpoint is a customer's webhook receiver, with the behaviours the
// scenarios need: a status code, an optional delay, an optional block until
// released, and a count of what it actually received. The count is the whole
// point in the at-least-once scenarios: it is how "the endpoint saw this twice"
// stops being a claim and becomes an assertion.
type testEndpoint struct {
	server *httptest.Server

	mu       sync.Mutex
	status   int
	headers  map[string]string
	delay    time.Duration
	block    chan struct{}
	received chan struct{}

	requests atomic.Int64
}

func newTestEndpoint(t *testing.T) *testEndpoint {
	t.Helper()
	e := &testEndpoint{
		status:   http.StatusOK,
		received: make(chan struct{}, 64),
	}
	e.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		e.requests.Add(1)
		select {
		case e.received <- struct{}{}:
		default:
		}

		e.mu.Lock()
		status, delay, block, headers := e.status, e.delay, e.block, e.headers
		e.mu.Unlock()

		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return
			}
		}
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(e.server.Close)
	return e
}

func (e *testEndpoint) URL() string { return e.server.URL + "/hook" }

func (e *testEndpoint) Requests() int { return int(e.requests.Load()) }

func (e *testEndpoint) setStatus(status int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.status = status
}

func (e *testEndpoint) setHeaders(h map[string]string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.headers = h
}

func (e *testEndpoint) setDelay(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.delay = d
}

// blockUntil makes the endpoint hold every request open until the returned func
// is called. It is how "the worker died with a request in flight" is staged.
func (e *testEndpoint) blockUntil() func() {
	ch := make(chan struct{})
	e.mu.Lock()
	e.block = ch
	e.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			e.mu.Lock()
			e.block = nil
			e.mu.Unlock()
			close(ch)
		})
	}
}

// waitForRequest blocks until the endpoint has served (or begun serving) one
// more request.
func (e *testEndpoint) waitForRequest(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-e.received:
	case <-time.After(timeout):
		t.Fatalf("the endpoint never received a request within %s", timeout)
	}
}

// ---------------------------------------------------------------------------
// worker rig
// ---------------------------------------------------------------------------

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// egressClient is the REAL egress client, with the private-network guard opened
// so it can reach an httptest server on 127.0.0.1. Everything else - the
// per-phase timeouts, the bounded body read, the redirect refusal - is exactly
// what production runs, because the point of this suite is to test the system
// as built.
func egressClient() *egress.Client {
	guard, err := egress.NewGuard(true, nil)
	if err != nil {
		panic(err)
	}
	return egress.NewClient(guard, egress.Limits{
		DNSTimeout:            2 * time.Second,
		ConnectTimeout:        2 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		TotalTimeout:          20 * time.Second,
		MaxResponseBytes:      64 << 10,
		MaxRedirects:          0,
		IdleConnsPerHost:      4,
	})
}

type rigOpts struct {
	workerID    string
	store       worker.Store
	client      worker.HTTPDoer
	keeper      *queue.LeaseKeeper
	queue       queue.Queue
	breaker     worker.BreakerConfig
	lease       time.Duration
	poll        time.Duration
	concurrency int
}

type rig struct {
	worker *worker.Worker
	queue  queue.Queue
	keeper *queue.LeaseKeeper
	store  worker.Store
	id     string
}

// newRig builds a real worker.Worker over the real PostgreSQL store and queue.
// Anything a scenario needs to subvert - the store, the HTTP client, the lease
// keeper - is injected, so the worker itself is never a test double.
func newRig(t *testing.T, pool *pgxpool.Pool, opts rigOpts) *rig {
	t.Helper()
	if opts.workerID == "" {
		opts.workerID = ids.New(ids.Worker)
	}
	if opts.lease == 0 {
		opts.lease = 30 * time.Second
	}
	if opts.poll == 0 {
		opts.poll = 25 * time.Millisecond
	}
	if opts.concurrency == 0 {
		opts.concurrency = 1
	}
	q := opts.queue
	if q == nil {
		q = queue.NewPostgresQueue(pool, queue.StrategyFIFO)
	}
	pgStore := worker.NewPostgresStore(pool)
	store := opts.store
	if store == nil {
		store = pgStore
	}
	client := opts.client
	if client == nil {
		client = egressClient()
	}
	keeper := opts.keeper
	if keeper == nil {
		keeper = queue.NewLeaseKeeper(q, opts.workerID, opts.lease, discardLogger())
	}

	w, err := worker.New(worker.Options{
		Queue:        q,
		Store:        store,
		Health:       pgStore,
		Client:       client,
		Keyring:      testKeyring(t),
		Keeper:       keeper,
		Breaker:      opts.breaker,
		WorkerID:     opts.workerID,
		Concurrency:  opts.concurrency,
		ClaimBatch:   opts.concurrency,
		PollInterval: opts.poll,
		Lease:        opts.lease,
		DBTimeout:    5 * time.Second,
		Logger:       discardLogger(),
		Seed:         1,
		Limits: worker.GateLimits{
			Global:   opts.concurrency,
			Org:      opts.concurrency,
			Project:  opts.concurrency,
			Endpoint: opts.concurrency,
		},
	})
	if err != nil {
		t.Fatalf("build worker: %v", err)
	}
	return &rig{worker: w, queue: q, keeper: keeper, store: store, id: opts.workerID}
}

// start runs the worker until the returned stop func is called. stop is
// idempotent and waits for the drain, so a test that has stopped a worker can
// safely assert on rows that worker was touching.
func (r *rig) start(t *testing.T) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = r.worker.Run(ctx)
	}()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			select {
			case <-done:
			case <-time.After(worker.DrainTimeout + 5*time.Second):
				t.Error("worker did not stop within the drain window")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

// newDeliveries bulk-inserts n ready deliveries and their events in two
// statements. The burst scenarios need a backlog large enough to span several
// claim batches, and a row-at-a-time fixture spends more time seeding than
// testing.
func (f *fixture) newDeliveries(t *testing.T, endpointID string, n int, due time.Duration) []string {
	t.Helper()
	eventIDs := make([]string, n)
	deliveryIDs := make([]string, n)
	for i := 0; i < n; i++ {
		eventIDs[i] = ids.New(ids.Event)
		deliveryIDs[i] = ids.New(ids.Delivery)
	}
	mustExec(t, f.pool, `INSERT INTO events
	                       (id, organization_id, project_id, event_type, payload, payload_raw,
	                        payload_size, payload_hash, status, created_at)
	                     SELECT x.id, $2, $3, 'order.created', $4::jsonb, $5::bytea, $6, $7, 'received', now()
	                       FROM unnest($1::text[]) AS x(id)`,
		eventIDs, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload), f.payloadHash)
	mustExec(t, f.pool, `INSERT INTO deliveries
	                       (id, event_id, endpoint_id, organization_id, project_id, status,
	                        attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
	                     SELECT d.id, d.event_id, $3, $4, $5, 'pending'::"DeliveryStatus", 0, 5,
	                            now() + make_interval(secs => $6), now(), now()
	                       FROM unnest($1::text[], $2::text[]) AS d(id, event_id)`,
		deliveryIDs, eventIDs, endpointID, f.orgID, f.projectID, due.Seconds())
	return deliveryIDs
}
