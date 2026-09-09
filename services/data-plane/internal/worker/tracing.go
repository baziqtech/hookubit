package worker

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
)

// startAttemptSpan opens the stage root for ONE delivery attempt.
//
// # One trace per ATTEMPT, linked to the fan-out that created the delivery
//
// This is the decision that most shapes what an operator sees, so it is worth
// being explicit about the three options and why the other two are worse.
//
//   - A child of the router's fan-out span. Rejected: an event can fan out to
//     ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT deliveries, each retried up to
//     max_attempts times over max_retry_duration. That is one trace of a hundred
//     thousand spans arriving over 24 hours. No backend assembles it, no UI
//     renders it, and the fan-out's own duration becomes "until the last retry
//     of the slowest endpoint gave up".
//
//   - Children of one long-lived "delivery" span. Rejected for a simpler
//     reason: nothing can hold a span open for 24 hours across a pod restart, a
//     rolling deploy and a lease being reclaimed by a different process. A span
//     that is closed and re-opened is two spans.
//
//   - A new root per attempt, linked to the fan-out. Chosen. Each span's
//     duration is the truth about one attempt, which is what every latency
//     percentile in a backend is computed from. The retry CHAIN is reassembled
//     by the index rather than by the tree: every attempt of one delivery
//     carries webhook.delivery.id, so one attribute query returns the chain in
//     order, and delivery_attempts.trace_id names each attempt's trace from the
//     row the operator UI is already showing.
//
// # Why the span starts HERE and not after the row is loaded
//
// Because the questions worth tracing are answered before the row is read. A
// delivery turned away by the tenant concurrency gate, an open circuit breaker
// or an endpoint rate limit never reaches Store.Load - and "why has this
// delivery not moved for twenty minutes" is exactly that case. Starting the
// span after the load would trace only the deliveries that were never stuck.
func startAttemptSpan(ctx context.Context, lease queue.Lease) (context.Context, trace.Span) {
	job := lease.Job
	return tracing.StartStage(ctx, "webhook.delivery.attempt", tracing.StageOptions{
		Upstream: job.TraceContext,
		Kind:     trace.SpanKindConsumer,
		// job.Attempt is attempt_count: the number of attempts ALREADY made.
		// Anything above zero is a retry, and a retry exists because something
		// went wrong - which is the whole of the error-path sample-in this
		// platform can make at span start. See internal/tracing/sampler.go.
		Retry: job.Attempt > 0,
		Attributes: []attribute.KeyValue{
			tracing.AttrDeliveryID.String(job.DeliveryID),
			tracing.AttrEventID.String(job.EventID),
			tracing.AttrEndpointID.String(job.EndpointID),
			tracing.AttrProjectID.String(job.ProjectID),
			tracing.AttrOrganizationID.String(job.OrganizationID),
			tracing.AttrAttempt.Int(job.Attempt + 1),
			// The fairness SLI of ADR-0007, on the span as well as in the
			// histogram: how long this row was ready before anybody claimed it.
			// It is the one number that distinguishes "the endpoint is slow"
			// from "we never got to it", and the two have opposite remedies.
			attribute.Int64("webhook.queue.head_of_line_delay_ms", lease.HeadOfLineDelay.Milliseconds()),
		},
	})
}

// spanOf is the active span, used by the delivery path to annotate the stage
// root without threading it through six signatures. It is never nil: a context
// with no span yields a no-op whose setters do nothing.
func spanOf(ctx context.Context) trace.Span { return trace.SpanFromContext(ctx) }

// recordDeferred annotates the stage span for a delivery that was put back
// WITHOUT an attempt.
//
// Deliberately NOT an error status. A deferral is the platform working as
// designed - a ceiling held, a breaker open, a rate limit charged - and marking
// it Error would paint every healthy back-pressure event red and train an
// operator to ignore the colour. The reason attribute is what carries the
// meaning.
func recordDeferred(ctx context.Context, reason Reason, delay time.Duration) {
	span := spanOf(ctx)
	if !span.IsRecording() {
		return
	}
	span.SetAttributes(
		tracing.AttrOutcome.String("deferred"),
		tracing.AttrDeliveryReason.String(string(reason)),
		attribute.Int64("webhook.delivery.retry_in_ms", delay.Milliseconds()),
	)
}

// recordTransition annotates the stage span with the state machine's verdict.
//
// `failed` and `exhausted` are the two states that mean an event a customer was
// told we accepted did not arrive, so those - and only those - set an error
// status. `cancelled` does not: an operator disabled the endpoint on purpose,
// and it is not a fault to be alerted on.
func recordTransition(ctx context.Context, decision Decision, attempt *AttemptRecord) {
	span := spanOf(ctx)
	if !span.IsRecording() {
		return
	}
	attrs := []attribute.KeyValue{
		tracing.AttrDeliveryState.String(string(decision.State)),
		tracing.AttrOutcome.String(string(decision.State)),
	}
	if decision.Reason != "" {
		attrs = append(attrs, tracing.AttrDeliveryReason.String(string(decision.Reason)))
	}
	if decision.ErrorCode != "" {
		attrs = append(attrs, tracing.AttrErrorCode.String(decision.ErrorCode))
	}
	if attempt != nil && attempt.HTTPStatus != 0 {
		attrs = append(attrs, tracing.AttrHTTPStatus.Int(attempt.HTTPStatus))
	}
	span.SetAttributes(attrs...)

	switch decision.State {
	case StateFailed, StateExhausted:
		span.SetStatus(codes.Error, string(decision.Reason))
	}
}
