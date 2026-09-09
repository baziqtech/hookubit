import { ConfigService } from '@nestjs/config';

/**
 * Everything the tracer provider needs, read once at boot.
 *
 * It is a plain value rather than repeated `ConfigService.get` calls so the
 * "is tracing on?" question has exactly one answer for the life of the process.
 * A request path that re-asked configuration could disagree with the provider
 * that was actually built, which is how you end up with spans that go nowhere.
 */
export interface TracingSettings {
  /** False whenever no OTLP endpoint is configured. Nothing is built. */
  readonly enabled: boolean;
  /** Fully-qualified traces URL, `/v1/traces` appended. Null when disabled. */
  readonly tracesUrl: string | null;
  readonly serviceName: string;
  readonly serviceNamespace: string;
  readonly deploymentEnvironment: string;
  /** Head sampling ratio, 0..1, applied parent-based. */
  readonly samplerRatio: number;
}

export const TRACES_SIGNAL_PATH = '/v1/traces';

/**
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is specified as the BASE endpoint of a
 * collector; each signal appends its own path. Operators reliably supply both
 * shapes anyway - the collector's own docs show `:4318` and half the tutorials
 * show `:4318/v1/traces` - and appending blindly produces
 * `/v1/traces/v1/traces`, a 404 per export batch that is silent by design
 * because export failures must never reach a request.
 *
 * So accept both and normalise. A trailing slash is dropped for the same reason.
 */
export function resolveTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.endsWith(TRACES_SIGNAL_PATH) ? trimmed : `${trimmed}${TRACES_SIGNAL_PATH}`;
}

/**
 * Reads the tracing configuration off an already-validated environment.
 *
 * `env.schema.ts` has already refused to boot on a malformed endpoint or an
 * out-of-range sampler, so the defaults here are for the test harnesses that
 * build a ConfigService with a partial map - not a second, quieter validation
 * layer that could disagree with the first.
 */
export function readTracingSettings(config: ConfigService): TracingSettings {
  const endpoint = config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
  const enabled = typeof endpoint === 'string' && endpoint.trim() !== '';
  const ratio = config.get<number>('OTEL_TRACES_SAMPLER_ARG');

  return {
    enabled,
    tracesUrl: enabled ? resolveTracesUrl(endpoint as string) : null,
    serviceName: config.get<string>('OTEL_SERVICE_NAME') ?? 'control-api',
    serviceNamespace: config.get<string>('OTEL_SERVICE_NAMESPACE') ?? 'webhook-platform',
    deploymentEnvironment: config.get<string>('APP_ENV') ?? 'development',
    samplerRatio: clampRatio(ratio),
  };
}

function clampRatio(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
