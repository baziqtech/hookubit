package tracing

import (
	"context"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// record installs a recording provider for one test.
func record(t *testing.T, sampler sdktrace.Sampler) *tracetest.SpanRecorder {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sampler),
		sdktrace.WithSpanProcessor(rec),
	)
	restore := UseTracer(tp)
	t.Cleanup(func() {
		restore()
		_ = tp.Shutdown(context.Background())
	})
	return rec
}

// remoteContext builds a stored traceparent as another process would have
// written it.
func remoteContext(t *testing.T, sampled bool) string {
	t.Helper()
	traceID, err := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("00f067aa0ba902b7")
	if err != nil {
		t.Fatal(err)
	}
	var flags trace.TraceFlags
	if sampled {
		flags = trace.FlagsSampled
	}
	return EncodeSpanContext(trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: flags, Remote: true,
	}))
}

// TestTracingDisabledIsTheNoopImplementation is the non-negotiable one:
// with OTEL_EXPORTER_OTLP_ENDPOINT unset, tracing must compile to approximately
// nothing.
//
// It asserts three things that together mean "nothing was built": Setup
// returned a provider with no SDK behind it, Shutdown on it is a no-op, and the
// tracer is the genuine noop implementation rather than the OTel global
// delegating tracer - which allocates a non-recording span and consults an
// atomic on every Start, on the delivery path, forever.
//
// A production regression would look like: somebody "simplifying" Tracer() to
// otel.Tracer(), or Setup building a batch processor before checking the
// endpoint - a goroutine retrying a connection to a collector that will never
// exist, in every pod, in every deployment that has not opted in.
func TestTracingDisabledIsTheNoopImplementation(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")

	cfg := FromEnv("worker", "wrk_1", "test")
	if cfg.Endpoint != "" {
		t.Fatalf("Endpoint = %q with both OTLP variables unset", cfg.Endpoint)
	}

	provider, err := Setup(context.Background(), cfg, nil)
	if err != nil {
		t.Fatalf("Setup with no endpoint returned an error: %v", err)
	}
	if provider.tp != nil {
		t.Fatal("Setup built an SDK tracer provider with no endpoint configured; " +
			"that is an exporter and a batch goroutine in every pod that never asked for one")
	}
	if err := provider.Shutdown(); err != nil {
		t.Fatalf("Shutdown of a disabled provider returned an error: %v", err)
	}
	if Enabled() {
		t.Fatal("Enabled() is true with tracing off")
	}

	// The tracer must be the noop implementation, by identity.
	if Tracer() != noopTracer {
		t.Fatalf("Tracer() = %T, want the noop tracer; a delegating tracer puts an "+
			"allocation and an atomic load on every span start on the delivery path", Tracer())
	}

	// And a span started from it must produce no context to store.
	ctx, span := Tracer().Start(context.Background(), "anything")
	defer span.End()
	if span.IsRecording() {
		t.Fatal("the noop tracer produced a recording span")
	}
	if got := Encode(ctx); got != "" {
		t.Fatalf("Encode of a noop span = %q, want \"\" (the column must be NULL)", got)
	}
	if got := SampledTraceID(ctx); got != "" {
		t.Fatalf("SampledTraceID of a noop span = %q, want \"\"", got)
	}
}

// TestEncodeDecodeRoundTripsThroughAColumn pins the wire format the three
// stages agree on. The value spends hours in PostgreSQL between writer and
// reader, so a change to either side that the other does not make is a silently
// broken chain rather than a compile error.
func TestEncodeDecodeRoundTripsThroughAColumn(t *testing.T) {
	for _, sampled := range []bool{true, false} {
		stored := remoteContext(t, sampled)
		if len(stored) != 55 {
			t.Fatalf("traceparent is %d bytes (%q), want the fixed 55 the migration's "+
				"column comment promises", len(stored), stored)
		}
		back := Decode(stored)
		if !back.IsValid() {
			t.Fatalf("Decode(%q) produced an invalid span context", stored)
		}
		if !back.IsRemote() {
			t.Fatal("a decoded stored context is not marked remote; the SDK would treat " +
				"it as a local parent and sample it as one")
		}
		if back.IsSampled() != sampled {
			t.Fatalf("sampled flag = %v, want %v: the flag is what carries the "+
				"upstream's decision to the next stage", back.IsSampled(), sampled)
		}
		if got := EncodeSpanContext(back); got != stored {
			t.Fatalf("re-encode = %q, want %q", got, stored)
		}
	}
}

