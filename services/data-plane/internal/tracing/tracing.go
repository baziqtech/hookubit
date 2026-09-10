// Package tracing is the data plane's OpenTelemetry wiring (ARCHITECTURE.md 44).
//
// # Why this package exists at all
//
// A webhook's life crosses three ASYNCHRONOUS process boundaries, each of them
// separated by a database write and an arbitrary amount of time:
//
//	ingest  (COMMIT event + outbox row, return 202)
//	  ->  router  (claim the outbox row, materialise the fan-out)
//	        ->  worker  (claim the delivery, sign, POST)
//
// Nothing in-process survives those boundaries. There is no goroutine, no
// channel and no request context linking the 202 a customer received at 09:00
// to the retry that finally succeeded at 15:00 on a different pod. A trace that
// stops at the 202 tells an operator what they already knew. So the W3C trace
// context is carried THROUGH POSTGRESQL, on the same rows that carry the work -
// see context.go for the encoding and doc.go for the propagation design.
//
// # The rule that outranks every other consideration here
//
// TRACING IS NEVER ON THE CRITICAL PATH. Not the exporter, not the collector,
// not the endpoint being wrong, not the endpoint being absent. Concretely:
//
//   - With OTEL_EXPORTER_OTLP_ENDPOINT unset, Setup builds NOTHING. No
//     exporter, no batch processor, no goroutine, no global provider. Tracer()
//     hands back noop.Tracer{}, which is a struct with no fields whose Start
//     returns the context it was given. It is not the OTel global delegating
//     tracer - that one allocates a non-recording span per call and consults an
//     atomic on every Start. This is the "compiles to approximately nothing"
//     requirement, and TestDisabledTracerIsTheNoopImplementation pins it.
//
//   - With an endpoint set, spans go through a BatchSpanProcessor whose queue is
//     bounded and NON-BLOCKING. When the collector is down and the queue fills,
//     spans are DROPPED. That is the correct failure: a webhook platform that
//     slows a delivery because a telemetry sidecar is unhealthy has inverted its
//     own priorities.
//
//   - Every error the SDK raises goes to the logger at WARN and nowhere else.
//     otel.SetErrorHandler is installed for exactly that reason: the default
//     handler writes to the global logger, and an export failure loop must not
//     be able to become an operator's paging story.
package tracing

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// ScopeName is the instrumentation scope every data-plane span is emitted
// under. One scope for the whole service: the span NAME says which stage
// produced it, and splitting the scope would only make a backend query harder.
const ScopeName = "github.com/shaq/hookubit/services/data-plane"

// Defaults. Each is a bound, and each is here rather than implicit.
const (
	// DefaultSampleRatio is the head-sampling ratio for a stage root whose
	// upstream context was NOT sampled and which is not a retry. Five percent
	// is a starting point, not a measurement; see doc.go for what is sampled
	// IN regardless, which is the part that matters.
	DefaultSampleRatio = 0.05

	// DefaultExportTimeout bounds ONE export round trip to the collector.
	// Short on purpose: the exporter retries, and a long timeout only makes a
	// dead collector hold the queue longer before it starts dropping.
	DefaultExportTimeout = 5 * time.Second

	// DefaultShutdownTimeout bounds the final flush (ARCHITECTURE.md 47, step
	// 6). It must stay well inside the process shutdown grace: losing the last
	// batch of spans costs an operator some detail, and missing the exit
	// deadline costs a SIGKILL mid-write.
	DefaultShutdownTimeout = 3 * time.Second

	// DefaultMaxQueueSize bounds spans held in memory awaiting export. At the
	// shipped sampling ratio this is minutes of arrears; past it, spans are
	// dropped rather than queued, which is the point.
	DefaultMaxQueueSize = 4096
)

// Config is everything Setup needs. It is built by FromEnv; the struct is
// exported so a test can construct one without touching the environment.
type Config struct {
	// Endpoint is OTEL_EXPORTER_OTLP_ENDPOINT (or the signal-specific
	// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT). EMPTY MEANS DISABLED, and disabled
	// means nothing is built - see the package comment.
	//
	// It is only a GATE. The exporter itself re-reads the standard
	// OTEL_EXPORTER_OTLP_* environment (endpoint, headers, compression, TLS,
	// timeout), so an operator gets the whole specified surface without this
	// package growing a knob per field.
	Endpoint string

	ServiceName      string
	ServiceNamespace string
	// Role is the webhookd subcommand: ingest, router, scheduler, worker, all.
	// A resource attribute rather than part of service.name, because the roles
	// are one binary and one deployable unit until somebody splits them.
	Role        string
	InstanceID  string
	Environment string

	SampleRatio     float64
	ExportTimeout   time.Duration
	ShutdownTimeout time.Duration
	MaxQueueSize    int
}

