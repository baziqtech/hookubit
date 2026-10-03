import { AddressInfo } from 'node:net';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import { HttpTraceMiddleware } from './http-trace.middleware';
import { TracerProviderService } from './tracer-provider.service';
import { TracingModule } from './tracing.module';
import { setTracingEnabled } from './tracing.runtime';
import { InMemoryTracing, startInMemoryTracing } from './testing/in-memory-tracing';

@Controller('projects')
class ThingsController {
  @Get(':projectId')
  show(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * The DI graph, compiled and BOOTED.
 *
 * A module can type-check, pass every unit test and still fail at boot, because
 * `PrismaModule` is not `@Global()` and a missing `imports` entry is only found
 * when Nest actually resolves the graph. `Test.createTestingModule().compile()`
 * catches the resolution failure; `app.init()` additionally runs the lifecycle
 * hooks, which is where `TracerProviderService` does all of its work; and the
 * request at the end proves `configure()` really bound the middleware, which no
 * amount of provider resolution would have shown.
 */
describe('TracingModule (real DI graph)', () => {
  const OTEL_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_TRACES_SAMPLER_ARG'] as const;
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    for (const key of OTEL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
        TracingModule,
      ],
      controllers: [ThingsController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    for (const key of OTEL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setTracingEnabled(false);
    trace.disable();
    context.disable();
    propagation.disable();
    jest.restoreAllMocks();
  });

  it('resolves every provider it declares', () => {
    expect(app.get(TracerProviderService)).toBeInstanceOf(TracerProviderService);
    expect(app.get(HttpTraceMiddleware)).toBeInstanceOf(HttpTraceMiddleware);
  });

  it('boots and serves with NO collector configured', async () => {
    const response = await fetch(`${baseUrl}/v1/projects/prj_1`);
    expect(response.status).toBe(200);
    await response.text();
  });

  it('really binds the middleware - not just resolves it', async () => {
    let tracing: InMemoryTracing | undefined;
    try {
      tracing = startInMemoryTracing();
      await (await fetch(`${baseUrl}/v1/projects/prj_1`)).text();

      const span = tracing.spans().find((s) => s.kind === SpanKind.SERVER);
      expect(span?.name).toBe('GET /v1/projects/:projectId');
    } finally {
      await tracing?.stop();
    }
  });
});