// TestDecodeDegradesToNoUpstream: every shape a column can hold that is not a
// traceparent must yield "no upstream" rather than an error or a panic. Rows
// written before the migration hold NULL, and a hand-edited or truncated value
// must not be able to stop a delivery.
func TestDecodeDegradesToNoUpstream(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"null column":      "",
		"truncated":        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba9",
		"garbage":          "not-a-traceparent",
		"all zero trace":   "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
		"all zero span":    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
		"absurdly long":    "00-" + strings.Repeat("a", 4096),
		"unsupported vers": "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
	}
	for name, stored := range cases {
		t.Run(name, func(t *testing.T) {
			if sc := Decode(stored); sc.IsValid() {
				t.Fatalf("Decode(%q) reported a valid context; a corrupt column must "+
					"degrade to an unlinked root, never to a link that points nowhere", stored)
			}
		})
	}
}

// TestStageRootLinksInsteadOfParenting is the core propagation assertion.
//
// A stage that became a CHILD of the stored context instead of a linked root
// would compile, pass every behavioural test in the repository, and quietly
// produce traces whose duration is the whole life of a retry chain - poisoning
// every latency percentile computed from them - while coupling the delivery's
// sampling to a decision made hours earlier at ingest.
func TestStageRootLinksInsteadOfParenting(t *testing.T) {
	rec := record(t, sdktrace.AlwaysSample())
	stored := remoteContext(t, true)
	upstream := Decode(stored)

	_, span := StartStage(context.Background(), "webhook.fan_out", StageOptions{
		Upstream: stored,
		Kind:     trace.SpanKindConsumer,
	})
	span.End()

	spans := rec.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	got := spans[0]

	if got.Parent().IsValid() {
		t.Fatalf("the stage root has parent %s: it must be a NEW ROOT, or a delivery "+
			"attempted six hours after the 202 becomes part of that HTTP request's trace",
			got.Parent().SpanID())
	}
	if got.SpanContext().TraceID() == upstream.TraceID() {
		t.Fatal("the stage root reused the upstream trace id; a fan-out of 2000 " +
			"deliveries with their retries would then be one trace no backend assembles")
	}
	if len(got.Links()) != 1 {
		t.Fatalf("recorded %d links, want exactly 1 pointing at the upstream stage", len(got.Links()))
	}
	if link := got.Links()[0].SpanContext; link.TraceID() != upstream.TraceID() ||
		link.SpanID() != upstream.SpanID() {
		t.Fatalf("link points at %s/%s, want %s/%s",
			link.TraceID(), link.SpanID(), upstream.TraceID(), upstream.SpanID())
	}
	if got.SpanKind() != trace.SpanKindConsumer {
		t.Fatalf("span kind = %v, want consumer", got.SpanKind())
	}
}

// TestStageRootWithNoUpstreamHasNoLink: a row written before the migration, or
// with tracing off, carries no context. That must produce an ordinary root with
// no dangling link, not a link to the zero span context.
func TestStageRootWithNoUpstreamHasNoLink(t *testing.T) {
	rec := record(t, sdktrace.AlwaysSample())
	_, span := StartStage(context.Background(), "webhook.delivery.attempt", StageOptions{
		Kind: trace.SpanKindConsumer,
	})
	span.End()

	spans := rec.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	if n := len(spans[0].Links()); n != 0 {
		t.Fatalf("recorded %d links for a row with no stored context, want 0", n)
	}
}

// TestSamplerKeepsRetriesAndUpstreamSampledWork is the sampling contract.
//
// The ratio is set to zero, so the ONLY spans that survive are the ones this
// design deliberately samples in. Anything else surviving means the ratio is
// not being consulted; anything here NOT surviving means the 2am delivery is
// invisible.
func TestSamplerKeepsRetriesAndUpstreamSampledWork(t *testing.T) {
	cases := []struct {
		name string
		opts StageOptions
		want bool
		why  string
	}{
		{
			name: "first attempt, upstream not sampled",
			opts: StageOptions{Upstream: remoteContext(t, false)},
			want: false,
			why:  "the ordinary case is what the ratio exists to thin out",
		},
		{
			name: "upstream was sampled",
			opts: StageOptions{Upstream: remoteContext(t, true)},
			want: true,
			why: "a kept trace must be COMPLETE; three independent 5% decisions " +
				"give the whole story one time in eight thousand",
		},
		{
			name: "retry",
			opts: StageOptions{Upstream: remoteContext(t, false), Retry: true},
			want: true,
			why: "every attempt after the first exists because something went wrong; " +
				"this is the error path a head sampler can actually see",
		},
		{
			name: "recovery",
			opts: StageOptions{Upstream: remoteContext(t, false), Recovery: true},
			want: true,
			why:  "a re-claimed outbox row is a row whose first claim failed",
		},
		{
			name: "no upstream at all",
			opts: StageOptions{},
			want: false,
			why:  "an absent context is not evidence of anything worth keeping",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := record(t, NewSampler(0))
			_, span := StartStage(context.Background(), "stage", tc.opts)
			span.End()
			if got := len(rec.Ended()) == 1; got != tc.want {
				t.Fatalf("sampled = %v, want %v: %s", got, tc.want, tc.why)
			}
		})
	}
}