// FromEnv reads the tracing configuration.
//
// It is deliberately NOT part of config.Load. Every other knob in that file is
// something whose absence changes how deliveries behave; these change only what
// is observed, and a mistyped one must never be able to stop the data plane
// starting. So nothing here is validated into a startup failure: an
// unparseable ratio falls back to the default and says so.
func FromEnv(role, instanceID, appEnv string) Config {
	// The signal-specific variable takes PRECEDENCE, which is what the OTLP
	// specification says and, more importantly, what the exporter itself does
	// when it re-reads the environment. Checking the general one first would
	// mean this package validated a URL the exporter was not going to use - a
	// check that passes while the thing it is checking is broken.
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
	if endpoint == "" {
		endpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	}
	return Config{
		Endpoint: endpoint,

		// TWO KEYS ARE DELIBERATELY NAMESPACED, and it is not tidiness.
		//
		// The control plane and the data plane share one .env in development
		// and routinely share one ConfigMap in production, and the OTLP
		// specification's bare names are per-PROCESS settings that two
		// processes cannot both be right about:
		//
		//   OTEL_SERVICE_NAME       .env.example sets it to `control-api`.
		//                           Inheriting it makes every delivery span
		//                           claim to come from the control plane, which
		//                           is the exact confusion service.name exists
		//                           to prevent.
		//   OTEL_TRACES_SAMPLER_ARG the control plane ships 1: its traffic is
		//                           human-paced and complete traces are cheap.
		//                           The data plane at 1 records a span for
		//                           every attempt of every delivery of every
		//                           event. Inheriting it turns a control-plane
		//                           tuning choice into a data-plane incident.
		//
		// So these follow DATA_PLANE_METRICS_PORT's precedent and are read
		// under a DATA_PLANE_ prefix, with NO fallback to the bare names -
		// falling back would reintroduce exactly the inheritance above.
		ServiceName: envOr("DATA_PLANE_OTEL_SERVICE_NAME", "data-plane"),
		SampleRatio: envRatio("DATA_PLANE_OTEL_TRACES_SAMPLER_ARG", DefaultSampleRatio),

		// These ARE shared, correctly. Both planes should reach the same
		// collector, sit in the same namespace, and use the same export
		// deadline; there is nothing per-process about any of them. The
		// exporter re-reads the rest of the OTEL_EXPORTER_OTLP_* environment
		// (headers, compression, TLS) itself, which is also shared and also
		// right.
		ServiceNamespace: os.Getenv("OTEL_SERVICE_NAMESPACE"),
		ExportTimeout:    envMillis("OTEL_EXPORTER_OTLP_TIMEOUT", DefaultExportTimeout),
		// Read here as well as by the SDK's own BatchSpanProcessor defaults, so
		// the value this process actually uses is the one it logs at startup.
		MaxQueueSize: envInt("OTEL_BSP_MAX_QUEUE_SIZE", DefaultMaxQueueSize),

		Role:            role,
		InstanceID:      instanceID,
		Environment:     appEnv,
		ShutdownTimeout: DefaultShutdownTimeout,
	}
}

// Provider owns whatever Setup built. The zero value is a valid DISABLED
// provider, so a caller that never ran Setup - a test, a one-shot command - is
// already correct.
type Provider struct {
	tp  *sdktrace.TracerProvider
	cfg Config
	log *slog.Logger
}

// tracer is the process-wide tracer. It is an atomic rather than a plain
// variable because Setup runs on the main goroutine while the roles that read
// it are already being constructed, and because the tests swap it.
//
// Its ZERO STATE is the noop tracer, not the OTel global. See the package
// comment: reaching for otel.Tracer() when tracing is off would put a
// delegating indirection and a per-call allocation on the delivery path to
// produce nothing.
var (
	// The holder indirection is not decoration: atomic.Value panics when two
	// different CONCRETE types are stored into it, and the whole point of this
	// variable is that it holds a noop.Tracer at rest and an SDK tracer once
	// Setup has run.
	tracer  atomic.Pointer[tracerHolder]
	enabled atomic.Bool
)

type tracerHolder struct{ t trace.Tracer }

var noopTracer trace.Tracer = noop.NewTracerProvider().Tracer(ScopeName)

func init() { tracer.Store(&tracerHolder{t: noopTracer}) }

