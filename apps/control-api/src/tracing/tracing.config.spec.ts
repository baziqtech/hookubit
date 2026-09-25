import { ConfigService } from '@nestjs/config';
import { TRACES_SIGNAL_PATH, readTracingSettings, resolveTracesUrl } from './tracing.config';

const OTEL_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_NAMESPACE',
  'OTEL_TRACES_SAMPLER_ARG',
] as const;

/**
 * `ConfigService.get` consults `process.env` before its own map, so a developer
 * with a collector configured in their shell would otherwise see these assert
 * their environment rather than the map under test.
 */
function withCleanOtelEnv(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of OTEL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of OTEL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

describe('resolveTracesUrl', () => {
  it('appends the signal path to a collector base URL', () => {
    expect(resolveTracesUrl('http://otel-collector:4318')).toBe(
      `http://otel-collector:4318${TRACES_SIGNAL_PATH}`,
    );
  });

  it('does not append it twice when the operator already included it', () => {
    expect(resolveTracesUrl('http://otel-collector:4318/v1/traces')).toBe(
      'http://otel-collector:4318/v1/traces',
    );
  });

  it('tolerates trailing slashes and surrounding whitespace', () => {
    expect(resolveTracesUrl('  http://collector:4318///  ')).toBe(
      'http://collector:4318/v1/traces',
    );
    expect(resolveTracesUrl('http://collector:4318/v1/traces/')).toBe(
      'http://collector:4318/v1/traces',
    );
  });

  it('keeps a path prefix, which is how a collector behind an ingress is addressed', () => {
    expect(resolveTracesUrl('https://obs.example.com/otlp')).toBe(
      'https://obs.example.com/otlp/v1/traces',
    );
  });
});

describe('readTracingSettings', () => {
  withCleanOtelEnv();

  it('is DISABLED when no endpoint is configured', () => {
    const settings = readTracingSettings(new ConfigService({}));
    expect(settings.enabled).toBe(false);
    expect(settings.tracesUrl).toBeNull();
  });

  it.each(['', '   '])('is disabled when the endpoint is blank (%j)', (blank) => {
    const settings = readTracingSettings(
      new ConfigService({ OTEL_EXPORTER_OTLP_ENDPOINT: blank }),
    );
    expect(settings.enabled).toBe(false);
    expect(settings.tracesUrl).toBeNull();
  });

  it('is enabled, with a resolved traces URL, when an endpoint is configured', () => {
    const settings = readTracingSettings(
      new ConfigService({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
        OTEL_SERVICE_NAME: 'control-api-staging',
        OTEL_SERVICE_NAMESPACE: 'hookubit',
        OTEL_TRACES_SAMPLER_ARG: 0.25,
        APP_ENV: 'staging',
      }),
    );
    expect(settings).toEqual({
      enabled: true,
      tracesUrl: 'http://otel-collector:4318/v1/traces',
      serviceName: 'control-api-staging',
      serviceNamespace: 'hookubit',
      deploymentEnvironment: 'staging',
      samplerRatio: 0.25,
    });
  });

  it('falls back to the documented defaults for a partial configuration', () => {
    const settings = readTracingSettings(
      new ConfigService({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
    );
    expect(settings.serviceName).toBe('control-api');
    expect(settings.serviceNamespace).toBe('hookubit');
    expect(settings.deploymentEnvironment).toBe('development');
    expect(settings.samplerRatio).toBe(1);
  });

  it.each([
    [-2, 0],
    [4, 1],
    ['not a number', 1],
    [Number.NaN, 1],
  ])('clamps a sampler ratio of %j to %j', (given, expected) => {
    const settings = readTracingSettings(
      new ConfigService({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_TRACES_SAMPLER_ARG: given,
      }),
    );
    expect(settings.samplerRatio).toBe(expected);
  });
});
