package worker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/hookubit/services/data-plane/internal/queue"
	"github.com/shaq/hookubit/services/data-plane/internal/tracing"
	"github.com/shaq/hookubit/services/data-plane/internal/tracing/tracingtest"
)

// routerTraceparent is what the router stamped on the delivery row.
const routerTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"

// tracedLease is h.lease() carrying the stored router context and an attempt
// number, which is what the claim query returns in production.
func tracedLease(h *harness, stored string, attemptCount int) queue.Lease {
	l := h.lease()
	l.Job.TraceContext = stored
	l.Job.Attempt = attemptCount
	l.HeadOfLineDelay = 1500 * time.Millisecond
	return l
}

func spanNamed(t *testing.T, rec *tracetest.SpanRecorder, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range rec.Ended() {
		if s.Name() == name {
			return s
		}
	}
	var names []string
	for _, s := range rec.Ended() {
		names = append(names, s.Name())
	}
	t.Fatalf("no %q span was recorded; got %v", name, names)
	return nil
}

func attrValue(s sdktrace.ReadOnlySpan, key string) (string, bool) {
	for _, a := range s.Attributes() {
		if string(a.Key) == key {
			return a.Value.Emit(), true
		}
	}
	return "", false
}

// TestAttemptIsANewTraceLinkedToTheRouting is the third and last link of the
// chain, and the one that decides whether the operator surface is readable.
//
// Under parent-child, an event with 2000 subscriptions and a retry chain each
// is a single trace of a hundred thousand spans arriving over 24 hours. Nothing
// assembles it. This pins the alternative: a new root per attempt, linked back.
func TestAttemptIsANewTraceLinkedToTheRouting(t *testing.T) {
	rec := tracingtest.Record(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

	span := spanNamed(t, rec, "webhook.delivery.attempt")
	upstream := tracing.Decode(routerTraceparent)

	if span.Parent().IsValid() {
		t.Fatalf("the attempt span has parent %s; a delivery attempted six hours "+
			"after the routing must not be a child of it", span.Parent().SpanID())
	}
	if span.SpanContext().TraceID() == upstream.TraceID() {
		t.Fatal("the attempt reused the routing's trace id; every delivery of a wide " +
			"routing, times every retry, would land in one trace")
	}
	if len(span.Links()) != 1 || span.Links()[0].SpanContext.SpanID() != upstream.SpanID() {
		t.Fatalf("the attempt does not link back to the routing (%d links)", len(span.Links()))
	}
	if span.SpanKind() != trace.SpanKindConsumer {
		t.Fatalf("span kind = %v, want consumer", span.SpanKind())
	}
}

// TestTheOutboundPostIsItsOwnChildSpan.
//
// Everything above the request is bookkeeping measured in microseconds; this is
// where a slow endpoint holds a worker slot for thirty seconds, and separating
// it is what lets an operator say "the platform was ready in 2ms and the
// customer took 29 seconds" rather than guessing.
func TestTheOutboundPostIsItsOwnChildSpan(t *testing.T) {
	rec := tracingtest.Record(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

	stage := spanNamed(t, rec, "webhook.delivery.attempt")
	post := spanNamed(t, rec, "webhook.delivery.http")

	if post.Parent().SpanID() != stage.SpanContext().SpanID() {
		t.Fatal("the outbound POST span is not a child of the attempt span; in-process " +
			"steps of one attempt are parent-child, which is the truth about them")
	}
	if post.SpanKind() != trace.SpanKindClient {
		t.Fatalf("POST span kind = %v, want client", post.SpanKind())
	}
	if got, ok := attrValue(post, "http.response.status_code"); !ok || got != "200" {
		t.Fatalf("POST span http.response.status_code = %q (present=%v), want 200", got, ok)
	}
}

// TestTheAttemptSpanNeverCarriesTheEndpointURLOrThePayload.
//
// A customer's endpoint URL routinely carries a token in its query string -
// this is exactly why internal/worker logs hostOf(url). A span attribute is
// exported to a third-party backend, so the bar is at least as high.
//
// A production regression would look like: someone adding the full URL "for
// debugging", or a payload preview, and shipping every customer's webhook
// secret-bearing URL to a telemetry vendor.
func TestTheAttemptSpanNeverCarriesTheEndpointURLOrThePayload(t *testing.T) {
	rec := tracingtest.Record(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.job.Endpoint.URL = srv.URL + "/hook?access_token=SUPERSECRET"
	h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

	allowed := map[string]bool{
		"webhook.delivery.id": true, "webhook.event.id": true,
		"webhook.endpoint.id": true, "webhook.project.id": true,
		"webhook.organization.id": true, "webhook.delivery.attempt": true,
		"webhook.queue.head_of_line_delay_ms": true, "server.address": true,
		"webhook.event.type": true, "webhook.delivery.max_attempts": true,
		"webhook.payload.offloaded": true, "webhook.event.age_ms": true,
		"webhook.delivery.state": true, "webhook.outcome": true,
		"webhook.delivery.reason": true, "webhook.delivery.error_code": true,
		"http.response.status_code": true, "http.request.method": true,
		"webhook.payload.bytes": true, "webhook.delivery.retry_in_ms": true,
		"error.type": true, "webhook.trace.sample_in": true,
	}
	for _, span := range rec.Ended() {
		for _, a := range span.Attributes() {
			if !allowed[string(a.Key)] {
				t.Fatalf("span %q carries the unreviewed attribute %q=%q; every span "+
					"attribute leaves this process for a telemetry backend",
					span.Name(), a.Key, a.Value.Emit())
			}
			v := a.Value.Emit()
			if strings.Contains(v, "SUPERSECRET") || strings.Contains(v, "access_token") {
				t.Fatalf("span %q attribute %q leaked the endpoint URL's query string: %q",
					span.Name(), a.Key, v)
			}
			if strings.Contains(v, string(h.job.Payload)) {
				t.Fatalf("span %q attribute %q carries the payload", span.Name(), a.Key)
			}
			if strings.Contains(v, h.secret) {
				t.Fatalf("span %q attribute %q carries the signing secret", span.Name(), a.Key)
			}
		}
		for _, ev := range span.Events() {
			for _, a := range ev.Attributes {
				if strings.Contains(a.Value.Emit(), "SUPERSECRET") {
					t.Fatalf("span event on %q leaked the endpoint URL's query string", span.Name())
				}
			}
		}
	}
}

// TestTheAttemptRowNamesItsTraceOnlyWhenTheSpanWasKept.
//
// delivery_attempts.trace_id is the seam between the ledger the operator is
// already looking at and the trace backend. Writing the id of a DROPPED span
// puts a link in the UI that leads to an empty page, from which the operator
// concludes the backend is broken rather than that this attempt was not
// recorded.
func TestTheAttemptRowNamesItsTraceOnlyWhenTheSpanWasKept(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Run("sampled", func(t *testing.T) {
		rec := tracingtest.Record(t)
		h := newHarness(t, srv.URL)
		h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

		got := h.store.lastCompletion(t)
		if got.Attempt == nil {
			t.Fatal("no attempt row was recorded")
		}
		want := spanNamed(t, rec, "webhook.delivery.attempt").SpanContext().TraceID().String()
		if got.Attempt.TraceID != want {
			t.Fatalf("attempt row trace_id = %q, want the attempt span's trace %q",
				got.Attempt.TraceID, want)
		}
	})

	t.Run("dropped by the sampler", func(t *testing.T) {
		tracingtest.RecordWithSampler(t, tracing.NewSampler(0))
		h := newHarness(t, srv.URL)
		// Attempt 0 with an unsampled upstream: nothing samples this in.
		h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

		got := h.store.lastCompletion(t)
		if got.Attempt == nil {
			t.Fatal("no attempt row was recorded")
		}
		if got.Attempt.TraceID != "" {
			t.Fatalf("attempt row trace_id = %q for a span that was never exported; "+
				"a link to an empty page is worse than no link", got.Attempt.TraceID)
		}
	})

	t.Run("tracing off entirely", func(t *testing.T) {
		h := newHarness(t, srv.URL)
		h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))
		if got := h.store.lastCompletion(t).Attempt.TraceID; got != "" {
			t.Fatalf("attempt row trace_id = %q with tracing disabled, want empty", got)
		}
	})
}

// TestRetriesAreSampledInAtFullRate.
//
// This is the closest a HEAD sampler can get to "sample the failures": every
// attempt after the first exists because something went wrong. With the ratio
// at zero, a first attempt must produce nothing and a retry must produce a
// trace - otherwise the 2am delivery is exactly the one that was thrown away.
func TestRetriesAreSampledInAtFullRate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name         string
		attemptCount int
		want         bool
	}{
		{"first attempt", 0, false},
		{"second attempt", 1, true},
		{"tenth attempt", 9, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := tracingtest.RecordWithSampler(t, tracing.NewSampler(0))
			h := newHarness(t, srv.URL)
			h.job.AttemptNumber = tc.attemptCount + 1
			h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, tc.attemptCount))

			var kept bool
			for _, s := range rec.Ended() {
				if s.Name() == "webhook.delivery.attempt" {
					kept = true
				}
			}
			if kept != tc.want {
				t.Fatalf("attempt span kept = %v, want %v", kept, tc.want)
			}
		})
	}
}

