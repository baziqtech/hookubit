package ingest

import (
	"context"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/hookubit/services/data-plane/internal/tracing"
)

// eventsRoute is the low-cardinality route template used as the span name and
// as http.route. The project id is an ATTRIBUTE, never part of the name: a span
// name per project is the same unbounded-cardinality mistake that the note at
// the top of internal/metrics refuses for Prometheus labels, and it makes every
// "how slow is ingest" query in a backend impossible to write.
const eventsRoute = "/v1/projects/{project_id}/events"

// startIngestSpan opens the SERVER span for one accepted request. It is the
// first of the three stage roots (see internal/tracing/context.go).
//
// # A customer's traceparent is a LINK, never a parent
//
// Publishers do send `traceparent`, and recording the causal edge is worth
// something. Adopting it as our PARENT is not, for two reasons that are not
// close:
//
//   - It hands every caller control of our trace ids. Two tenants can then
//     collide, deliberately or by accident, and a backend query for one
//     customer's trace returns another's spans. Cross-tenant leakage through
//     the telemetry pipeline is still cross-tenant leakage.
//   - It hands every caller the SAMPLED FLAG. A parent-based sampler honours
//     it, so any publisher could set `-01` on every request and force this
//     platform to record and export 100% of its own internal spans - a free
//     denial-of-wallet against our collector, from outside.
//
// So the header is parsed, bounded, and attached as a link. It reaches neither
// our trace id nor our sampling decision; internal/tracing.StartStage only ever
// consults AttrSampleIn.
func startIngestSpan(r *http.Request, projectID, requestID string) (context.Context, trace.Span) {
	var links []trace.Link
	// Enabled() first: with tracing off the header is not even read, so an
	// untraced deployment pays nothing at all for a feature it did not turn on.
	if caller := callerContext(r); caller.IsValid() {
		links = append(links, trace.Link{
			SpanContext: caller,
			Attributes: []attribute.KeyValue{
				attribute.String("webhook.link.role", "caller_supplied"),
			},
		})
	}

	return tracing.StartStage(r.Context(), "ingest "+eventsRoute, tracing.StageOptions{
		Kind:  trace.SpanKindServer,
		Links: links,
		Attributes: []attribute.KeyValue{
			tracing.AttrHTTPMethod.String(r.Method),
			tracing.AttrHTTPRoute.String(eventsRoute),
			tracing.AttrProjectID.String(projectID),
			tracing.AttrRequestID.String(requestID),
		},
	})
}

// callerContext parses the publisher's traceparent, and only when there is
// somewhere for it to go.
func callerContext(r *http.Request) trace.SpanContext {
	if !tracing.Enabled() {
		return trace.SpanContext{}
	}
	return tracing.Decode(r.Header.Get("traceparent"))
}

// finishIngestSpan records the outcome of one request.
//
// Only the CODE of a rejection is recorded, never its message: the message is
// contract text today, but the one thing that must never become true is a
// customer's payload or credential reaching a telemetry backend because
// somebody made an error message more helpful.
func finishIngestSpan(span trace.Span, status int, code, eventID string) {
	if !span.IsRecording() {
		return
	}
	span.SetAttributes(tracing.AttrHTTPStatus.Int(status))
	if eventID != "" {
		span.SetAttributes(tracing.AttrEventID.String(eventID))
	}
	if code != "" {
		span.SetAttributes(tracing.AttrErrorType.String(code))
	}
	// 4xx is the CLIENT's error, not this service's. Marking it Error would put
	// every malformed customer request into the same alerting bucket as a
	// failing database, which is how an error-rate panel becomes something
	// nobody looks at.
	if status >= 500 {
		span.SetStatus(codes.Error, code)
	}
}
