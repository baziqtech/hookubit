package outage_test

import (
	"context"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
)

// TestScenario08_PostgresUnavailable_NeverReturnsAFalseAccept covers
// ARCHITECTURE.md 57 scenario 8: PostgreSQL becomes unavailable.
//
// Recovery strategy asserted: ingest FAILS CLOSED. `202 accepted` is a promise
// that the event is durably recoverable from PostgreSQL alone (docs/API.md,
// ADR-0003), so an accept that could not commit must be a 5xx and must leave
// nothing behind. Once PostgreSQL returns, the SAME handler and the SAME pool
// recover without a restart, and the client's retry - carrying the idempotency
// key its failed request used - commits exactly one event.
//
// A production regression would look like: a 202 with no events row (the
// customer believes the webhook is on its way and it does not exist anywhere),
// or an ingest process that never recovers after a failover because its pool
// is full of dead connections, or a request that hangs for the whole of
// http.Server.WriteTimeout instead of failing inside INGEST_DB_TIMEOUT_MS.
func TestScenario08_PostgresUnavailable_NeverReturnsAFalseAccept(t *testing.T) {
	dsn := testsupport.DSN(t)
	truth := directPool(t)
	seed := seedTenant(t, truth)

	proxy := newTCPProxy(t, upstreamOf(t, dsn))
	pool := proxiedPool(t, proxy, dsn, 4)

	handler := ingest.New(ingest.Options{
		Store:     ingest.NewPostgresStore(pool),
		Limits:    generousPayloadLimits(),
		DBTimeout: databaseTimeout,
		Logger:    slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	// Healthy: the baseline. Without this the test could pass because the
	// fixture was wrong rather than because the outage was handled.
	rec := postEvent(t, handler, seed.projectID, seed.apiKey, idempotencyKey(t), eventBody)
	requireStatus(t, rec, http.StatusAccepted)
	if id := acceptedIDOf(t, rec); countEvents(t, truth, id) != 1 {
		t.Fatalf("healthy accept did not commit an events row")
	}

	// The outage.
	key := idempotencyKey(t)
	proxy.down()

	started := time.Now()
	rec = postEvent(t, handler, seed.projectID, seed.apiKey, key, eventBody)
	elapsed := time.Since(started)

	if rec.Code == http.StatusAccepted {
		t.Fatal("ingest returned 202 while PostgreSQL was unreachable: the event was never committed, " +
			"so `accepted` is a lie and the publisher will never retry it")
	}
	if rec.Code < 500 || rec.Code > 599 {
		t.Fatalf("status = %d during a database outage, want 5xx: a 4xx tells the publisher its request "+
			"was at fault and must not be retried", rec.Code)
	}
	if code := errorCodeOf(t, rec); code != ingest.CodeInternalError {
		t.Fatalf("error code = %q, want %q", code, ingest.CodeInternalError)
	}
	// Bounded by the ingest DB timeout, not by the client giving up. A request
	// that pins a goroutine and a pool connection until the socket dies is how
	// one database blip becomes an exhausted pool.
	if elapsed > 4*databaseTimeout {
		t.Fatalf("the rejected request took %v, more than 4x the %v DB timeout: the accept path is not "+
			"bounded by its own deadline", elapsed, databaseTimeout)
	}

	// Nothing was written. Checked through the DIRECT pool, which never went
	// through the relay, so this is the database's own account of the outage.
	if n := countIdempotencyClaims(t, truth, seed.projectID, key); n != 0 {
		t.Fatalf("%d idempotency rows exist for a request that was refused; a later retry with the same key "+
			"would be answered from a claim that has no event behind it", n)
	}

	// Recovery: the relay comes back on the same address, so the pool is
	// reconnecting to "the same server", exactly as it would after a restart or
	// a failover.
	proxy.up(t)

	var accepted string
	// pgxpool may hand out one connection that was severed while it was idle
	// before it notices; a client retrying an accept would see the same thing.
	// Two attempts, not a loop with no bound, so a pool that genuinely cannot
	// recover still fails the test.
	for attempt := 1; attempt <= 3; attempt++ {
		rec = postEvent(t, handler, seed.projectID, seed.apiKey, key, eventBody)
		if rec.Code == http.StatusAccepted {
			accepted = acceptedIDOf(t, rec)
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if accepted == "" {
		t.Fatalf("ingest never recovered after PostgreSQL returned; last status %d (%s)",
			rec.Code, rec.Body.String())
	}

	if n := countEvents(t, truth, accepted); n != 1 {
		t.Fatalf("events rows for the recovered accept = %d, want 1", n)
	}
	// The outbox row is the half that makes the accept deliverable. An event
	// committed without one is an event that is stored and never fanned out.
	if n := countOutbox(t, truth, accepted); n != 1 {
		t.Fatalf("event_outbox rows for the recovered accept = %d, want 1: the event would never be routed", n)
	}
	if n := countIdempotencyClaims(t, truth, seed.projectID, key); n != 1 {
		t.Fatalf("idempotency rows for the key = %d, want exactly 1", n)
	}
}

// TestScenario08_PostgresUnavailable_LeavesNoPartialWrite asserts the other
// half of the same scenario: an outage in the MIDDLE of the ingest transaction
// (after the idempotency claim, before COMMIT) leaves neither the claim nor the
// event, because both are in one transaction.
//
// The injection point is the transaction itself: the relay is closed while the
// statement is in flight, which is what a database that dies mid-COMMIT looks
// like to the client.
//
// A production regression would look like: an idempotency_keys row surviving a
// failed insert, after which every retry of that key is answered `conflict`
// forever and the event can never be published.
func TestScenario08_PostgresUnavailable_LeavesNoPartialWrite(t *testing.T) {
	dsn := testsupport.DSN(t)
	truth := directPool(t)
	seed := seedTenant(t, truth)

	proxy := newTCPProxy(t, upstreamOf(t, dsn))
	pool := proxiedPool(t, proxy, dsn, 2)
	store := ingest.NewPostgresStore(pool)

	body := []byte(eventBody)
	hash := ingest.HashPayload(body)

	// The injection is counted, not timed: the relay is told to sever the
	// connection after N further messages from the client, so the outage lands
	// between two statements of the ingest transaction rather than wherever a
	// sleep happens to fall. BEGIN, the idempotency claim, the event insert and
	// the outbox insert are four separate round trips, so one of these cuts is
	// inside the transaction whatever the driver batches.
	var (
		injected bool
		lastKey  string
		lastID   string
	)
	for _, cutAfter := range []int{2, 3, 1, 4} {
		key := idempotencyKey(t)
		eventID := ids.New(ids.Event)
		lastKey, lastID = key, eventID

		proxy.up(t)
		proxy.armCut(cutAfter)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		created, err := store.CreateEvent(ctx, ingest.CreateEventParams{
			EventID:              eventID,
			OrganizationID:       seed.orgID,
			ProjectID:            seed.projectID,
			EventType:            "order.created",
			IdempotencyKey:       key,
			Payload:              body,
			PayloadSize:          len(body),
			PayloadHash:          hash,
			RequestHash:          hash,
			IdempotencyExpiresAt: time.Now().Add(24 * time.Hour),
		})
		cancel()
		proxy.armCut(0)
		proxy.up(t)

		if err != nil {
			injected = true
			break
		}
		if !created {
			t.Fatal("CreateEvent reported neither an error nor a creation")
		}
		// It committed before the cut landed. That is a legitimate outcome of
		// this injection, not a bug - but the row must be complete, because a
		// reported success has to mean both halves are there.
		if n := countEvents(t, truth, eventID); n != 1 {
			t.Fatalf("CreateEvent returned success with %d events rows", n)
		}
		if n := countOutbox(t, truth, eventID); n != 1 {
			t.Fatalf("CreateEvent returned success with %d outbox rows: the event would never be routed", n)
		}
	}
	if !injected {
		t.Skip("every cut landed after COMMIT; nothing to assert about a partial write")
	}

	// The transaction failed. NOTHING it wrote may survive.
	if n := countEvents(t, truth, lastID); n != 0 {
		t.Fatalf("%d events rows exist for a transaction that failed: the ingest write is not atomic", n)
	}
	if n := countIdempotencyClaims(t, truth, seed.projectID, lastKey); n != 0 {
		t.Fatalf("%d idempotency claims survived a failed transaction; that key is now poisoned and every "+
			"retry of it conflicts forever", n)
	}
	if n := countOutbox(t, truth, lastID); n != 0 {
		t.Fatalf("%d outbox rows exist for an event that was never committed", n)
	}

	// And the same request, retried after recovery, commits cleanly - which is
	// the whole point of refusing rather than half-accepting.
	var created bool
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		created, err = store.CreateEvent(ctx, ingest.CreateEventParams{
			EventID:              lastID,
			OrganizationID:       seed.orgID,
			ProjectID:            seed.projectID,
			EventType:            "order.created",
			IdempotencyKey:       lastKey,
			Payload:              body,
			PayloadSize:          len(body),
			PayloadHash:          hash,
			RequestHash:          hash,
			IdempotencyExpiresAt: time.Now().Add(24 * time.Hour),
		})
		cancel()
		if err == nil {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("the retried write never succeeded after the database returned: %v", err)
	}
	if !created {
		t.Fatal("the retry was answered as a replay: a claim from the FAILED transaction is still in the " +
			"table, so the event can never be created")
	}
	if n := countOutbox(t, truth, lastID); n != 1 {
		t.Fatalf("outbox rows after the successful retry = %d, want 1", n)
	}
}
