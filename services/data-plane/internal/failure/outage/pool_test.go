package outage_test

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/db"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// TestScenario18_ConnectionPoolExhausted_DegradesInsteadOfLying covers
// ARCHITECTURE.md 57 scenario 18: the database connection pool is exhausted.
//
// The injection is the honest one - a pool of exactly one connection with that
// connection checked out and held - so the accept path meets a real
// pgxpool.Acquire that cannot be satisfied, not a fake error.
//
// Recovery strategy asserted: waiting requests are BOUNDED by the accept
// path's own deadline (ingest.DefaultDBTimeout, INGEST_DB_TIMEOUT_MS) and are
// refused with a 5xx. They do not hang until the client gives up, they do not
// return 202 for an event that was never written, and the pool is fully usable
// again the moment the connection is released - no restart, no leaked
// connection, no poisoned state.
//
// A production regression would look like: Acquire called with a context that
// carries no deadline, so every request queues behind the stuck one until the
// process is out of goroutines and shutdown can no longer drain; or an accept
// that treats "could not get a connection" as "key not found" and answers 401,
// which sends a customer to support instead of to a retry.
func TestScenario18_ConnectionPoolExhausted_DegradesInsteadOfLying(t *testing.T) {
	dsn := testsupport.DSN(t)
	truth := directPool(t)
	seed := seedTenant(t, truth)

	// One connection, and db.Open is the production constructor - the same
	// MaxConns/statement_timeout wiring webhookd uses.
	pool, err := db.Open(context.Background(), dsn, 1, 5*time.Second)
	if err != nil {
		t.Fatalf("open the single-connection pool: %v", err)
	}
	defer pool.Close()

	handler := ingest.New(ingest.Options{
		Store:     ingest.NewPostgresStore(pool),
		Limits:    generousPayloadLimits(),
		DBTimeout: databaseTimeout,
		Logger:    slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	// Baseline while the pool is free.
	rec := postEvent(t, handler, seed.projectID, seed.apiKey, idempotencyKey(t), eventBody)
	requireStatus(t, rec, http.StatusAccepted)

	// Exhaust it: hold the one connection for the duration of the next accept.
	held, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatalf("acquire the only connection: %v", err)
	}
	if got := pool.Stat().AcquiredConns(); got != 1 {
		t.Fatalf("acquired connections = %d, want 1; the pool is not actually exhausted", got)
	}

	key := idempotencyKey(t)
	started := time.Now()
	rec = postEvent(t, handler, seed.projectID, seed.apiKey, key, eventBody)
	elapsed := time.Since(started)

	if rec.Code == http.StatusAccepted {
		held.Release()
		t.Fatal("ingest returned 202 while no connection could be acquired: nothing was committed")
	}
	if rec.Code < 500 || rec.Code > 599 {
		held.Release()
		t.Fatalf("status = %d under pool exhaustion, want 5xx; a 4xx (in particular a 401 from a timed-out "+
			"api_keys lookup) blames the caller for our saturation", rec.Code)
	}
	if code := errorCodeOf(t, rec); code != ingest.CodeInternalError {
		held.Release()
		t.Fatalf("error code = %q, want %q", code, ingest.CodeInternalError)
	}
	// The point of the scenario: the wait is bounded, and by OUR deadline.
	if elapsed < databaseTimeout {
		held.Release()
		t.Fatalf("the request failed after %v, before the %v deadline: it did not wait for a connection at "+
			"all, which is a different (and worse) behaviour than queueing briefly", elapsed, databaseTimeout)
	}
	if elapsed > 4*databaseTimeout {
		held.Release()
		t.Fatalf("the request waited %v for a connection, more than 4x the %v deadline: Acquire is not "+
			"bounded by the accept path's context", elapsed, databaseTimeout)
	}
	if n := countIdempotencyClaims(t, truth, seed.projectID, key); n != 0 {
		held.Release()
		t.Fatalf("%d idempotency rows were written by a request that never got a connection", n)
	}

	// Release: the pool must be immediately usable again. A connection lost to
	// the timed-out request would leave MaxConns-1 forever.
	held.Release()

	rec = postEvent(t, handler, seed.projectID, seed.apiKey, key, eventBody)
	requireStatus(t, rec, http.StatusAccepted)
	accepted := acceptedIDOf(t, rec)
	if n := countEvents(t, truth, accepted); n != 1 {
		t.Fatalf("events rows after recovery = %d, want 1", n)
	}
	if got := pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("acquired connections = %d after the request finished, want 0: a connection leaked", got)
	}
}

