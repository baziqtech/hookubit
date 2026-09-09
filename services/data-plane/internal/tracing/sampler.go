package tracing

import (
	"fmt"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// NewSampler builds the data plane's head sampler.
//
// # Why not just sample everything
//
// At the throughput this platform is built for, one event fans out to N
// deliveries, each of which may be attempted up to max_attempts times, and each
// attempt is several spans. Head-sampling everything means the span volume is a
// multiple of the delivery volume, which is a multiple of the event volume.
// That is a telemetry bill and an ingestion pipeline larger than the product.
//
// # Why not just sample a fixed ratio
//
// Because the sampled-out event is exactly the one somebody asks about at 2am,
// and a ratio has no way to know which one that is.
//
// A head sampler decides at span START, so it can only use what is known then.
// What IS known then, and what this sampler uses:
//
//	the stored upstream traceparent's sampled flag
//	whether this is a retry / a re-processed row
//
// So the rule is:
//
//	sample IN, unconditionally, when AttrSampleIn is present
//	otherwise, TraceIDRatioBased(ratio)
//
// and the stages set AttrSampleIn when:
//
//   - the upstream stage was sampled. That makes a kept trace COMPLETE rather
//     than a fragment: if the ingest was kept, its fan-out and its deliveries
//     are kept too. Without it, a ratio applied independently three times means
//     the probability of having the whole story is ratio^3 - one in eight
//     thousand at the shipped 5%, which is another way of spelling "never".
//
//   - it is a RETRY, or a row being re-processed after a recorded failure.
//     This is the error path, sampled in at 100%. It is the closest a head
//     sampler can get to "sample the failures": a first attempt that succeeds
//     is the boring case and is what the ratio is for, while every attempt
//     after the first exists BECAUSE something went wrong. Retries are a small
//     fraction of attempts on a healthy platform, so the cost is small - and on
//     an unhealthy one, the volume rises exactly when the detail is wanted.
//
// # What this still cannot do
//
// It cannot sample in a FIRST attempt that turns out to fail, because the
// outcome is not known when the span starts - only when it ends. The honest
// answers to that are (a) the delivery ledger, which is unsampled and is the
// record of record for "what happened to this event", and (b) tail sampling in
// the collector, which is where an outcome-based policy belongs. Nothing here
// blocks (b): the stages emit `error.type`, `http.response.status_code` and
// `webhook.delivery.state`, and a collector tail policy keyed on those composes
// with this sampler rather than fighting it. What would have blocked it is
// parent-child propagation across the three stages, because a tail sampler
// decides per TRACE and a 24-hour trace never completes.
//
// # ParentBased
//
// The stage sampler above applies to ROOTS. In-process children - the payload
// fetch, the outbound POST - inherit their root's decision, which is what
// ParentBased's defaults do. A stage root is always started with
// trace.WithNewRoot(), so it is judged by the root sampler even though a
// context may carry a span from the poll loop that created it.
func NewSampler(ratio float64) sdktrace.Sampler {
	return sdktrace.ParentBased(stageSampler{
		ratio: sdktrace.TraceIDRatioBased(ratio),
		desc:  fmt.Sprintf("HookubitStage{ratio:%g,sample_in:always}", ratio),
	})
}

type stageSampler struct {
	ratio sdktrace.Sampler
	desc  string
}

func (s stageSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	for _, attr := range p.Attributes {
		if attr.Key != AttrSampleIn {
			continue
		}
		if attr.Value.AsString() == "" {
			continue
		}
		return sdktrace.SamplingResult{
			Decision: sdktrace.RecordAndSample,
			// Carrying the parent's tracestate forward is what
			// TraceIDRatioBased does; not doing it here would silently drop
			// vendor state on exactly the spans we chose to keep.
			Tracestate: trace.SpanContextFromContext(p.ParentContext).TraceState(),
		}
	}
	return s.ratio.ShouldSample(p)
}

func (s stageSampler) Description() string { return s.desc }
