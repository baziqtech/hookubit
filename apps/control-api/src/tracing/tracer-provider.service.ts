import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { createThrottledDiagLogger } from './otel-diagnostics';
import { TracingSettings, readTracingSettings } from './tracing.config';
import { setTracingEnabled } from './tracing.runtime';

/**
 * How long shutdown will wait for queued spans to reach the collector.
 *
 * `provider.shutdown()` flushes, and a flush against a collector that is gone
 * costs the exporter's own timeout plus its retries - comfortably longer than
 * the grace period a scheduler gives a pod. Telemetry must never be the reason
 * `SIGTERM` turns into `SIGKILL`, so the flush is raced against this and the
 * remaining spans are dropped. Losing a trace during shutdown is a cost;
 * losing an in-flight HTTP request to a hard kill is a defect.
 */
export const TRACE_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Builds - or deliberately does not build - the OpenTelemetry tracer provider.
 *
 * ## Inert without a collector, and inert means nothing was constructed
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` unset there is no exporter, no span
 * processor, no timer and no provider: `register()` is never called, the global
 * tracer stays the API's no-op, and `isTracingEnabled()` stays false so the
 * instrumentation points short-circuit on a boolean. This is stronger than
 * "configured with a null exporter" - there is no object that could retry
 * against a collector that does not exist, and nothing that could be flushed.
 *
 * ## Nothing here may fail boot
 *
 * Every step is inside one try/catch that ends in "log it and stay off". A
 * malformed resource, an exporter constructor that throws, a global provider
 * that is somehow already registered - all of them leave a control plane that
 * serves requests without traces, which is the correct trade. `env.schema.ts`
 * is where a bad OTEL value is supposed to stop a deploy, and it does that at
 * validation time, before any of this runs.
 *
 * Boot is not delayed either: constructing an OTLP/HTTP exporter opens no
 * connection, and `BatchSpanProcessor` starts its timer on the first span.
 */
@Injectable()
export class TracerProviderService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Tracing');
  private provider: NodeTracerProvider | null = null;
  private settings: TracingSettings | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Everything, INCLUDING reading the configuration, is inside the try. A
    // control plane that refused to boot because it could not work out whether
    // to trace would be the worst possible outcome of adding telemetry.
    try {
      const settings = readTracingSettings(this.config);
      this.settings = settings;

      if (!settings.enabled) {
        setTracingEnabled(false);
        this.logger.log(
          'tracing: OFF - OTEL_EXPORTER_OTLP_ENDPOINT is not set, so no exporter, span processor ' +
            'or tracer provider is created. Set it to a collector base URL (for example ' +
            'http://otel-collector:4318) to turn tracing on.',
        );
        return;
      }

      // Wired only when tracing is on, so an install with no collector never
      // takes over the process-wide diag logger. WARN, not DEBUG: the SDK is
      // extremely chatty below that and none of it is actionable.
      diag.setLogger(createThrottledDiagLogger(this.logger), DiagLogLevel.WARN);

      const provider = new NodeTracerProvider({
        resource: defaultResource().merge(
          resourceFromAttributes({
            [ATTR_SERVICE_NAME]: settings.serviceName,
            [ATTR_SERVICE_NAMESPACE]: settings.serviceNamespace,
            [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
            [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: settings.deploymentEnvironment,
          }),
        ),
        // Parent-based, with the REMOTE parent capped at the same ratio.
        //
        // `traceparent` is an unauthenticated request header on an
        // internet-facing control plane, and the default ParentBasedSampler
        // records anything whose parent says `sampled`. That hands any caller -
        // including one being refused at the login rate limiter - a switch that
        // sets our span volume, and therefore our telemetry bill. Capping the
        // remote-parent branch at the configured ratio keeps upstream traces
        // joined up (same trace id, same propagation) without letting a header
        // choose how much we record. At the default ratio of 1 the two
        // behaviours are identical; the cap only bites for an operator who has
        // deliberately turned sampling down, which is exactly when they meant it.
        sampler: parentBasedRatio(settings.samplerRatio),
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ url: settings.tracesUrl as string })),
        ],
      });

      // Registers the global tracer provider, the W3C trace-context propagator
      // and - the part that matters most here - the AsyncLocalStorage context
      // manager, without which the span started in the HTTP middleware would
      // not be the active span inside a controller's awaited database call.
      provider.register();
      this.provider = provider;
      setTracingEnabled(true);

      this.logger.log(
        `tracing: ON - exporting to ${settings.tracesUrl} as ` +
          `${settings.serviceNamespace}/${settings.serviceName} at sampler ratio ` +
          `${settings.samplerRatio}. Export failures are logged once a minute and never ` +
          'reach a request.',
      );
    } catch (err) {
      setTracingEnabled(false);
      this.provider = null;
      this.logger.error(
        `tracing: FAILED to start and is off; the API is unaffected. ${String(err)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    // Stop minting spans before draining, so the flush has a fixed amount of
    // work rather than a queue a still-serving request keeps topping up.
    setTracingEnabled(false);
    if (!provider) return;

    try {
      await withTimeout(provider.shutdown(), TRACE_SHUTDOWN_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(`tracing: shutdown did not complete cleanly: ${String(err)}`);
    }
  }

  /** For tests and for the module's own boot log. */
  currentSettings(): TracingSettings | null {
    return this.settings;
  }
}

function parentBasedRatio(ratio: number): ParentBasedSampler {
  const ratioSampler = new TraceIdRatioBasedSampler(ratio);
  return new ParentBasedSampler({
    root: ratioSampler,
    remoteParentSampled: ratioSampler,
    remoteParentNotSampled: new AlwaysOffSampler(),
    // A LOCAL parent is our own decision, already made by one of the branches
    // above. Re-sampling it would produce a trace with its own middle missing.
    localParentSampled: new AlwaysOnSampler(),
    localParentNotSampled: new AlwaysOffSampler(),
  });
}

/**
 * The timer is `unref`'d so that losing the race cannot itself be the thing
 * that holds the event loop open during shutdown.
 */
export async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`span flush exceeded ${ms}ms`)), ms);
    timer.unref();
  });
  try {
    await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
