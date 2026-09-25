package ingest

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// These tests exercise the real SQL against a migrated database. They are the
// only place column-name drift between this package and Prisma's schema is
// caught, so they skip rather than fail when there is no database to talk to.
//
// The pool points at THIS PACKAGE'S OWN database, copied from the migrated
// DATABASE_URL one by testsupport. Nothing here has to clean up after another
// package, and nothing here can damage one.
func requirePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testsupport.Pool(t)
}

// seedProject creates an organisation, project and API key, and removes them
// afterwards. Deleting the organisation cascades to everything below it.
func seedProject(t *testing.T, pool *pgxpool.Pool) (orgID, projectID, keyID, plaintextKey string) {
	t.Helper()
	ctx := context.Background()
	orgID = ids.New(ids.Organization)
	projectID = ids.New(ids.Project)
	keyID = ids.New(ids.APIKey)
	suffix, err := ids.Token(16)
	if err != nil {
		t.Fatal(err)
	}
	plaintextKey = "wk_test_" + suffix

	if _, err := pool.Exec(ctx,
		`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
		 VALUES ($1, 'ingest test', $2, 'active', now(), now())`,
		orgID, "ingest-test-"+suffix[:8]); err != nil {
		t.Fatalf("seed organization: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
	})

	if _, err := pool.Exec(ctx,
		`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
		 VALUES ($1, $2, 'ingest test', $3, 'test', 'active', now(), now())`,
		projectID, orgID, "ingest-test-"+suffix[:8]); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix, scopes, environment, created_at, updated_at)
		 VALUES ($1, $2, 'ingest test', $3, $4, ARRAY['events:write'], 'test', now(), now())`,
		keyID, projectID, HashKey(plaintextKey), KeyPrefix(plaintextKey)); err != nil {
		t.Fatalf("seed api key: %v", err)
	}
	return orgID, projectID, keyID, plaintextKey
}

func TestPostgresFindAPIKey(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	orgID, projectID, keyID, plaintextKey := seedProject(t, pool)

	rec, err := store.FindAPIKey(ctx, HashKey(plaintextKey))
	if err != nil {
		t.Fatalf("FindAPIKey: %v", err)
	}
	if rec.ID != keyID || rec.ProjectID != projectID || rec.OrganizationID != orgID {
		t.Fatalf("resolved the wrong row: %+v", rec)
	}
	if rec.KeyEnvironment != "test" || rec.ProjectEnvironment != "test" || rec.ProjectStatus != "active" {
		t.Fatalf("enum columns did not decode: %+v", rec)
	}

	if _, err := store.FindAPIKey(ctx, HashKey("wk_test_definitely-not-a-real-key")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key error = %v, want ErrNotFound", err)
	}
}

func TestPostgresCreateEventWritesEventAndOutboxTogether(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	orgID, projectID, _, _ := seedProject(t, pool)
	body := []byte(`{ "event_type":"order.created", "data":{"b":1,"a":2} }`)
	eventID := ids.New(ids.Event)

	created, err := store.CreateEvent(ctx, CreateEventParams{
		EventID:              eventID,
		OrganizationID:       orgID,
		ProjectID:            projectID,
		EventType:            "order.created",
		IdempotencyKey:       "order_123_created_v1",
		Payload:              body,
		PayloadSize:          len(body),
		PayloadHash:          HashPayload(body),
		Headers:              []byte(`{"ordering_key":"customer_123"}`),
		RequestHash:          HashPayload(body),
		IdempotencyExpiresAt: time.Now().Add(DefaultIdempotencyTTL),
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if !created {
		t.Fatal("first insert reported a conflict")
	}

	var (
		status      string
		payloadHash string
	)
	if err := pool.QueryRow(ctx,
		`SELECT status::text, payload_hash FROM events WHERE id = $1`, eventID,
	).Scan(&status, &payloadHash); err != nil {
		t.Fatalf("read back event: %v", err)
	}
	if status != "received" || payloadHash != HashPayload(body) {
		t.Fatalf("event = %s/%s", status, payloadHash)
	}

	// The outbox row is the point of the transaction: no event without one.
	var outboxStatus, outboxType string
	if err := pool.QueryRow(ctx,
		`SELECT status::text, type FROM event_outbox WHERE event_id = $1`, eventID,
	).Scan(&outboxStatus, &outboxType); err != nil {
		t.Fatalf("read back outbox row: %v", err)
	}
	if outboxStatus != "pending" || outboxType != "event.created" {
		t.Fatalf("outbox = %s/%s", outboxStatus, outboxType)
	}

	// A second claim on a live key writes nothing at all.
	second := ids.New(ids.Event)
	created, err = store.CreateEvent(ctx, CreateEventParams{
		EventID:              second,
		OrganizationID:       orgID,
		ProjectID:            projectID,
		EventType:            "order.created",
		IdempotencyKey:       "order_123_created_v1",
		Payload:              body,
		PayloadSize:          len(body),
		PayloadHash:          HashPayload(body),
		RequestHash:          HashPayload(body),
		IdempotencyExpiresAt: time.Now().Add(DefaultIdempotencyTTL),
	})
	if err != nil {
		t.Fatalf("second CreateEvent: %v", err)
	}
	if created {
		t.Fatal("a live idempotency key was overwritten")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM events WHERE id = $1`, second).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("the losing request still wrote an event")
	}

	rec, err := store.FindIdempotency(ctx, projectID, "order_123_created_v1")
	if err != nil {
		t.Fatalf("FindIdempotency: %v", err)
	}
	if rec.EventID != eventID {
		t.Fatalf("idempotency record points at %s, want %s", rec.EventID, eventID)
	}
	if Decide(rec, HashPayload(body), time.Now()) != DecideReplay {
		t.Fatal("a stored record with the same hash must replay")
	}
}

