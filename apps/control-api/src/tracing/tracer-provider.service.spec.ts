import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, diag, propagation, trace } from '@opentelemetry/api';
import {
  TRACE_SHUTDOWN_TIMEOUT_MS,
  TracerProviderService,
  withTimeout,
} from './tracer-provider.service';
import { isTracingEnabled, setTracingEnabled } from './tracing.runtime';

const OTEL_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_NAMESPACE',
  'OTEL_TRACES_SAMPLER_ARG',
] as const;

/** A span is only "recording" once a real SDK is registered. */
function tracingIsLive(): boolean {
  const span = trace.getTracer('probe').startSpan('probe');
  const recording = span.isRecording();
  span.end();
  return recording;
}

describe('TracerProviderService', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of OTEL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of OTEL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setTracingEnabled(false);
    diag.disable();
    trace.disable();
    context.disable();
    propagation.disable();
    jest.restoreAllMocks();
  });

  describe('with no collector configured', () => {
    it('is completely inert - nothing registered, nothing to retry', () => {
      const service = new TracerProviderService(new ConfigService({}));
      service.onModuleInit();

      expect(isTracingEnabled()).toBe(false);
      expect(service.currentSettings()?.enabled).toBe(false);
      expect(tracingIsLive()).toBe(false);
    });

    it('says so at boot rather than leaving an operator to guess', () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      new TracerProviderService(new ConfigService({})).onModuleInit();

      expect(log).toHaveBeenCalledWith(expect.stringContaining('tracing: OFF'));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'),
      );
    });

    it('shuts down without complaint when there is nothing to shut down', async () => {
      const service = new TracerProviderService(new ConfigService({}));
      service.onModuleInit();
      await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    });

    it('shuts down cleanly even if it was never initialised at all', async () => {
      await expect(
        new TracerProviderService(new ConfigService({})).onApplicationShutdown(),
      ).resolves.toBeUndefined();
    });
  });

  describe('with a collector configured', () => {
    // Port 1 refuses instantly. Nothing is exported by these tests - a span is
    // only queued when it ENDS, and the probe span below is the only one - but
    // an unreachable, fast-failing address means a stray export can never turn
    // into a hanging test.
    const config = new ConfigService({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_SERVICE_NAME: 'control-api-test',
      OTEL_SERVICE_NAMESPACE: 'hookubit-test',
    });

    it('registers a live SDK and turns the runtime flag on', async () => {
      const service = new TracerProviderService(config);
      service.onModuleInit();

      expect(isTracingEnabled()).toBe(true);
      expect(tracingIsLive()).toBe(true);

      await service.onApplicationShutdown();
    });

    it('stops minting spans BEFORE draining, so the flush has fixed work', async () => {
      const service = new TracerProviderService(config);
      service.onModuleInit();
      await service.onApplicationShutdown();

      expect(isTracingEnabled()).toBe(false);
    });

    it('reports what it is doing, including where it is exporting to', () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      const service = new TracerProviderService(config);
      service.onModuleInit();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('tracing: ON - exporting to http://127.0.0.1:1/v1/traces'),
      );
      return service.onApplicationShutdown();
    });
  });

  describe('when starting up goes wrong', () => {
    it('does NOT fail boot; it logs and leaves tracing off', () => {
      const exploding = {
        get: () => {
          throw new Error('config exploded');
        },
      } as unknown as ConfigService;
      const error = jest.spyOn(Logger.prototype, 'error');
      const service = new TracerProviderService(exploding);

      expect(() => service.onModuleInit()).not.toThrow();
      expect(isTracingEnabled()).toBe(false);
      expect(tracingIsLive()).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('tracing: FAILED'));
    });
  });
});

describe('withTimeout', () => {
  it('resolves when the work finishes first', async () => {
    await expect(withTimeout(Promise.resolve(), 50)).resolves.toBeUndefined();
  });

  it('gives up rather than letting a dead collector hold SIGTERM open', async () => {
    const neverResolves = new Promise<void>(() => undefined);
    await expect(withTimeout(neverResolves, 10)).rejects.toThrow(/exceeded 10ms/);
  });

  it('propagates the work’s own failure', async () => {
    await expect(withTimeout(Promise.reject(new Error('flush failed')), 1_000)).rejects.toThrow(
      'flush failed',
    );
  });

  it('uses a short, documented budget', () => {
    expect(TRACE_SHUTDOWN_TIMEOUT_MS).toBe(2_000);
  });
});
