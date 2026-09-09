import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import { LoggerModule } from 'nestjs-pino';
import { traceLogFields } from './log-correlation';
import { TracingModule } from './tracing.module';
import { setTracingEnabled } from './tracing.runtime';
import { InMemoryTracing, startInMemoryTracing } from './testing/in-memory-tracing';

describe('traceLogFields (unit)', () => {
  it('is empty when nothing is being traced', () => {
    expect(traceLogFields()).toEqual({});
  });
});

@Controller('projects')
class LoggedController {
  @Get(':projectId')
  show(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * The join between the two observability systems, asserted end to end.
 *
 * ARCHITECTURE.md 63 wants logs AND traces. The thing worth testing is not that
 * both exist but that they point at each other: pino's request line must carry
 * the trace id of the span the request produced, and that span must carry
 * pino's request id. Without both, an operator holding one of them at 02:14 has
 * no way to reach the other.
 */
describe('log <-> trace correlation', () => {
  let app: INestApplication;
  let baseUrl: string;
  let lines: string[];
  let tracing: InMemoryTracing;

  beforeAll(async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    lines = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
        LoggerModule.forRoot({
          // The production configuration's two relevant halves: a minted
          // request id, and the trace fields under test.
          pinoHttp: [
            {
              level: 'info',
              genReqId: (req, res) => {
                const id = 'req_fixed_for_the_test';
                res.setHeader('x-request-id', id);
                return id;
              },
              customProps: traceLogFields,
            },
            stream,
          ],
        }),
        TracingModule,
      ],
      controllers: [LoggedController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    setTracingEnabled(false);
    trace.disable();
    context.disable();
    propagation.disable();
  });

  beforeEach(() => {
    lines.length = 0;
    tracing = startInMemoryTracing();
  });

  afterEach(async () => {
    await tracing.stop();
  });

  async function callAndSettle(): Promise<void> {
    await (await fetch(`${baseUrl}/v1/projects/prj_1`)).text();
    // pino writes on `finish`, which lands a tick after fetch resolves.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('puts the span’s trace id on the request log line, and the request id on the span', async () => {
    await callAndSettle();

    const span = tracing.spans().find((s) => s.kind === SpanKind.SERVER);
    expect(span).toBeDefined();

    const completion = lines.map((line) => JSON.parse(line)).find((l) => l.msg === 'request completed');
    expect(completion).toBeDefined();
    expect(completion.trace_id).toBe(span?.spanContext().traceId);
    expect(completion.span_id).toBe(span?.spanContext().spanId);

    expect(span?.attributes['webhook.request_id']).toBe('req_fixed_for_the_test');
    expect(completion.req.id).toBe('req_fixed_for_the_test');
  });

  it('leaves the log line untouched when tracing is off', async () => {
    setTracingEnabled(false);
    await callAndSettle();

    const completion = lines.map((line) => JSON.parse(line)).find((l) => l.msg === 'request completed');
    expect(completion).toBeDefined();
    expect(completion.trace_id).toBeUndefined();
    expect(completion.span_id).toBeUndefined();
  });
});
