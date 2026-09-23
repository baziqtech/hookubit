package tracing

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// noopSpan is the span handed back when tracing is off. A value, not a pointer,
// and shared: it holds no state and every method on it is empty.
var noopSpan trace.Span = noop.Span{}

// ---------------------------------------------------------------------------
// PROPAGATION THROUGH POSTGRESQL
//
// # Which rows carry the context
//
// Exactly the rows that a LATER, DIFFERENT process claims:
//
//	event_outbox.trace_context   written by ingest, read by the router
//	deliveries.trace_context     written by the router, read by the worker
//
// and one row that carries the RESULT rather than the cause:
//
//	delivery_attempts.trace_id   written by the worker, read by a human
//
// `events` deliberately carries nothing. It is the durable record of what the
// publisher sent; the trace context is a property of the WORK, and the work is
// claimed from the outbox. An event that is replayed months later is new work
// with a new cause, and stamping the original request's trace context onto it
// would attribute a 2026 replay to a 2025 HTTP request.
//
// The columns are nullable TEXT holding one W3C `traceparent` - a fixed 55
// bytes, `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. NULL is the
// honest value when tracing is off, and it is what every row written before
// this migration has. Nothing in the delivery path branches on it being
// present; Decode of "" simply yields an invalid span context and the stage
// starts an unlinked root.
//
// `tracestate` is NOT stored. It is vendor-specific, it is unbounded in length,
// and nothing in this platform sets it. Storing an unbounded customer- or
// vendor-controlled string on the hottest table in the system to preserve a
// field we do not use is not a trade worth making.
//
// # Span links, not parent-child
//
// Each of the three stages starts a NEW ROOT span and LINKS to the stored
// context. It does not become a child of it. Three independent reasons, any one
// of which would be sufficient:
//
//  1. Duration. A delivery attempted six hours after the 202 is not part of
//     that HTTP request in any latency sense. Under parent-child, every
//     backend that derives a trace duration - and every dashboard built on
//     one - reports six-hour traces for a platform whose p99 ingest latency is
//     nine milliseconds. That poisons the percentiles an operator is supposed
//     to alarm on, which is worse than having no traces.
//
//  2. Sampling. A parent's decision propagates to its children. Under
//     parent-child, the 95% of events head-sampled OUT at ingest can never
//     produce a delivery trace - and the sampled-out event is precisely the one
//     someone asks about at 2am. Links break that coupling: each stage decides
//     for itself. See sampler.go for the decision that replaces it.
//
//  3. Size. One event can route to ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT
//     endpoints, each with its own retry chain of up to max_attempts. Under
//     parent-child that is a single trace of a hundred thousand spans, arriving
//     over 24 hours. No backend assembles it and no human reads it.
//
// A link says the true thing: this work was CAUSED BY that work, and is not
// part of it.
//
// # Retries
//
// Attempt N is a NEW TRACE, linked to the routing - not a child of attempt 1
// and not a sibling under a long-lived delivery span.
//
//   - Not a child of the previous attempt: attempts are up to an hour apart and
//     run on different pods. The parent would have to be held open across a
//     process restart, which is not a thing a span can survive.
//
//   - Not children of one delivery span: same objection. Nothing can hold a
//     span open for 24 hours across restarts, and a span that is closed and
//     re-opened is two spans.
//
// What makes the retry chain readable is not the span tree, it is the index:
// every attempt of one delivery carries webhook.delivery.id, so one attribute
// query returns the whole chain in order; and delivery_attempts.trace_id closes
// the loop from the operator UI - the row an operator is already looking at
// names the trace of that exact attempt. It is written ONLY when the span was
// actually sampled, so a non-null trace_id is a promise the backend can keep.
// ---------------------------------------------------------------------------

// propagator is the W3C traceparent codec. Stateless and safe to share.
var propagator = propagation.TraceContext{}

// carrierKey is the single key of the map propagation.TraceContext writes.
const carrierKey = "traceparent"

// MaxStoredContextBytes bounds what Decode will look at. A W3C traceparent is
// fixed at 55 bytes; anything longer is not one, and a bound here means a
// corrupted or hostile column value cannot become a parsing cost.
const MaxStoredContextBytes = 64

// Encode serialises the span in ctx into the string stored on a row.
//
// It returns "" when there is no valid span - tracing disabled, or a span that
// was never started - and "" is written to the column as NULL. That is the
// whole of the "tracing is off" branch on the write side.
func Encode(ctx context.Context) string {
	return EncodeSpanContext(trace.SpanContextFromContext(ctx))
}

// EncodeSpanContext is Encode for a span context held directly.
func EncodeSpanContext(sc trace.SpanContext) string {
	if !sc.IsValid() {
		return ""
	}
	carrier := propagation.MapCarrier{}
	propagator.Inject(trace.ContextWithSpanContext(context.Background(), sc), carrier)
	return carrier.Get(carrierKey)
}

// Decode parses a stored traceparent back into a REMOTE span context.
//
// Remote matters: it is what tells the SDK the context came from another
// process, which is what makes it a legitimate link target rather than
// something the sampler treats as a local parent.
//
// An unparseable value yields the zero SpanContext, which IsValid() reports
// false for and which every caller here treats as "no upstream". A row written
// by an older build, a truncated column, a hand-edited value: all of them
// degrade to an unlinked root rather than to an error.
func Decode(stored string) trace.SpanContext {
	if stored == "" || len(stored) > MaxStoredContextBytes {
		return trace.SpanContext{}
	}
	ctx := propagator.Extract(context.Background(), propagation.MapCarrier{carrierKey: stored})
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return trace.SpanContext{}
	}
	return sc
}