func TestPostgresExpiredIdempotencyKeyIsTakenOver(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	orgID, projectID, _, _ := seedProject(t, pool)
	body := []byte(`{"event_type":"order.created","data":{}}`)

	first := ids.New(ids.Event)
	if _, err := store.CreateEvent(ctx, CreateEventParams{
		EventID: first, OrganizationID: orgID, ProjectID: projectID,
		EventType: "order.created", IdempotencyKey: "k1",
		Payload: body, PayloadSize: len(body), PayloadHash: HashPayload(body),
		RequestHash:          HashPayload(body),
		IdempotencyExpiresAt: time.Now().Add(-time.Minute), // already expired
	}); err != nil {
		t.Fatalf("first CreateEvent: %v", err)
	}

	second := ids.New(ids.Event)
	created, err := store.CreateEvent(ctx, CreateEventParams{
		EventID: second, OrganizationID: orgID, ProjectID: projectID,
		EventType: "order.created", IdempotencyKey: "k1",
		Payload: body, PayloadSize: len(body), PayloadHash: HashPayload(body),
		RequestHash:          HashPayload(body),
		IdempotencyExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("second CreateEvent: %v", err)
	}
	if !created {
		t.Fatal("an expired idempotency key blocked reuse")
	}
	rec, err := store.FindIdempotency(ctx, projectID, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.EventID != second {
		t.Fatalf("record points at %s, want the newer event %s", rec.EventID, second)
	}
}

func TestPostgresTouchAPIKey(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	_, _, keyID, _ := seedProject(t, pool)
	if err := store.TouchAPIKey(ctx, keyID); err != nil {
		t.Fatalf("TouchAPIKey: %v", err)
	}
	var lastUsed *time.Time
	if err := pool.QueryRow(ctx, `SELECT last_used_at FROM api_keys WHERE id = $1`, keyID).Scan(&lastUsed); err != nil {
		t.Fatal(err)
	}
	if lastUsed == nil {
		t.Fatal("last_used_at was not recorded")
	}
}

// The signing invariant (ARCHITECTURE.md 28), asserted against a real database.
//
// events.payload is jsonb, which does not preserve whitespace, key order or
// duplicate keys, so the bytes read back out of it are NOT the bytes received
// and a signature over them cannot verify. events.payload_raw is the
// authoritative bytea copy; this test is what catches it silently going away.
func TestPostgresCreateEventPreservesRawPayloadBytes(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	orgID, projectID, _, _ := seedProject(t, pool)

	// Everything jsonb normalises: insignificant whitespace, key order, and a
	// duplicate key (jsonb keeps the last one).
	body := []byte("{\n  \"event_type\" : \"order.created\",\n  \"data\" : {\"z\":1, \"a\":2, \"a\":3}\n}")
	eventID := ids.New(ids.Event)

	created, err := store.CreateEvent(ctx, CreateEventParams{
		EventID:        eventID,
		OrganizationID: orgID,
		ProjectID:      projectID,
		EventType:      "order.created",
		Payload:        body,
		PayloadSize:    len(body),
		PayloadHash:    HashPayload(body),
	})
	if err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}
	if !created {
		t.Fatal("insert reported a conflict")
	}

	var (
		raw         []byte
		projection  string
		payloadHash string
	)
	if err := pool.QueryRow(ctx,
		`SELECT payload_raw, payload::text, payload_hash FROM events WHERE id = $1`, eventID,
	).Scan(&raw, &projection, &payloadHash); err != nil {
		t.Fatalf("read back event: %v", err)
	}

	if !bytes.Equal(raw, body) {
		t.Fatalf("payload_raw = %q, want the exact request bytes %q", raw, body)
	}
	// This is the assertion a signing worker depends on: hash the column it
	// reads, get the hash that was recorded at ingest.
	if HashPayload(raw) != payloadHash {
		t.Fatal("HashPayload(payload_raw) != payload_hash: the stored bytes are not what was signed for")
	}
	// And the reason payload_raw has to exist: the jsonb column is a different
	// byte string for the same event.
	if projection == string(body) {
		t.Fatal("the jsonb projection matched the raw bytes; this fixture no longer proves normalisation, pick a nastier body")
	}
	if HashPayload([]byte(projection)) == payloadHash {
		t.Fatal("unexpected: the jsonb round trip hashed equal, the fixture is no longer exercising the defect")
	}
}

// An offloaded payload writes neither column: the bytes live in object storage
// and payload_location points at them.
func TestPostgresCreateEventLeavesPayloadNullWhenOffloaded(t *testing.T) {
	pool := requirePool(t)
	store := NewPostgresStore(pool)
	ctx := context.Background()

	orgID, projectID, _, _ := seedProject(t, pool)
	eventID := ids.New(ids.Event)
	body := []byte(`{"event_type":"order.created","data":{}}`)

	if _, err := store.CreateEvent(ctx, CreateEventParams{
		EventID:         eventID,
		OrganizationID:  orgID,
		ProjectID:       projectID,
		EventType:       "order.created",
		PayloadLocation: "s3://bucket/" + projectID + "/" + eventID,
		PayloadSize:     len(body),
		PayloadHash:     HashPayload(body),
	}); err != nil {
		t.Fatalf("CreateEvent: %v", err)
	}

	var (
		raw      []byte
		location *string
	)
	if err := pool.QueryRow(ctx,
		`SELECT payload_raw, payload_location FROM events WHERE id = $1`, eventID,
	).Scan(&raw, &location); err != nil {
		t.Fatalf("read back event: %v", err)
	}
	if raw != nil {
		t.Fatalf("payload_raw = %q, want NULL for an offloaded payload", raw)
	}
	if location == nil || *location == "" {
		t.Fatal("payload_location was not recorded")
	}
}
