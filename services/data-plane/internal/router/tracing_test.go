package router

import (
	"context"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing/tracingtest"
)

const ingestTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

func fanOutSpan(t *testing.T, rec *tracetest.SpanRecorder) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range rec.Ended() {
		if s.Name() == "webhook.fan_out" {
			return s
		}
	}
	t.Fatalf("no webhook.fan_out span was recorded (%d spans)", len(rec.Ended()))
	return nil
}

// TestFanOutStampsItsOwnContextOnEveryDeliveryItCreates is the second link of
// the chain.
//
// The value stored on the delivery rows must be the ROUTER's fan-out span, not
// the ingest context it was handed. A delivery is a separate retry chain from
// its event: the worker's question is "which fan-out produced this row", and
// forwarding the ingest context instead would make every delivery of every
// event point at an HTTP request rather than at the work that created it - and
// would leave the fan-out itself unreachable from any delivery.
func TestFanOutStampsItsOwnContextOnEveryDeliveryItCreates(t *testing.T) {
	rec := tracingtest.Record(t)

	var seen RouteRequest
	store := &fakeStore{
		claim: []OutboxRow{{
			ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated,
			Attempts: 1, UnaccountedAttempts: 1,
			TraceContext: ingestTraceparent,
		}},
		routeFn: func(req RouteRequest) (RouteResult, error) {
			seen = req
			return RouteResult{Outcome: OutcomeRouted, Created: 3}, nil
		},
	}
	r := newTestRouter(t, store, nil)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	span := fanOutSpan(t, rec)
	want := tracing.EncodeSpanContext(span.SpanContext())
	if seen.TraceContext == "" {
		t.Fatal("the fan-out wrote no trace context onto its deliveries; the worker " +
			"then has nothing to link to and the chain stops at the router")
	}
	if seen.TraceContext != want {
		t.Fatalf("stamped %q, want the fan-out span's own context %q", seen.TraceContext, want)
	}
	if seen.TraceContext == ingestTraceparent {
		t.Fatal("the fan-out forwarded the INGEST context to its deliveries: every " +
			"delivery would then point at an HTTP request and the fan-out itself " +
			"would be unreachable from any of them")
	}
}

// TestFanOutLinksToIngestRatherThanParentingUnderIt.
//
// A production regression here is invisible until somebody opens a dashboard:
// under parent-child, the ingest trace's duration becomes "until the last retry
// of the widest fan-out finished", and every latency percentile derived from
// trace duration is destroyed.
func TestFanOutLinksToIngestRatherThanParentingUnderIt(t *testing.T) {
	rec := tracingtest.Record(t)
	upstream := tracing.Decode(ingestTraceparent)

	store := &fakeStore{claim: []OutboxRow{{
		ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated,
		Attempts: 1, UnaccountedAttempts: 1, TraceContext: ingestTraceparent,
	}}}
	r := newTestRouter(t, store, nil)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	span := fanOutSpan(t, rec)
	if span.Parent().IsValid() {
		t.Fatalf("the fan-out span has parent %s; it must be a new root", span.Parent().SpanID())
	}
	if span.SpanContext().TraceID() == upstream.TraceID() {
		t.Fatal("the fan-out reused the ingest trace id")
	}
	if len(span.Links()) != 1 || span.Links()[0].SpanContext.SpanID() != upstream.SpanID() {
		t.Fatalf("the fan-out does not link to the ingest span (%d links)", len(span.Links()))
	}
	if span.SpanKind() != trace.SpanKindConsumer {
		t.Fatalf("span kind = %v, want consumer", span.SpanKind())
	}
}

// TestOutboxRowWithNoStoredContextStillFansOut: rows written before the
// migration, and every row in a deployment with tracing off, carry NULL. Fan-out
// must not care.
func TestOutboxRowWithNoStoredContextStillFansOut(t *testing.T) {
	rec := tracingtest.Record(t)
	store := &fakeStore{claim: []OutboxRow{{
		ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated,
		Attempts: 1, UnaccountedAttempts: 1,
	}}}
	r := newTestRouter(t, store, nil)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(store.routed) != 1 {
		t.Fatalf("routed %d rows, want 1", len(store.routed))
	}
	if n := len(fanOutSpan(t, rec).Links()); n != 0 {
		t.Fatalf("recorded %d links for a row with no stored context, want 0", n)
	}
}