// TestScenario18_ConnectionPoolExhausted_QueuesRatherThanCorrupts is the
// concurrency half of scenario 18: many accepts against a pool far too small
// for them.
//
// Recovery strategy asserted: every request is answered exactly once, with
// either a 202 that has a committed event behind it or a 5xx that has nothing
// behind it. There is no third outcome - no panic, no torn write, no 202
// without a row - and the pool ends the storm with every connection returned.
//
// A production regression would look like: a shared pgx connection used
// concurrently (which pgx detects and fails, but only after the write), or an
// accept that answers 202 from a partially-applied transaction under
// contention.
func TestScenario18_ConnectionPoolExhausted_QueuesRatherThanCorrupts(t *testing.T) {
	dsn := testsupport.DSN(t)
	truth := directPool(t)
	seed := seedTenant(t, truth)

	pool, err := db.Open(context.Background(), dsn, 2, 5*time.Second)
	if err != nil {
		t.Fatalf("open the two-connection pool: %v", err)
	}
	defer pool.Close()

	handler := ingest.New(ingest.Options{
		Store:  ingest.NewPostgresStore(pool),
		Limits: generousPayloadLimits(),
		// Generous on purpose: this test is about correctness under
		// contention, not about the deadline (which the test above pins).
		DBTimeout: 5 * time.Second,
		Logger:    slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelError})),
	})

	const concurrent = 24
	type result struct {
		status  int
		eventID string
	}
	results := make([]result, concurrent)
	keys := make([]string, concurrent)
	for i := range keys {
		keys[i] = idempotencyKey(t)
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < concurrent; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			rec := postEvent(t, handler, seed.projectID, seed.apiKey, keys[i], eventBody)
			results[i] = result{status: rec.Code}
			if rec.Code == http.StatusAccepted {
				var body ingest.AcceptedBody
				if err := jsonDecode(rec.Body.Bytes(), &body); err == nil {
					results[i].eventID = body.ID
				}
			}
		}(i)
	}
	close(start)
	wg.Wait()

	accepted := 0
	for i, r := range results {
		switch {
		case r.status == http.StatusAccepted:
			accepted++
			if r.eventID == "" {
				t.Fatalf("request %d returned 202 with no event id", i)
			}
			if n := countEvents(t, truth, r.eventID); n != 1 {
				t.Fatalf("request %d was accepted but has %d events rows: a 202 with nothing behind it", i, n)
			}
			if n := countOutbox(t, truth, r.eventID); n != 1 {
				t.Fatalf("request %d was accepted but has %d outbox rows: it would never be delivered", i, n)
			}
		case r.status >= 500:
			// A refusal under saturation is allowed. What is not allowed is a
			// refusal that left a claim behind, because that key can then
			// never be reused.
			if n := countIdempotencyClaims(t, truth, seed.projectID, keys[i]); n != 0 {
				t.Fatalf("request %d was refused with %d but left %d idempotency claims", i, r.status, n)
			}
		default:
			t.Fatalf("request %d = %d; under pool contention the only correct answers are 202 and 5xx", i, r.status)
		}
	}
	if accepted == 0 {
		t.Fatal("every request failed on a two-connection pool: this is starvation, not degradation")
	}
	t.Logf("accepted %d of %d concurrent requests through a 2-connection pool", accepted, concurrent)

	if got := pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("acquired connections = %d after the storm, want 0: connections leaked", got)
	}
}
