package failure_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/router"
	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
)

// ---------------------------------------------------------------------------
// crash injection
// ---------------------------------------------------------------------------

type crashKey struct{}

// crashTracer kills the ingest process at a chosen statement boundary.
//
// A literal kill -9 is not available to a test, and forking one would prove
// nothing extra: what a killed process does to PostgreSQL is drop its
// connection with a transaction open, and an abandoned context does exactly
// that. The tracer waits until the named statement has SUCCEEDED on the server
// and only then cancels, so the crash lands in the one window that matters -
// after both writes, before COMMIT.
type crashTracer struct {
	match  string
	cancel atomic.Pointer[context.CancelFunc]
	fired  atomic.Bool
}

func (c *crashTracer) arm(cancel context.CancelFunc) {
	c.cancel.Store(&cancel)
	c.fired.Store(false)
}

func (c *crashTracer) TraceQueryStart(
	ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, c.match) {
		return context.WithValue(ctx, crashKey{}, true)
	}
	return ctx
}

func (c *crashTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(crashKey{}) == nil || c.fired.Swap(true) {
		return
	}
	if cancel := c.cancel.Load(); cancel != nil {
		(*cancel)()
	}
}

// crashingPool is a pool whose connections carry the tracer.
func crashingPool(t *testing.T, tracer *crashTracer) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(testsupport.DSN(t))
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("open crashing pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// ---------------------------------------------------------------------------
// ingest fixture
// ---------------------------------------------------------------------------

// seedAPIKey adds an API key to the fixture's project so the tests below can
// drive the REAL handler rather than calling the store directly. It matters:
// scenario 1's promise is about what a CLIENT sees and may safely retry, and
// the retry semantics live in the handler's idempotency step, not in the store.
func (f *fixture) seedAPIKey(t *testing.T) string {
	t.Helper()
	suffix, err := ids.Token(16)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := "wk_test_" + suffix
	mustExec(t, f.pool, `INSERT INTO api_keys
	                       (id, project_id, name, key_hash, key_prefix, scopes, environment, created_at, updated_at)
	                     VALUES ($1, $2, 'failure test', $3, $4, ARRAY['events:write'], 'test', now(), now())`,
		ids.New(ids.APIKey), f.projectID, ingest.HashKey(plaintext), ingest.KeyPrefix(plaintext))
	return plaintext
}

func newIngestHandler(store ingest.Store) *ingest.Handler {
	return ingest.New(ingest.Options{
		Store:  store,
		Limits: ingest.PayloadLimits{InlineMax: 1 << 20, Max: 1 << 20},
		Logger: discardLogger(),
	})
}

func ingestRequest(ctx context.Context, projectID, apiKey, idempotencyKey, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+projectID+"/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return req.WithContext(ctx)
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count (%.60q): %v", sql, err)
	}
	return n
}

// ---------------------------------------------------------------------------
// scenario 1
// ---------------------------------------------------------------------------