// Tracer returns the tracer every data-plane span is started from.
func Tracer() trace.Tracer {
	h := tracer.Load()
	if h == nil {
		return noopTracer
	}
	return h.t
}

// Enabled reports whether spans are actually being recorded. Callers use it to
// skip work that exists ONLY to decorate a span - never to skip work that has
// any other purpose.
func Enabled() bool { return enabled.Load() }

// Setup builds the tracer provider, or returns a disabled one.
//
// It NEVER returns an error for a reason an operator could shrug at. The only
// error it can return is a genuinely unbuildable exporter, and even that is
// handled by the caller as a warning rather than a refusal to start: see
// cmd/webhookd. A data plane that will not boot because a collector URL has a
// typo is a worse outage than the missing traces.
func Setup(ctx context.Context, cfg Config, log *slog.Logger) (*Provider, error) {
	if log == nil {
		log = slog.Default()
	}
	if cfg.Endpoint == "" {
		log.Info("tracing is disabled",
			"reason", "OTEL_EXPORTER_OTLP_ENDPOINT is not set",
			"effect", "spans are not recorded and no exporter is started")
		return &Provider{cfg: cfg, log: log}, nil
	}

	if reason := endpointProblem(cfg.Endpoint); reason != "" {
		// The likeliest operator mistake, and the peer instrumenting the
		// control plane refuses to boot on it. This one only warns, and the
		// asymmetry is deliberate: a control plane that will not start is a
		// dashboard nobody can open, while a data plane that will not start is
		// accepted events nobody delivers. Refusing here would let a typo in a
		// telemetry URL stop webhooks.
		//
		// But it is not silent, because silence is what this is guarding
		// against: `otel-collector:4318` parses as a URL whose SCHEME is
		// `otel-collector`, so an exporter built from it would start cleanly
		// and export nothing for ever.
		log.Error("OTEL_EXPORTER_OTLP_ENDPOINT is not a usable collector URL; tracing is DISABLED",
			"endpoint", cfg.Endpoint,
			"problem", reason,
			"expected", "a base URL with an http or https scheme, e.g. http://otel-collector:4318",
			"effect", "no spans are exported; deliveries and metrics are unaffected")
		return &Provider{cfg: Config{}, log: log}, nil
	}

	if cfg.SampleRatio <= 0 || cfg.SampleRatio > 1 {
		log.Warn("OTEL_TRACES_SAMPLER_ARG is outside (0,1]; using the default",
			"configured", cfg.SampleRatio, "using", DefaultSampleRatio)
		cfg.SampleRatio = DefaultSampleRatio
	}
	if cfg.ExportTimeout <= 0 {
		cfg.ExportTimeout = DefaultExportTimeout
	}
	if cfg.MaxQueueSize <= 0 {
		cfg.MaxQueueSize = DefaultMaxQueueSize
	}

	// The exporter is built UNSTARTED and connected lazily by the provider, so
	// a collector that is not up yet cannot delay process start. otlptracehttp
	// speaks to a URL rather than holding a connection, so there is no dial
	// here to fail and nothing to retry in the background until there are spans
	// to send.
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithTimeout(cfg.ExportTimeout),
	)
	if err != nil {
		return nil, fmt.Errorf("build OTLP trace exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(buildResource(cfg)),
		sdktrace.WithSampler(NewSampler(cfg.SampleRatio)),
		// NOT WithBlocking. A full queue drops spans; it must never park a
		// delivery goroutine waiting for a collector.
		sdktrace.WithBatcher(exporter,
			sdktrace.WithMaxQueueSize(cfg.MaxQueueSize),
			sdktrace.WithExportTimeout(cfg.ExportTimeout),
		),
	)

	// The SDK's own faults - a refused export, a queue overflow - are logged
	// and dropped. They are never returned to a caller and never counted
	// against a delivery.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		log.Warn("opentelemetry error (telemetry only; no delivery is affected)", "error", err)
	}))

	// The global is set as well as the local tracer, so any library that
	// reaches for otel.Tracer() lands in the same provider. Nothing in this
	// repository does; it is set because a future dependency that does must not
	// silently emit into a second, unexported provider.
	otel.SetTracerProvider(tp)
	tracer.Store(&tracerHolder{t: tp.Tracer(ScopeName)})
	enabled.Store(true)

	log.Info("tracing enabled",
		"exporter", "otlp/http",
		"service_name", cfg.ServiceName,
		"service_namespace", cfg.ServiceNamespace,
		"role", cfg.Role,
		"sample_ratio", cfg.SampleRatio,
		"max_queue_size", cfg.MaxQueueSize,
		"export_timeout", cfg.ExportTimeout.String(),
		"on_collector_outage", "spans are dropped; deliveries are unaffected")

	return &Provider{tp: tp, cfg: cfg, log: log}, nil
}

