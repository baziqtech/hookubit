package failure_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/router"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing/tracingtest"
)

// TestTraceContextSurvivesTheThreeProcessBoundaries is the whole point of this
// work, asserted end to end against a real PostgreSQL.
//
// A webhook's life crosses three asynchronous boundaries, each a database write
// and an arbitrary amount of time apart, on pods that never share memory:
//
//	ingest (COMMIT event + outbox row, 202)
//	  -> router (claim the outbox row, materialise the fan-out)
//	       -> worker (claim the delivery, sign, POST)
//
// Every unit test above can pass while the chain is broken, because each one
// hands the next stage a context IN GO. The only thing that proves the design
// works is reading back what was actually written to disk by one stage and
// picked up by the next, with nothing in common between them but the row.
//
// A production regression would look like: a column dropped from a RETURNING
// list, a parameter index shifted by an unrelated migration, or the router
// writing the ingest context instead of its own. All of them compile, all of
// them pass the unit tests, and all of them leave an operator with three
// unrelated traces and no way to get from one to the next.
func TestTraceContextSurvivesTheThreeProcessBoundaries(t *testing.T) {
	rec := tracingtest.Record(t)

	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)
	apiKey := f.seedAPIKey(t)

	endpointID := f.newEndpoint(t, endpointOpts{url: "https://example.invalid/hook"})
	f.newSubscription(t, endpointID, []string{"order.created"})

	// --- boundary 1: ingest commits the event, the outbox row and its context.
	resp := httptest.NewRecorder()
	newIngestHandler(ingest.NewPostgresStore(pool)).ServeHTTP(resp,
		ingestRequest(context.Background(), f.projectID, apiKey, "", `{"event_type":"order.created","data":{"id":1}}`))
	if resp.Code != http.StatusAccepted {
		t.Fatalf("ingest status = %d, want 202 (%s)", resp.Code, resp.Body.String())
	}

	ingestSpan := spanByName(t, rec, "ingest /v1/projects/{project_id}/events")

	var storedIngest string
	if err := pool.QueryRow(context.Background(),
		`SELECT COALESCE(o.trace_context, '') FROM event_outbox o
		   JOIN events e ON e.id = o.event_id
		  WHERE e.project_id = $1`, f.projectID).Scan(&storedIngest); err != nil {
		t.Fatalf("read event_outbox.trace_context: %v", err)
	}
	if storedIngest == "" {
		t.Fatal("event_outbox.trace_context is NULL after a traced ingest: the chain " +
			"is broken at the first boundary and every trace stops at the 202")
	}
	if want := tracing.EncodeSpanContext(ingestSpan.SpanContext()); storedIngest != want {
		t.Fatalf("event_outbox.trace_context = %q, want the ingest span's context %q",
			storedIngest, want)
	}

	// --- boundary 2: the router claims that row and stamps its OWN context on
	// every delivery it creates.
	r, err := router.New(router.Options{
		Store:                    router.NewPostgresStore(pool),
		RouterID:                 ids.New(ids.Worker),
		Logger:                   discardLogger(),
		BatchSize:                10,
		Concurrency:              1,
		MaxSubscriptionsPerEvent: 100,
	})
	if err != nil {
		t.Fatalf("build router: %v", err)
	}
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("router RunOnce: %v", err)
	}

	fanOut := spanByName(t, rec, "webhook.fan_out")

	// The fan-out is a LINKED ROOT, not a child. This is the assertion that
	// stops an ingest span's duration becoming "until the last retry gave up".
	if fanOut.Parent().IsValid() {
		t.Fatalf("the fan-out span has parent %s; it must be a new root", fanOut.Parent().SpanID())
	}
	if fanOut.SpanContext().TraceID() == ingestSpan.SpanContext().TraceID() {
		t.Fatal("the fan-out joined the ingest trace")
	}
	if !linksTo(fanOut, ingestSpan.SpanContext()) {
		t.Fatal("the fan-out span does not link back to the ingest span, so nothing " +
			"connects the 202 to the work it caused")
	}

	var deliveryID, storedRouter string
	if err := pool.QueryRow(context.Background(),
		`SELECT id, COALESCE(trace_context, '') FROM deliveries WHERE project_id = $1`,
		f.projectID).Scan(&deliveryID, &storedRouter); err != nil {
		t.Fatalf("read deliveries.trace_context: %v", err)
	}
	if storedRouter == "" {
		t.Fatal("deliveries.trace_context is NULL after a traced fan-out: the chain is " +
			"broken at the second boundary and the worker has nothing to link to")
	}
	if want := tracing.EncodeSpanContext(fanOut.SpanContext()); storedRouter != want {
		t.Fatalf("deliveries.trace_context = %q, want the fan-out span's own context %q",
			storedRouter, want)
	}
	if storedRouter == storedIngest {
		t.Fatal("the router forwarded the ingest context to its deliveries instead of " +
			"its own; the fan-out is then unreachable from any delivery it created")
	}

	// --- boundary 3: the worker claims the delivery and picks the context up
	// off the row, having never seen the router's process.
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer endpoint.Close()
	mustExec(t, pool, `UPDATE endpoints SET url = $1 WHERE id = $2`, endpoint.URL, endpointID)

	rig := newRig(t, pool, rigOpts{concurrency: 1})
	stop := rig.start(t)
	eventually(t, 10*time.Second, "the delivery to be attempted", func() bool {
		return countRows(t, pool, `SELECT count(*) FROM delivery_attempts WHERE delivery_id = $1`, deliveryID) == 1
	})
	stop()

	attempt := spanByName(t, rec, "webhook.delivery.attempt")
	if attempt.Parent().IsValid() {
		t.Fatalf("the attempt span has parent %s; a delivery is a separate retry chain "+
			"and must not be a child of the fan-out", attempt.Parent().SpanID())
	}
	if attempt.SpanContext().TraceID() == fanOut.SpanContext().TraceID() {
		t.Fatal("the attempt joined the fan-out's trace; a wide fan-out with retries " +
			"would then be one trace nothing can assemble")
	}
	if !linksTo(attempt, fanOut.SpanContext()) {
		t.Fatalf("the attempt span does not link back to the fan-out span; the chain " +
			"is broken at the third boundary")
	}

	// --- and the ledger names the trace, which is what closes the loop for a
	// human who is looking at the delivery, not at a trace backend.
	var attemptTraceID string
	if err := pool.QueryRow(context.Background(),
		`SELECT COALESCE(trace_id, '') FROM delivery_attempts WHERE delivery_id = $1`,
		deliveryID).Scan(&attemptTraceID); err != nil {
		t.Fatalf("read delivery_attempts.trace_id: %v", err)
	}
	if want := attempt.SpanContext().TraceID().String(); attemptTraceID != want {
		t.Fatalf("delivery_attempts.trace_id = %q, want %q: without it the operator UI "+
			"cannot get from the attempt it is showing to the trace of that attempt",
			attemptTraceID, want)
	}
}