// TestSamplerIgnoresCallerSuppliedLinks is the security half of the sampling
// design.
//
// A publisher may send a `traceparent` header, and ingest records it as a LINK.
// If the sampler honoured a link's sampled flag, any caller could set `-01` on
// every request and force this platform to record and export 100% of its own
// internal spans - a denial-of-wallet against our collector, from outside, with
// no credential beyond the ability to POST an event.
//
// The sampler reads AttrSampleIn and nothing else. This pins that.
func TestSamplerIgnoresCallerSuppliedLinks(t *testing.T) {
	rec := record(t, NewSampler(0))
	caller := Decode(remoteContext(t, true))

	_, span := StartStage(context.Background(), "ingest", StageOptions{
		Kind:  trace.SpanKindServer,
		Links: []trace.Link{{SpanContext: caller}},
		// No Upstream: this stage has no INTERNAL cause. The caller's context
		// is a link and must not be treated as one.
	})
	span.End()

	if n := len(rec.Ended()); n != 0 {
		t.Fatalf("recorded %d spans: a caller-supplied sampled traceparent forced "+
			"sampling, which hands every publisher a switch that turns on 100%% "+
			"trace export for this platform", n)
	}
}

// TestInProcessChildrenInheritTheStageDecision: the outbound POST span and the
// persist span must not be sampled independently of the stage they belong to,
// or a kept attempt would have a hole where its HTTP call should be.
func TestInProcessChildrenInheritTheStageDecision(t *testing.T) {
	rec := record(t, NewSampler(0))

	ctx, stage := StartStage(context.Background(), "webhook.delivery.attempt", StageOptions{Retry: true})
	_, child := Start(ctx, "webhook.delivery.http")
	child.End()
	stage.End()

	if n := len(rec.Ended()); n != 2 {
		t.Fatalf("recorded %d spans, want 2: an in-process child of a sampled-in "+
			"stage must inherit the decision, not re-roll the ratio", n)
	}
}

// TestSampledTraceIDIsEmptyForAnUnsampledSpan.
//
// delivery_attempts.trace_id is a promise the trace backend has to keep.
// Recording the id of a dropped span puts a link in the operator UI that leads
// to an empty page, from which the operator concludes the backend is broken
// rather than that this attempt was not recorded.
func TestSampledTraceIDIsEmptyForAnUnsampledSpan(t *testing.T) {
	record(t, NewSampler(0))

	ctx, span := StartStage(context.Background(), "webhook.delivery.attempt", StageOptions{})
	defer span.End()
	if got := SampledTraceID(ctx); got != "" {
		t.Fatalf("SampledTraceID = %q for an unsampled span, want \"\"", got)
	}
	if got := TraceID(ctx); got == "" {
		t.Fatal("TraceID is empty for an unsampled span; the id still exists and " +
			"still belongs on the log line, it just must not be persisted as a link")
	}

	record(t, NewSampler(1))
	ctx2, span2 := StartStage(context.Background(), "webhook.delivery.attempt", StageOptions{})
	defer span2.End()
	if got := SampledTraceID(ctx2); len(got) != 32 {
		t.Fatalf("SampledTraceID = %q for a sampled span, want a 32-hex trace id", got)
	}
}

// TestEndpointHostNeverLeaksAPathQueryOrCredential.
//
// A customer's endpoint URL routinely carries a token in its query string -
// this is precisely why internal/worker logs the host and not the URL. A span
// attribute is exported to a third-party telemetry backend and is if anything
// worse than a log line.
func TestEndpointHostNeverLeaksAPathQueryOrCredential(t *testing.T) {
	cases := map[string]string{
		"https://api.customer.com/hooks?token=SECRET": "api.customer.com",
		"https://api.customer.com:8443/a/b#frag":      "api.customer.com:8443",
		"http://user:hunter2@api.customer.com/hooks":  "api.customer.com",
		"https://api.customer.com":                    "api.customer.com",
		"api.customer.com/hooks?sig=abc":              "api.customer.com",
	}
	for raw, want := range cases {
		if got := EndpointHost(raw); got != want {
			t.Fatalf("EndpointHost(%q) = %q, want %q", raw, got, want)
		}
		if strings.ContainsAny(EndpointHost(raw), "?#@") {
			t.Fatalf("EndpointHost(%q) kept a query, fragment or credential", raw)
		}
	}
}