// Shutdown flushes whatever is queued and stops the exporter
// (ARCHITECTURE.md 47, step 6).
//
// It takes its own bounded context rather than the caller's: shutdown is
// reached BECAUSE a context was cancelled, and passing that cancelled context
// straight to ForceFlush would guarantee the last batch is lost - which is
// exactly the batch describing the shutdown an operator is investigating.
func (p *Provider) Shutdown() error {
	if p == nil || p.tp == nil {
		return nil
	}
	timeout := p.cfg.ShutdownTimeout
	if timeout <= 0 {
		timeout = DefaultShutdownTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Back to the noop tracer FIRST. Anything still running during the drain
	// then starts no new spans against a provider that is shutting down.
	tracer.Store(&tracerHolder{t: noopTracer})
	enabled.Store(false)

	if err := p.tp.Shutdown(ctx); err != nil {
		return fmt.Errorf("shut down tracer provider: %w", err)
	}
	return nil
}

// buildResource describes this process to the backend.
//
// Raw attribute keys rather than a semconv import: the semconv package is
// versioned per release and pinning a version here would make a routine
// dependency bump a rename of every resource attribute. These five keys have
// been stable for the life of the specification.
func buildResource(cfg Config) *resource.Resource {
	attrs := []attribute.KeyValue{
		attribute.String("service.name", cfg.ServiceName),
		attribute.String("webhook.role", cfg.Role),
	}
	if cfg.ServiceNamespace != "" {
		attrs = append(attrs, attribute.String("service.namespace", cfg.ServiceNamespace))
	}
	if cfg.InstanceID != "" {
		attrs = append(attrs, attribute.String("service.instance.id", cfg.InstanceID))
	}
	if cfg.Environment != "" {
		attrs = append(attrs, attribute.String("deployment.environment.name", cfg.Environment))
	}
	base := resource.NewSchemaless(attrs...)
	merged, err := resource.Merge(resource.Default(), base)
	if err != nil {
		// A schema-URL conflict between the SDK default and ours. Ours is the
		// one carrying the identity, so keep it and lose the SDK's telemetry.*
		// attributes rather than failing to describe the service at all.
		return base
	}
	return merged
}

// endpointProblem reports why an endpoint is unusable, or "" when it is fine.
//
// It checks the SCHEME and nothing else. Reachability is not checkable at boot
// and must not be: a collector that is down at start-up is a collector that
// comes back, and refusing to start over it would make telemetry load-bearing.
func endpointProblem(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "it is not a URL"
	}
	switch u.Scheme {
	case "http", "https":
	case "":
		return "it has no scheme"
	default:
		return fmt.Sprintf("its scheme is %q, not http or https "+
			"(a bare host:port parses as a URL whose scheme is the hostname)", u.Scheme)
	}
	if u.Host == "" {
		return "it names no host"
	}
	return ""
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func envRatio(key string, fallback float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f <= 0 || f > 1 {
		return fallback
	}
	return f
}

// envMillis reads a millisecond count, matching every other duration knob in
// the data plane (config.envDuration) and the OTLP specification's own unit for
// OTEL_EXPORTER_OTLP_TIMEOUT.
func envMillis(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	ms, err := strconv.Atoi(v)
	if err != nil || ms <= 0 {
		return fallback
	}
	return time.Duration(ms) * time.Millisecond
}

// UseTracer installs a tracer provider as this process's tracer and returns a
// function that restores whatever was there before.
//
// It exists for TESTS, in this package and in the packages that emit spans. An
// unasserted tracing layer silently stops working - a renamed attribute, a span
// that is never ended, a stage that quietly became a child instead of a link -
// and none of that is visible in production until somebody needs a trace and
// there is none. Tests need a recording provider to assert against, and this is
// the seam that lets them install one without Setup, an exporter or a
// collector.
//
// It is NOT a way to enable tracing in production. Setup is.
func UseTracer(tp trace.TracerProvider) (restore func()) {
	prev := Tracer()
	prevEnabled := enabled.Load()
	tracer.Store(&tracerHolder{t: tp.Tracer(ScopeName)})
	enabled.Store(true)
	return func() {
		tracer.Store(&tracerHolder{t: prev})
		enabled.Store(prevEnabled)
	}
}