// TestASampledRoutingKeepsItsDeliveries: if the router's span was kept, the
// deliveries it produced are kept too. Three independent 5% decisions give the
// complete story one time in eight thousand, which is another way of spelling
// "never".
func TestASampledRoutingKeepsItsDeliveries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	rec := tracingtest.RecordWithSampler(t, tracing.NewSampler(0))
	h := newHarness(t, srv.URL)
	const sampledUpstream = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	h.worker.handle(context.Background(), tracedLease(h, sampledUpstream, 0))

	if len(rec.Ended()) == 0 {
		t.Fatal("a delivery from a SAMPLED routing was dropped; the kept trace is a " +
			"fragment that links to work nobody recorded")
	}
}

// TestADeliveryStuckAtTheTenantGateIsStillTraced.
//
// "Why has this delivery not moved for twenty minutes" is answered by the
// gates, and a delivery turned away at the tenant gate never reaches
// Store.Load. Opening the span after the load would trace only the deliveries
// that were never stuck - which is the opposite of the requirement.
func TestADeliveryStuckAtTheTenantGateIsStillTraced(t *testing.T) {
	rec := tracingtest.Record(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// A project ceiling of one, already held, so the next delivery is refused
	// at the tenant gate - the one refusal that happens BEFORE the row is read.
	h := newHarness(t, srv.URL, func(o *Options) {
		o.Limits = GateLimits{Global: 8, Org: 8, Project: 1, Endpoint: 4}
	})
	release := saturateProject(t, h)
	defer release()

	h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

	if h.store.loads != 0 {
		t.Fatalf("the delivery row was loaded %d times; the tenant gate is supposed to "+
			"refuse before any database work", h.store.loads)
	}
	span := spanNamed(t, rec, "webhook.delivery.attempt")
	if got, ok := attrValue(span, "webhook.outcome"); !ok || got != "deferred" {
		t.Fatalf("webhook.outcome = %q (present=%v), want deferred", got, ok)
	}
	if _, ok := attrValue(span, "webhook.delivery.reason"); !ok {
		t.Fatal("a deferred delivery recorded no reason; \"why is this not moving\" is " +
			"the whole question the span exists to answer")
	}
	if span.Status().Code.String() == "Error" {
		t.Fatal("a concurrency deferral was marked as an error span; back-pressure " +
			"working as designed must not be painted red")
	}
}

// TestAFailedDeliveryIsAnErrorSpanAndACancelledOneIsNot.
//
// `failed` and `exhausted` mean an event the platform accepted did not arrive.
// `cancelled` means an operator switched the endpoint off on purpose - not a
// fault, and not something to page anyone about.
func TestAFailedDeliveryIsAnErrorSpanAndACancelledOneIsNot(t *testing.T) {
	t.Run("permanent failure", func(t *testing.T) {
		rec := tracingtest.Record(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		}))
		defer srv.Close()

		h := newHarness(t, srv.URL)
		h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

		span := spanNamed(t, rec, "webhook.delivery.attempt")
		if got := h.store.lastCompletion(t).Next.State; got != StateFailed {
			t.Fatalf("state = %s, want failed (test fixture assumption)", got)
		}
		if span.Status().Code.String() != "Error" {
			t.Fatalf("a permanently failed delivery produced status %s; the customer "+
				"was told we accepted this event and it did not arrive", span.Status().Code)
		}
	})

	t.Run("endpoint disabled", func(t *testing.T) {
		rec := tracingtest.Record(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		h := newHarness(t, srv.URL)
		h.job.Endpoint.Enabled = false
		h.worker.handle(context.Background(), tracedLease(h, routerTraceparent, 0))

		span := spanNamed(t, rec, "webhook.delivery.attempt")
		if got := h.store.lastCompletion(t).Next.State; got != StateCancelled {
			t.Fatalf("state = %s, want cancelled (test fixture assumption)", got)
		}
		if span.Status().Code.String() == "Error" {
			t.Fatal("an operator disabling an endpoint produced an error span")
		}
	})
}

// TestDeliveryWithNoStoredContextStillDelivers: every row written before the
// migration, and every row in a deployment with tracing off, carries NULL.
func TestDeliveryWithNoStoredContextStillDelivers(t *testing.T) {
	rec := tracingtest.Record(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.worker.handle(context.Background(), tracedLease(h, "", 0))

	if got := h.store.lastCompletion(t).Next.State; got != StateSucceeded {
		t.Fatalf("state = %s, want succeeded", got)
	}
	if n := len(spanNamed(t, rec, "webhook.delivery.attempt").Links()); n != 0 {
		t.Fatalf("recorded %d links for a delivery with no stored context, want 0", n)
	}
}
