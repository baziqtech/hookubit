package ingest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing/tracingtest"
)

// rootSpan returns the single SERVER span from a recording, which is the ingest
// stage root.
func rootSpan(t *testing.T, rec *tracetest.SpanRecorder) sdktrace.ReadOnlySpan {
	t.Helper()
	var found sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.SpanKind() == trace.SpanKindServer {
			if found != nil {
				t.Fatal("more than one server span was recorded for one request")
			}
			found = s
		}
	}
	if found == nil {
		t.Fatalf("no server span was recorded (%d spans total)", len(rec.Ended()))
	}
	return found
}

func attrOf(s sdktrace.ReadOnlySpan, key string) (string, bool) {
	for _, a := range s.Attributes() {
		if string(a.Key) == key {
			return a.Value.Emit(), true
		}
	}
	return "", false
}

// TestIngestCommitsItsTraceContextWithTheOutboxRow is the first link of the
// chain: without it the router has nothing to link to and a trace stops at the
// 202, which is the state this whole change exists to leave behind.
//
// The context must be the STAGE ROOT's, not the persist child's. The router
// links to "the request that accepted this event"; a child span that ended
// before the router ever ran is not a useful link target.
//
// A production regression would look like: someone moving the Encode call
// inside the persist span, or reordering it after the store call - so every
// stored context names a span that does not describe the acceptance.
func TestIngestCommitsItsTraceContextWithTheOutboxRow(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	resp := f.post(t, goodBody, nil)
	if resp.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", resp.Code, resp.Body.String())
	}

	stored := f.store.lastEvent(t).TraceContext
	if stored == "" {
		t.Fatal("no trace context was written with the event; the router has nothing " +
			"to link to and the trace stops at the 202")
	}
	if len(stored) != 55 {
		t.Fatalf("stored trace context is %d bytes (%q), want a 55-byte traceparent", len(stored), stored)
	}

	root := rootSpan(t, rec)
	want := tracing.EncodeSpanContext(root.SpanContext())
	if stored != want {
		t.Fatalf("stored %q, want the STAGE ROOT's context %q: the router links to "+
			"the request that accepted the event, not to a child span of it", stored, want)
	}
}

// TestIngestWithTracingOffWritesNoTraceContext.
//
// The column is nullable precisely so that a deployment with no collector
// writes nothing, and the router reads nothing, and neither branches on it. If
// this ever writes a placeholder, every row in every untraced installation
// carries 55 bytes of noise on the hottest table in the system.
func TestIngestWithTracingOffWritesNoTraceContext(t *testing.T) {
	f := newFixture(t)

	if resp := f.post(t, goodBody, nil); resp.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", resp.Code)
	}
	if got := f.store.lastEvent(t).TraceContext; got != "" {
		t.Fatalf("trace context = %q with tracing disabled, want empty (NULL)", got)
	}
}

// TestCallerSuppliedTraceparentIsALinkNeverAParent.
//
// Adopting a publisher's traceparent as our parent would hand every caller two
// things they must not have: control of our trace ids - so two tenants can
// collide and a backend query for one customer returns another's spans - and
// control of the sampled flag, which under any parent-based sampler is a free
// switch that forces 100% export of this platform's internal traces from
// outside, with no credential beyond the ability to POST an event.
func TestCallerSuppliedTraceparentIsALinkNeverAParent(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	const caller = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	callerCtx := tracing.Decode(caller)
	if !callerCtx.IsValid() {
		t.Fatal("test fixture is wrong: the caller traceparent does not parse")
	}

	if resp := f.post(t, goodBody, map[string]string{"traceparent": caller}); resp.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", resp.Code, resp.Body.String())
	}

	root := rootSpan(t, rec)
	if root.Parent().IsValid() {
		t.Fatalf("the ingest span has parent %s: a caller's traceparent was adopted "+
			"as our parent", root.Parent().SpanID())
	}
	if root.SpanContext().TraceID() == callerCtx.TraceID() {
		t.Fatal("the ingest span reused the caller's trace id; any publisher can then " +
			"collide with any other tenant's traces")
	}
	if len(root.Links()) != 1 {
		t.Fatalf("recorded %d links, want exactly 1 recording the caller as a cause", len(root.Links()))
	}
	if got := root.Links()[0].SpanContext.TraceID(); got != callerCtx.TraceID() {
		t.Fatalf("link trace id = %s, want the caller's %s", got, callerCtx.TraceID())
	}
}