// TestOneSpanPerEventNotPerDelivery.
//
// The unit an operator asks about is one event's fan-out. Emitting a span per
// DELIVERY would mean up to ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT spans per
// transaction - 2000 at the shipped default - for an event that has not been
// delivered anywhere yet, and emitting one per POLL would mix unrelated tenants
// into a trace whose duration is "the slowest unrelated event".
func TestOneSpanPerEventNotPerDelivery(t *testing.T) {
	rec := tracingtest.Record(t)
	store := &fakeStore{
		claim: []OutboxRow{
			{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1},
			{ID: "obx_2", EventID: "evt_2", Type: OutboxTypeEventCreated, Attempts: 1},
		},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{Outcome: OutcomeRouted, Created: 500}, nil
		},
	}
	r := newTestRouter(t, store, nil)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	var fanOuts int
	for _, s := range rec.Ended() {
		if s.Name() == "webhook.fan_out" {
			fanOuts++
		}
	}
	if fanOuts != 2 {
		t.Fatalf("recorded %d fan-out spans for 2 outbox rows creating 1000 deliveries, want 2", fanOuts)
	}
}

// TestParkedRowIsAnErrorSpanAndAReleasedOneIsNot.
//
// A parked row is an event that returned 202 and will not be delivered without
// a human - the one outcome in this package that deserves a red trace. A
// released row is going to be retried and the platform is behaving as designed;
// marking every transient database blip as an error is how a trace backend's
// error view becomes noise.
func TestParkedRowIsAnErrorSpanAndAReleasedOneIsNot(t *testing.T) {
	t.Run("parked", func(t *testing.T) {
		rec := tracingtest.Record(t)
		store := &fakeStore{claim: []OutboxRow{{
			ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated,
			Attempts: 99, UnaccountedAttempts: 99,
		}}}
		r := newTestRouter(t, store, nil)
		if _, err := r.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		span := fanOutSpan(t, rec)
		if span.Status().Code.String() != "Error" {
			t.Fatalf("a parked row produced status %s; an event that will never be "+
				"delivered without an operator is exactly what an error span is for",
				span.Status().Code)
		}
	})

	t.Run("released", func(t *testing.T) {
		rec := tracingtest.Record(t)
		store := &fakeStore{
			claim: []OutboxRow{{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1}},
			routeFn: func(RouteRequest) (RouteResult, error) {
				return RouteResult{}, context.DeadlineExceeded
			},
		}
		r := newTestRouter(t, store, nil)
		if _, err := r.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		span := fanOutSpan(t, rec)
		if span.Status().Code.String() == "Error" {
			t.Fatal("a released row was marked as an error span; it is going to be " +
				"retried and a transient database fault is not an incident")
		}
		if len(span.Events()) == 0 {
			t.Fatal("the failure that released the row was not recorded on the span at all")
		}
	})
}

// TestReclaimedRowIsSampledIn: a row being picked up for the second time is a
// row whose first claim failed, and it is sampled in at 100%. With a zero
// ratio, a first claim must produce nothing and a re-claim must produce a span.
func TestReclaimedRowIsSampledIn(t *testing.T) {
	for _, tc := range []struct {
		name     string
		attempts int
		want     int
	}{
		{"first claim", 1, 0},
		{"re-claim", 2, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := tracingtest.RecordWithSampler(t, tracing.NewSampler(0))
			store := &fakeStore{claim: []OutboxRow{{
				ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated,
				Attempts: tc.attempts, UnaccountedAttempts: tc.attempts,
			}}}
			r := newTestRouter(t, store, func(o *Options) { o.MaxOutboxAttempts = 50 })
			if _, err := r.RunOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := len(rec.Ended()); got != tc.want {
				t.Fatalf("recorded %d spans, want %d: a re-claimed row is evidence "+
					"something went wrong and is the only shape an operator asks about", got, tc.want)
			}
		})
	}
}

// TestFanOutSpanCarriesNoPayload guards the attribute set, for the same reason
// the ingest test does: an attribute added here leaves the process.
func TestFanOutSpanCarriesNoPayload(t *testing.T) {
	rec := tracingtest.Record(t)
	store := &fakeStore{
		claim: []OutboxRow{{ID: "obx_1", EventID: "evt_1", Type: OutboxTypeEventCreated, Attempts: 1}},
		routeFn: func(RouteRequest) (RouteResult, error) {
			return RouteResult{
				Outcome: OutcomeRouted,
				Created: 2,
				Event: Event{
					ID: "evt_1", ProjectID: "prj_1", OrganizationID: "org_1",
					EventType: "order.created", CreatedAt: time.Now(),
				},
			}, nil
		},
	}
	r := newTestRouter(t, store, nil)
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{
		"webhook.outbox.id": true, "webhook.event.id": true,
		"webhook.delivery.attempt": true, "webhook.outcome": true,
		"webhook.fan_out.deliveries_created": true, "webhook.fan_out.planned": true,
		"webhook.project.id": true, "webhook.organization.id": true,
		"webhook.event.type": true, "webhook.delivery.reason": true,
		"webhook.trace.sample_in": true,
	}
	for _, a := range fanOutSpan(t, rec).Attributes() {
		if !allowed[string(a.Key)] {
			t.Fatalf("the fan-out span carries the unreviewed attribute %q=%q", a.Key, a.Value.Emit())
		}
	}
}