// TestScenario01_IngestCrashesBeforeCommit covers ARCHITECTURE.md 57 case 1.
//
// Scenario: the ingest process dies after writing the idempotency claim, the
// event and the outbox row, but before COMMIT.
//
// Recovery strategy asserted: all three writes are one transaction, so the
// crash leaves NOTHING - no event, no outbox row, no delivery, and crucially no
// idempotency claim. The client got no 202, so it retries with the same
// idempotency key, and that retry must succeed rather than collide with a
// half-written claim from the attempt that died.
//
// What a regression looks like in production: move any of those three writes
// out of the transaction - most plausibly the idempotency claim, "so we can
// check it earlier" - and a crashed ingest leaves a claim pointing at an event
// that does not exist. Every retry with that key then replays a phantom event
// id, and the customer's webhook is never delivered while the API reports
// success.
func TestScenario01_IngestCrashesBeforeCommit(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)
	apiKey := f.seedAPIKey(t)

	tracer := &crashTracer{match: "INSERT INTO event_outbox"}
	crashPool := crashingPool(t, tracer)

	const idemKey = "scenario-01-key"
	const body = `{"event_type":"order.created","data":{"id":1}}`

	// --- the crash -------------------------------------------------------
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracer.arm(cancel)

	rec := httptest.NewRecorder()
	newIngestHandler(ingest.NewPostgresStore(crashPool)).
		ServeHTTP(rec, ingestRequest(ctx, f.projectID, apiKey, idemKey, body))

	if !tracer.fired.Load() {
		t.Fatal("the crash never fired: the outbox insert was never reached, so this test proved nothing")
	}
	if rec.Code == http.StatusAccepted {
		t.Fatalf("ingest answered 202 for a transaction that never committed: a 202 means durably recoverable")
	}

	// --- nothing is durable ----------------------------------------------
	if n := countRows(t, pool,
		`SELECT count(*) FROM events WHERE project_id = $1`, f.projectID); n != 0 {
		t.Fatalf("events written by the crashed transaction = %d, want 0", n)
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM event_outbox o JOIN events e ON e.id = o.event_id WHERE e.project_id = $1`,
		f.projectID); n != 0 {
		t.Fatalf("outbox rows written by the crashed transaction = %d, want 0", n)
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM deliveries WHERE project_id = $1`, f.projectID); n != 0 {
		t.Fatalf("deliveries written by the crashed transaction = %d, want 0", n)
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM idempotency_keys WHERE project_id = $1 AND "key" = $2`,
		f.projectID, idemKey); n != 0 {
		t.Fatalf("idempotency claims left behind = %d, want 0; a claim that outlives its transaction "+
			"permanently poisons that key", n)
	}

	// --- the client retries with the same key ----------------------------
	retry := httptest.NewRecorder()
	newIngestHandler(ingest.NewPostgresStore(pool)).
		ServeHTTP(retry, ingestRequest(context.Background(), f.projectID, apiKey, idemKey, body))

	if retry.Code != http.StatusAccepted {
		t.Fatalf("retry with the same idempotency key = %d %s, want 202", retry.Code, retry.Body.String())
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM events WHERE project_id = $1`, f.projectID); n != 1 {
		t.Fatalf("events after the retry = %d, want exactly 1", n)
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM event_outbox o JOIN events e ON e.id = o.event_id WHERE e.project_id = $1`,
		f.projectID); n != 1 {
		t.Fatalf("outbox rows after the retry = %d, want exactly 1", n)
	}
}

// ---------------------------------------------------------------------------
// scenario 2
// ---------------------------------------------------------------------------

// TestScenario02_IngestCrashesAfterCommit covers ARCHITECTURE.md 57 case 2, and
// it is the whole justification for the transactional outbox.
//
// Scenario: ingest COMMITs the event and its outbox row, then the process dies
// before it can tell anyone - no response to the client, no notification, no
// enqueue.
//
// Recovery strategy asserted: the outbox row IS the notification. The ingest
// process is killed outright (its pool is closed and never used again) and the
// router, running on its own connections, still claims the row and materialises
// the fan-out. Nothing in the delivery path needs ingest to be alive.
//
// What a regression looks like in production: publish to the queue from ingest
// after COMMIT - "the outbox poll is slow, let's push directly" - and every
// event accepted in the seconds before a deploy, an OOM kill or a spot-instance
// reclaim is committed, acknowledged and never delivered. It is invisible: the
// events table says `received` and no delivery row was ever created to notice.
func TestScenario02_IngestCrashesAfterCommit(t *testing.T) {
	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)
	apiKey := f.seedAPIKey(t)

	endpointID := f.newEndpoint(t, endpointOpts{noSecret: true})
	f.newSubscription(t, endpointID, []string{"order.created"})

	// The "ingest process": its own connections, closed the instant it has
	// committed. Anything the router needs from ingest after this point would
	// show up as a failure rather than as a delay.
	ingestPool := separatePool(t)

	rec := httptest.NewRecorder()
	newIngestHandler(ingest.NewPostgresStore(ingestPool)).
		ServeHTTP(rec, ingestRequest(context.Background(), f.projectID, apiKey, "scenario-02-key",
			`{"event_type":"order.created","data":{"id":2}}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("ingest = %d %s, want 202", rec.Code, rec.Body.String())
	}
	ingestPool.Close() // the process is gone

	var eventID string
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM events WHERE project_id = $1`, f.projectID).Scan(&eventID); err != nil {
		t.Fatalf("the committed event is not there: %v", err)
	}

	// --- the router, with no ingest involvement whatsoever ----------------
	r, err := router.New(router.Options{
		Store:    router.NewPostgresStore(pool),
		RouterID: "rtr_scenario_02",
		Logger:   discardLogger(),
	})
	if err != nil {
		t.Fatalf("build router: %v", err)
	}
	processed, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if processed != 1 {
		t.Fatalf("router processed %d outbox rows, want 1: the committed row must be picked up "+
			"without any help from the process that wrote it", processed)
	}

	var status string
	var deliveryEndpoint string
	if err := pool.QueryRow(context.Background(),
		`SELECT status::text, endpoint_id FROM deliveries WHERE event_id = $1`, eventID).
		Scan(&status, &deliveryEndpoint); err != nil {
		t.Fatalf("no delivery was materialised for the committed event: %v", err)
	}
	if deliveryEndpoint != endpointID {
		t.Fatalf("delivery went to endpoint %s, want %s", deliveryEndpoint, endpointID)
	}
	if status != "pending" {
		t.Fatalf("delivery status = %q, want pending", status)
	}

	var outboxStatus string
	var processedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT status::text, processed_at FROM event_outbox WHERE event_id = $1`, eventID).
		Scan(&outboxStatus, &processedAt); err != nil {
		t.Fatalf("read outbox row: %v", err)
	}
	if outboxStatus != "processed" || processedAt == nil {
		t.Fatalf("outbox row = %q processed_at=%v, want processed with a timestamp", outboxStatus, processedAt)
	}
}