// TestTheWholeChainWorksWithTracingOff is the other half, and it is the one
// that must never break: with no collector configured, every column stays NULL
// and every delivery still happens.
//
// A production regression would look like: a NOT NULL constraint, a placeholder
// written when there is no span, or a nil dereference on a stage whose upstream
// context is absent - any of which turns "we did not configure tracing" into
// "the data plane does not work".
func TestTheWholeChainWorksWithTracingOff(t *testing.T) {
	if tracing.Enabled() {
		t.Fatal("tracing is enabled at the start of this test; a previous test leaked its provider")
	}

	pool := requirePool(t)
	resetQueue(t, pool)
	f := seedTenant(t, pool)
	apiKey := f.seedAPIKey(t)

	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer endpoint.Close()
	endpointID := f.newEndpoint(t, endpointOpts{url: endpoint.URL})
	f.newSubscription(t, endpointID, []string{"order.created"})

	resp := httptest.NewRecorder()
	newIngestHandler(ingest.NewPostgresStore(pool)).ServeHTTP(resp,
		ingestRequest(context.Background(), f.projectID, apiKey, "", `{"event_type":"order.created","data":{"id":1}}`))
	if resp.Code != http.StatusAccepted {
		t.Fatalf("ingest status = %d, want 202 (%s)", resp.Code, resp.Body.String())
	}

	r, err := router.New(router.Options{
		Store:                    router.NewPostgresStore(pool),
		RouterID:                 ids.New(ids.Worker),
		Logger:                   discardLogger(),
		BatchSize:                10,
		Concurrency:              1,
		MaxSubscriptionsPerEvent: 100,
	})
	if err != nil {
		t.Fatalf("build router: %v", err)
	}
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("router RunOnce: %v", err)
	}

	var deliveryID string
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM deliveries WHERE project_id = $1`, f.projectID).Scan(&deliveryID); err != nil {
		t.Fatalf("the fan-out created no delivery with tracing off: %v", err)
	}

	rig := newRig(t, pool, rigOpts{concurrency: 1})
	stop := rig.start(t)
	eventually(t, 10*time.Second, "the delivery to succeed", func() bool {
		return countRows(t, pool,
			`SELECT count(*) FROM deliveries WHERE id = $1 AND status = 'succeeded'`, deliveryID) == 1
	})
	stop()

	nulls := countRows(t, pool, `
		SELECT count(*) FROM deliveries d
		  JOIN delivery_attempts a ON a.delivery_id = d.id
		  JOIN event_outbox o ON o.event_id = d.event_id
		 WHERE d.id = $1
		   AND d.trace_context IS NULL
		   AND o.trace_context IS NULL
		   AND a.trace_id IS NULL`, deliveryID)
	if nulls != 1 {
		t.Fatal("with tracing off, all three trace columns must be NULL: a placeholder " +
			"would put 55 bytes of noise on every row of the hottest tables in the system " +
			"for every installation that never asked for traces")
	}
}

func spanByName(t *testing.T, rec interface {
	Ended() []sdktrace.ReadOnlySpan
}, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	var found sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.Name() != name {
			continue
		}
		if found != nil {
			t.Fatalf("more than one %q span was recorded", name)
		}
		found = s
	}
	if found == nil {
		var names []string
		for _, s := range rec.Ended() {
			names = append(names, s.Name())
		}
		t.Fatalf("no %q span was recorded; got %v", name, names)
	}
	return found
}

func linksTo(span sdktrace.ReadOnlySpan, target trace.SpanContext) bool {
	for _, l := range span.Links() {
		if l.SpanContext.TraceID() == target.TraceID() && l.SpanContext.SpanID() == target.SpanID() {
			return true
		}
	}
	return false
}