// TestMalformedCallerTraceparentIsIgnored: header content is attacker-supplied.
// It must never produce an error, a panic, or a link to nothing.
func TestMalformedCallerTraceparentIsIgnored(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	for _, bad := range []string{"garbage", strings.Repeat("a", 8192), "00-0-0-0", ""} {
		rec.Reset()
		if resp := f.post(t, goodBody, map[string]string{"traceparent": bad}); resp.Code != http.StatusAccepted {
			t.Fatalf("traceparent %q made the request fail with %d", bad, resp.Code)
		}
		if n := len(rootSpan(t, rec).Links()); n != 0 {
			t.Fatalf("traceparent %q produced %d links, want 0", bad, n)
		}
	}
}

// TestIngestSpanCarriesNoCustomerData is the standing guard on attribute
// content. Span attributes leave this process for a third-party backend, so the
// bar is at least the bar for a log line.
//
// It asserts on the WHOLE attribute set rather than on a list of forbidden
// keys, because the failure this prevents is somebody ADDING an attribute -
// a payload preview, the idempotency key, the Authorization header - and a
// deny-list only catches what its author already thought of.
func TestIngestSpanCarriesNoCustomerData(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	const body = `{"event_type":"order.created","data":{"pan":"4111111111111111"}}`
	resp := f.post(t, body, map[string]string{"Idempotency-Key": "customer-order-98765"})
	if resp.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", resp.Code, resp.Body.String())
	}

	allowed := map[string]bool{
		"http.request.method":       true,
		"http.route":                true,
		"http.response.status_code": true,
		"webhook.project.id":        true,
		"webhook.request.id":        true,
		"webhook.event.id":          true,
		"webhook.event.type":        true,
		"error.type":                true,
		"webhook.trace.sample_in":   true,
		"webhook.payload.bytes":     true,
		"webhook.payload.offloaded": true,
	}
	for _, span := range rec.Ended() {
		for _, a := range span.Attributes() {
			if !allowed[string(a.Key)] {
				t.Fatalf("span %q carries the unreviewed attribute %q=%q; every span "+
					"attribute is exported to a third-party backend, so adding one is a "+
					"decision, not a detail", span.Name(), a.Key, a.Value.Emit())
			}
			emitted := a.Value.Emit()
			for _, forbidden := range []string{"4111111111111111", "customer-order-98765", f.apiKey} {
				if strings.Contains(emitted, forbidden) {
					t.Fatalf("span %q attribute %q leaked customer data", span.Name(), a.Key)
				}
			}
		}
	}
}

// TestRejectedRequestsAreTracedWithTheirCodeOnly.
//
// The code is contract; the message is not guaranteed to stay that way. And a
// 4xx must not be an error STATUS: a customer sending malformed JSON is not
// this service failing, and putting it in the same bucket as a dead database
// is how an error-rate panel becomes something nobody looks at.
func TestRejectedRequestsAreTracedWithTheirCodeOnly(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	if resp := f.post(t, `{"nope":true}`, nil); resp.Code != http.StatusUnprocessableEntity &&
		resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want a 4xx", resp.Code)
	}

	root := rootSpan(t, rec)
	if _, ok := attrOf(root, "error.type"); !ok {
		t.Fatal("a rejected request recorded no error.type; the span cannot say why it failed")
	}
	if got := root.Status().Code.String(); got == "Error" {
		t.Fatal("a 4xx was recorded with an Error status: a malformed customer request " +
			"is not this service failing, and mixing the two makes the signal useless")
	}
	if _, ok := attrOf(root, "webhook.event.id"); ok {
		t.Fatal("a rejected request recorded an event id; nothing was created")
	}
}

// TestUnroutedRequestsProduceNoSpans: a scan of the internet hitting /admin
// must not be able to fill a trace backend. The 404 and 405 paths run before
// the span is opened, on purpose.
func TestUnroutedRequestsProduceNoSpans(t *testing.T) {
	rec := tracingtest.Record(t)
	f := newFixture(t)

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rw := httptest.NewRecorder()
	f.handler.ServeHTTP(rw, req)

	if n := len(rec.Ended()); n != 0 {
		t.Fatalf("recorded %d spans for an unrouted request, want 0", n)
	}
}