// TestSetupRejectsNothingAnOperatorCanShrugAt: an out-of-range sampler argument
// must fall back to the default rather than refuse to start. Configuration that
// only changes what is OBSERVED must never be able to take the data plane down.
func TestSetupFallsBackRatherThanRefusingToStart(t *testing.T) {
	t.Setenv("DATA_PLANE_OTEL_TRACES_SAMPLER_ARG", "not-a-number")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	if got := FromEnv("router", "rtr_1", "test").SampleRatio; got != DefaultSampleRatio {
		t.Fatalf("SampleRatio = %v for an unparseable value, want the default %v", got, DefaultSampleRatio)
	}

	t.Setenv("DATA_PLANE_OTEL_TRACES_SAMPLER_ARG", "5")
	if got := FromEnv("router", "rtr_1", "test").SampleRatio; got != DefaultSampleRatio {
		t.Fatalf("SampleRatio = %v for an out-of-range value, want the default %v", got, DefaultSampleRatio)
	}
}

// TestSignalSpecificEndpointAloneEnablesTracing: the OTLP specification lets an
// operator set only OTEL_EXPORTER_OTLP_TRACES_ENDPOINT. Gating on the general
// variable alone would ship a control that lies - the operator configures an
// endpoint and gets silence.
func TestSignalSpecificEndpointAloneEnablesTracing(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://collector:4318/v1/traces")
	if got := FromEnv("ingest", "ing_1", "test").Endpoint; got == "" {
		t.Fatal("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT alone did not enable tracing")
	}
}

// TestLoggerAttachesTheTraceIDAndIsATrueNoopWhenTracingIsOff.
// ARCHITECTURE.md 63 requires structured logs AND traces; this is the seam. A
// deployment with tracing off must produce byte-identical log lines.
func TestLoggerIsTheSeamBetweenLogsAndTraces(t *testing.T) {
	if got := Logger(context.Background(), nil); got != nil {
		t.Fatal("Logger added fields to a context with no span")
	}

	record(t, sdktrace.AlwaysSample())
	ctx, span := StartStage(context.Background(), "stage", StageOptions{})
	defer span.End()
	if TraceID(ctx) == "" {
		t.Fatal("TraceID is empty inside a recorded stage span")
	}
}

// TestDisabledStageStartCostsNoAllocations is the quantitative half of the
// "compiles to approximately nothing" requirement.
//
// StartStage sits on the ingest hot path and on the delivery hot path. Every
// allocation it makes with tracing OFF is paid by every deployment that never
// asked for traces, on the two paths whose latency budgets are already spoken
// for. The bound is deliberately zero rather than "small": once a number above
// zero is acceptable, nothing stops it growing an attribute at a time.
//
// Note that the CALLER's attribute slice is not measured here - it is a slice
// literal at the call site and is the one cost this design accepts. What this
// pins is that nothing beyond it is paid: no traceparent parse, no link slice,
// no option slice, no span object.
func TestDisabledStageStartCostsNoAllocations(t *testing.T) {
	if Enabled() {
		t.Fatal("tracing is enabled at the start of this test; a previous test leaked its provider")
	}
	stored := remoteContext(t, true)

	allocs := testing.AllocsPerRun(200, func() {
		ctx, span := StartStage(context.Background(), "webhook.delivery.attempt", StageOptions{
			Upstream: stored,
			Kind:     trace.SpanKindConsumer,
			Retry:    true,
		})
		span.End()
		_ = Encode(ctx)
	})
	if allocs > 0 {
		t.Fatalf("StartStage allocated %.0f times per call with tracing disabled; every "+
			"one of those is paid by every accepted event and every delivery attempt in "+
			"every deployment that never configured a collector", allocs)
	}
}

