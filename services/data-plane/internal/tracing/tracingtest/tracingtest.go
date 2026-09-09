// Package tracingtest installs a recording tracer for the duration of a test.
//
// It exists so the packages that emit spans - ingest, router, worker - can
// assert on what they emitted without an exporter, a collector or a network.
// The alternative is an instrumentation layer nothing checks, which is the
// failure mode this whole package exists to prevent: a renamed attribute or a
// stage that quietly became a child instead of a link changes nothing anybody
// notices until the night somebody needs the trace.
package tracingtest

import (
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/shaq/webhook-platform/services/data-plane/internal/tracing"
)

// Record installs a provider that records every span and samples everything,
// and returns the recorder. The previous tracer is restored on cleanup.
//
// AlwaysSample, deliberately: these tests assert on span SHAPE - links, kinds,
// attributes - not on the sampler. The sampler has its own tests, which install
// their own ratio.
func Record(t testing.TB) *tracetest.SpanRecorder {
	t.Helper()
	return RecordWithSampler(t, sdktrace.AlwaysSample())
}

// RecordWithSampler is Record with the sampler under test.
func RecordWithSampler(t testing.TB, sampler sdktrace.Sampler) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithSpanProcessor(recorder),
	)
	restore := tracing.UseTracer(tp)
	t.Cleanup(func() {
		restore()
		_ = tp.Shutdown(t.Context())
	})
	return recorder
}