// StageOptions describes one asynchronous stage root.
type StageOptions struct {
	// Upstream is the traceparent read off the claimed row. Empty means this
	// stage has no recorded cause, which is normal for rows written before
	// tracing was enabled.
	Upstream string
	// Kind is the span kind. Stages that consume from the database are
	// SpanKindConsumer; the outbound POST is SpanKindClient.
	Kind trace.SpanKind
	// Attributes are set at Start rather than afterwards, because the Sampler
	// only sees attributes passed at Start - and AttrSampleIn is one of them.
	Attributes []attribute.KeyValue
	// Retry marks work that has already been attempted at least once. It is
	// the error-path sample-in: see sampler.go.
	Retry bool
	// Recovery marks work being re-processed after a recorded failure.
	Recovery bool
	// Links are ADDITIONAL causes, beyond Upstream.
	//
	// The only current use is the `traceparent` a customer may send on an
	// ingest request. It is recorded as a LINK and never as a parent, and it
	// never reaches the sampler's input: the sampler in sampler.go reads
	// AttrSampleIn and nothing else, so a caller cannot set the sampled flag on
	// a header and force this platform to record 100% of their traffic.
	Links []trace.Link
}

// StartStage begins a stage root: a new root span, linked to the upstream
// context that caused it, with the sampling decision described in sampler.go.
//
// It is the ONLY way a stage root is created in this codebase. Centralising it
// is what keeps the three propagation rules - new root, link not parent,
// sample-in - from being re-decided differently in three packages.
func StartStage(ctx context.Context, name string, opts StageOptions) (context.Context, trace.Span) {
	if !Enabled() {
		// THE DISABLED PATH, and it is on the ingest hot path and the delivery
		// hot path. Nothing will record this span, so nothing here may pay to
		// describe it: no traceparent parse, no link slice, no
		// trace.WithAttributes wrapper, no SpanStartOption slice.
		//
		// The context is returned UNCHANGED rather than run through the noop
		// tracer, because even the noop tracer's Start calls
		// trace.ContextWithSpan - one context.WithValue allocation per accepted
		// event and per delivery attempt, forever, in every deployment that
		// never configured a collector. Everything downstream still behaves:
		// Encode of a span-less context is "", Logger adds nothing, and
		// trace.SpanFromContext hands the annotation helpers a non-recording
		// span whose setters do nothing.
		//
		// TestDisabledStageStartCostsNoAllocations pins the zero.
		return ctx, noopSpan
	}

	upstream := Decode(opts.Upstream)

	attrs := opts.Attributes
	switch {
	case opts.Retry:
		attrs = append(attrs, AttrSampleIn.String(SampleInRetry))
	case opts.Recovery:
		attrs = append(attrs, AttrSampleIn.String(SampleInRecovery))
	case upstream.IsSampled():
		// The stage before us was kept. Keeping this one completes a story the
		// backend has already been paid for; dropping it would leave a trace
		// whose link points at nothing.
		//
		// Note what is NOT consulted: a traceparent supplied by a CUSTOMER on
		// an ingest request. That value never reaches this branch - see
		// ingest's handler - because it would hand any caller a switch that
		// forces 100% sampling of our platform.
		attrs = append(attrs, AttrSampleIn.String(SampleInUpstream))
	}

	startOpts := []trace.SpanStartOption{
		trace.WithNewRoot(),
		trace.WithSpanKind(opts.Kind),
		trace.WithAttributes(attrs...),
	}
	links := opts.Links
	if upstream.IsValid() {
		links = append(links, trace.Link{SpanContext: upstream})
	}
	if len(links) > 0 {
		startOpts = append(startOpts, trace.WithLinks(links...))
	}
	return Tracer().Start(ctx, name, startOpts...)
}

// Start begins an ORDINARY, in-process child span. Use it for the steps inside
// one stage - a database call, an object-storage fetch, the outbound POST -
// where parent-child is the truth.
func Start(ctx context.Context, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	return Tracer().Start(ctx, name, opts...)
}

// TraceID returns the current trace id as a string, or "" when there is none.
func TraceID(ctx context.Context) string {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return ""
	}
	return sc.TraceID().String()
}

// SampledTraceID returns the trace id ONLY when the span was actually sampled.
//
// This is what may be persisted to delivery_attempts.trace_id. Storing the id
// of a span that was dropped would put a link in the operator UI that leads to
// an empty page - which is worse than no link, because the operator concludes
// the trace backend is broken rather than that this attempt was not recorded.
func SampledTraceID(ctx context.Context) string {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() || !sc.IsSampled() {
		return ""
	}
	return sc.TraceID().String()
}

// Logger attaches the active trace and span ids to a structured logger.
//
// ARCHITECTURE.md 63 requires structured logs AND traces, and this is the seam
// between them: an operator who found the log line has the trace id, and an
// operator who found the trace can grep for it. Neither replaces the other -
// logs are unsampled and traces are not.
//
// It returns the logger unchanged when there is no span, so a disabled
// deployment's log lines are byte-identical to what they were before.
func Logger(ctx context.Context, log *slog.Logger) *slog.Logger {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return log
	}
	return log.With("trace_id", sc.TraceID().String(), "span_id", sc.SpanID().String())
}

// RecordError marks a span as failed without ever letting that be a reason a
// delivery fails. err may be nil, in which case nothing happens.
func RecordError(span trace.Span, err error) {
	if span == nil || err == nil || !span.IsRecording() {
		return
	}
	span.RecordError(err)
}