// TestTheDataPlaneDoesNotInheritTheControlPlanesIdentityOrSamplingRatio.
//
// The two planes share one .env in development and one ConfigMap in production.
// OTEL_SERVICE_NAME and OTEL_TRACES_SAMPLER_ARG are per-PROCESS settings that
// two processes cannot both be right about, and .env.example already sets both
// for the control plane: `control-api`, and a ratio of 1.
//
// Inheriting the first makes every delivery span claim to come from the control
// plane. Inheriting the second records a span for every attempt of every
// delivery of every event, turning a control-plane tuning choice into a
// data-plane incident. Neither failure is visible until somebody opens the
// backend, or the bill.
func TestTheDataPlaneDoesNotInheritTheControlPlanesIdentityOrSamplingRatio(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "control-api")
	t.Setenv("OTEL_TRACES_SAMPLER_ARG", "1")

	cfg := FromEnv("worker", "wrk_1", "production")
	if cfg.ServiceName != "data-plane" {
		t.Fatalf("service name = %q; the data plane inherited the control plane's "+
			"OTEL_SERVICE_NAME from the shared environment", cfg.ServiceName)
	}
	if cfg.SampleRatio != DefaultSampleRatio {
		t.Fatalf("sample ratio = %v; the data plane inherited the control plane's "+
			"OTEL_TRACES_SAMPLER_ARG of 1, which is a span for every attempt of every "+
			"delivery of every event", cfg.SampleRatio)
	}

	// And the namespaced keys DO apply, or the knob is one that lies.
	t.Setenv("DATA_PLANE_OTEL_SERVICE_NAME", "data-plane-worker")
	t.Setenv("DATA_PLANE_OTEL_TRACES_SAMPLER_ARG", "0.5")
	cfg = FromEnv("worker", "wrk_1", "production")
	if cfg.ServiceName != "data-plane-worker" {
		t.Fatalf("service name = %q, want data-plane-worker", cfg.ServiceName)
	}
	if cfg.SampleRatio != 0.5 {
		t.Fatalf("sample ratio = %v, want 0.5", cfg.SampleRatio)
	}

	// The namespace IS shared, and correctly so: both planes belong to it.
	t.Setenv("OTEL_SERVICE_NAMESPACE", "hookubit")
	if got := FromEnv("worker", "wrk_1", "production").ServiceNamespace; got != "hookubit" {
		t.Fatalf("service namespace = %q, want the shared hookubit", got)
	}
}

// TestAnUnusableCollectorURLDisablesTracingLoudlyRatherThanSilently.
//
// `otel-collector:4318` - no scheme - parses as a URL whose SCHEME is
// `otel-collector`. An exporter built from it starts cleanly and exports
// nothing for ever, which is the worst outcome available: the operator
// configured tracing, the process said nothing, and the traces are not there
// the night they are needed. It is the same class of defect as a knob that is
// read and ignored.
//
// This warns rather than refusing to start, unlike the control plane's check.
// The asymmetry is the point: a control plane that will not start is a
// dashboard nobody can open; a data plane that will not start is accepted
// events nobody delivers.
func TestAnUnusableCollectorURLDisablesTracingLoudlyRatherThanSilently(t *testing.T) {
	for _, endpoint := range []string{
		"otel-collector:4318",
		"grpc://otel-collector:4317",
		"://nonsense",
		"http://",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if endpointProblem(endpoint) == "" {
				t.Fatalf("endpointProblem(%q) = \"\": this would build an exporter that "+
					"never exports anything and never says so", endpoint)
			}
			p, err := Setup(context.Background(), Config{Endpoint: endpoint}, nil)
			if err != nil {
				t.Fatalf("Setup refused to return: a telemetry misconfiguration must not "+
					"be able to stop the data plane (%v)", err)
			}
			if p.tp != nil {
				t.Fatal("an exporter was built for an unusable endpoint")
			}
			if Enabled() {
				t.Fatal("tracing reports enabled with an unusable endpoint")
			}
		})
	}

	for _, endpoint := range []string{
		"http://otel-collector:4318",
		"https://otel.example.com",
		"http://otel-collector:4318/v1/traces",
	} {
		if got := endpointProblem(endpoint); got != "" {
			t.Fatalf("endpointProblem(%q) = %q, want \"\"", endpoint, got)
		}
	}
}

// TestTheValidatedEndpointIsTheOneTheExporterWillUse.
//
// The exporter re-reads the OTLP environment itself and gives the
// signal-specific variable precedence. If this package validated the general
// one instead, the check would pass while the URL actually in use was broken -
// a control that lies about a control that lies.
func TestTheValidatedEndpointIsTheOneTheExporterWillUse(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://good-collector:4318")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "otel-collector:4318")

	cfg := FromEnv("worker", "wrk_1", "test")
	if cfg.Endpoint != "otel-collector:4318" {
		t.Fatalf("Endpoint = %q; the signal-specific variable takes precedence, so it "+
			"is the one that has to be validated", cfg.Endpoint)
	}
	if endpointProblem(cfg.Endpoint) == "" {
		t.Fatal("the scheme-less signal-specific endpoint was accepted")
	}
}
