import { Prisma } from '@prisma/client';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { prismaTracingMiddleware } from './prisma-tracing';
import { setTracingEnabled } from './tracing.runtime';
import { InMemoryTracing, startInMemoryTracing } from './testing/in-memory-tracing';

function params(overrides: Partial<Prisma.MiddlewareParams> = {}): Prisma.MiddlewareParams {
  return {
    model: 'Endpoint',
    action: 'findMany',
    args: { where: { projectId: 'prj_1' } },
    dataPath: [],
    runInTransaction: false,
    ...overrides,
  } as Prisma.MiddlewareParams;
}

describe('prismaTracingMiddleware', () => {
  describe('with tracing off', () => {
    beforeEach(() => setTracingEnabled(false));

    it('is a passthrough that returns exactly what the query returned', async () => {
      const middleware = prismaTracingMiddleware();
      const rows = [{ id: 'ep_1' }];
      await expect(middleware(params(), async () => rows)).resolves.toBe(rows);
    });

    it('does not alter a rejection', async () => {
      const middleware = prismaTracingMiddleware();
      const failure = new Error('nope');
      await expect(
        middleware(params(), () => Promise.reject(failure)),
      ).rejects.toBe(failure);
    });
  });

  describe('with tracing on', () => {
    let tracing: InMemoryTracing;
    beforeEach(() => {
      tracing = startInMemoryTracing();
    });
    afterEach(async () => {
      await tracing.stop();
    });

    it('names the span {operation} {model} and marks it a client span', async () => {
      await prismaTracingMiddleware()(params(), async () => []);

      const span = tracing.named('findMany Endpoint');
      expect(span).toBeDefined();
      expect(span?.kind).toBe(SpanKind.CLIENT);
      expect(span?.attributes).toMatchObject({
        'db.system.name': 'postgresql',
        'db.operation.name': 'findMany',
        'db.collection.name': 'Endpoint',
      });
    });

    it('handles a model-less operation such as $queryRaw', async () => {
      await prismaTracingMiddleware()(
        params({ model: undefined, action: 'queryRaw' as Prisma.PrismaAction }),
        async () => [],
      );

      const span = tracing.named('queryRaw');
      expect(span).toBeDefined();
      expect(span?.attributes['db.collection.name']).toBeUndefined();
    });

    /**
     * The one thing this must never do. `args` is the query's VALUES: the
     * argon2 hash on a login, the session token on every authenticated request,
     * the ciphertext of an endpoint secret, the invited user's email address.
     */
    it('records NOTHING from params.args', async () => {
      await prismaTracingMiddleware()(
        params({
          model: 'UserToken',
          action: 'findFirst',
          args: {
            where: { tokenHash: 'a-real-session-token-hash' },
            data: { password: 'hunter2', email: 'victim@example.com' },
          },
        }),
        async () => null,
      );

      const serialised = JSON.stringify(tracing.spans().map((s) => s.attributes));
      expect(serialised).not.toContain('a-real-session-token-hash');
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain('victim@example.com');
      expect(serialised).not.toContain('tokenHash');
    });

    it('marks a failed query as an error by CODE, never by message', async () => {
      const failure = Object.assign(new Error('Unique constraint failed on (`slug`) = (acme)'), {
        code: 'P2002',
      });

      await expect(
        prismaTracingMiddleware()(params({ action: 'create' }), () => Promise.reject(failure)),
      ).rejects.toBe(failure);

      const span = tracing.named('create Endpoint');
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes['error.type']).toBe('P2002');
      expect(JSON.stringify(span?.attributes)).not.toContain('acme');
    });

    it('falls back to the error class name when there is no code', async () => {
      class ConnectionLost extends Error {}
      await expect(
        prismaTracingMiddleware()(params(), () => Promise.reject(new ConnectionLost('down'))),
      ).rejects.toBeInstanceOf(ConnectionLost);
      expect(tracing.named('findMany Endpoint')?.attributes['error.type']).toBe('ConnectionLost');
    });

    it('ends the span even when the query throws', async () => {
      await expect(
        prismaTracingMiddleware()(params(), () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      expect(tracing.spans()).toHaveLength(1);
    });

    it('nests under the span that was active when the query ran', async () => {
      const parent = trace.getTracer('test').startSpan('parent');

      await context.with(trace.setSpan(context.active(), parent), () =>
        prismaTracingMiddleware()(params(), async () => []),
      );
      parent.end();

      const child = tracing.named('findMany Endpoint');
      expect(child?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(child?.spanContext().traceId).toBe(parent.spanContext().traceId);
    });
  });
});
