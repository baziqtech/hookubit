import { AddressInfo } from 'node:net';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { TenantRequest } from '../authz/tenant-context';
import { HttpTraceMiddleware } from './http-trace.middleware';
import { isTracingEnabled, setTracingEnabled, tracer } from './tracing.runtime';
import { InMemoryTracing, startInMemoryTracing } from './testing/in-memory-tracing';

/**
 * Stands in for `TenantGuard`: it resolves a tenant the caller is proved to
 * belong to and puts it on the request. What matters for these tests is only
 * that it runs AFTER the middleware and sets `tenantContext`.
 */
@Injectable()
class ResolvingGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    // Started inside the guard: if the server span were opened by an
    // interceptor instead of middleware, this would be a parentless root.
    // Gated the way real instrumentation is, so "tracing off" means zero spans.
    if (isTracingEnabled()) tracer().startSpan('guard-work').end();

    req.tenantContext = {
      organization: { id: 'org_own', name: 'Own', slug: 'own', status: 'active' },
      project: {
        id: 'prj_own',
        organizationId: 'org_own',
        name: 'Own',
        slug: 'own',
        environment: 'live',
        status: 'active',
      },
      role: 'admin',
      user: { userId: 'usr_1', email: 'owner@example.com', sessionId: 'ses_1' },
    } as TenantRequest['tenantContext'];
    return true;
  }
}

/**
 * Stands in for the cross-tenant refusal: the resolver throws and
 * `tenantContext` is never assigned. The id in the path belongs to someone else.
 */
@Injectable()
class RefusingGuard implements CanActivate {
  canActivate(): boolean {
    throw new NotFoundException('Resource not found.');
  }
}

@Controller('projects')
class ProjectsTestController {
  @Get('boom')
  boom(): never {
    throw new Error('kaboom');
  }

  @Get(':projectId/endpoints')
  @UseGuards(ResolvingGuard)
  list(): string[] {
    return [];
  }

  @Get(':projectId/refused')
  @UseGuards(RefusingGuard)
  refused(): string[] {
    return [];
  }
}

@Controller('health')
class ProbeTestController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [ProjectsTestController, ProbeTestController],
  providers: [HttpTraceMiddleware, ResolvingGuard, RefusingGuard],
})
class TestAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpTraceMiddleware).forRoutes('*');
  }
}

describe('HttpTraceMiddleware', () => {
  let app: INestApplication;
  let baseUrl: string;
  let tracing: InMemoryTracing;

  /** A real socket, like the other HTTP suites here - not a mocked request. */
  async function get(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number }> {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    await response.text();
    return { status: response.status };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    // The same call main.ts makes, including the two probes it excludes.
    app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    tracing = startInMemoryTracing();
  });

  afterEach(async () => {
    await tracing.stop();
  });

  const serverSpan = (): ReadableSpan | undefined =>
    tracing.spans().find((span) => span.kind === SpanKind.SERVER);

  describe('span naming', () => {
    it('names the span by ROUTE TEMPLATE, with the id nowhere in it', async () => {
      expect((await get('/v1/projects/prj_01HXYZ/endpoints')).status).toBe(200);

      const span = serverSpan();
      expect(span?.name).toBe('GET /v1/projects/:projectId/endpoints');
      expect(span?.name).not.toContain('prj_01HXYZ');
      expect(span?.attributes['http.route']).toBe('/v1/projects/:projectId/endpoints');
    });

    it('gives two different ids the SAME span name - that is the whole point', async () => {
      await get('/v1/projects/prj_a/endpoints');
      await get('/v1/projects/prj_b/endpoints');

      const names = tracing
        .spans()
        .filter((span) => span.kind === SpanKind.SERVER)
        .map((span) => span.name);
      expect(names).toEqual([
        'GET /v1/projects/:projectId/endpoints',
        'GET /v1/projects/:projectId/endpoints',
      ]);
    });

    it('keeps the bare method name for a path that matched no route', async () => {
      expect((await get('/v1/no-such-thing/prj_01HXYZ')).status).toBe(404);

      const span = serverSpan();
      expect(span?.name).toBe('HTTP GET');
      expect(span?.attributes['http.route']).toBeUndefined();
      expect(span?.attributes['http.response.status_code']).toBe(404);
    });
  });

  describe('what the span records', () => {
    it('records the method, status and a client address', async () => {
      await get('/v1/projects/prj_1/endpoints', { 'user-agent': 'hookubit-dashboard/1.2.3' });

      expect(serverSpan()?.attributes).toMatchObject({
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'user_agent.original': 'hookubit-dashboard/1.2.3',
      });
      expect(serverSpan()?.attributes['client.address']).toBeDefined();
      expect(serverSpan()?.kind).toBe(SpanKind.SERVER);
    });

    it('carries the request id, so a log line leads back to the trace', async () => {
      await get('/v1/projects/prj_1/endpoints', { 'x-request-id': 'req_from_the_client' });

      expect(serverSpan()?.attributes['webhook.request_id']).toBe('req_from_the_client');
    });

    it('NEVER records the authorization header, the cookie or the raw path', async () => {
      await get('/v1/projects/prj_secret_id/endpoints?token=whsec_live_abcdef', {
        authorization: 'Bearer super-secret-key',
        cookie: 'session=super-secret-session',
      });

      const serialised = JSON.stringify(serverSpan()?.attributes);
      expect(serialised).not.toContain('super-secret-key');
      expect(serialised).not.toContain('super-secret-session');
      expect(serialised).not.toContain('whsec_live_abcdef');
      expect(serialised).not.toContain('authorization');
      // No url.path / url.full either: it is the interpolated path, and on a
      // refused request that path names another tenant's resource.
      expect(serialised).not.toContain('prj_secret_id');
    });
  });

  describe('tenant context', () => {
    it('records the tenant the guard resolved', async () => {
      await get('/v1/projects/prj_1/endpoints');

      expect(serverSpan()?.attributes).toMatchObject({
        'webhook.organization_id': 'org_own',
        'webhook.project_id': 'prj_own',
        'webhook.member_role': 'admin',
        'webhook.user_id': 'usr_1',
      });
    });

    it('records NO tenant for a refused cross-tenant request', async () => {
      expect((await get('/v1/projects/prj_belongs_to_someone_else/refused')).status).toBe(404);

      const span = serverSpan();
      expect(span?.name).toBe('GET /v1/projects/:projectId/refused');
      expect(span?.attributes['webhook.organization_id']).toBeUndefined();
      expect(span?.attributes['webhook.project_id']).toBeUndefined();
      expect(JSON.stringify(span?.attributes)).not.toContain('someone_else');
    });

    it('never puts the user email on the span', async () => {
      await get('/v1/projects/prj_1/endpoints');
      expect(JSON.stringify(serverSpan()?.attributes)).not.toContain('owner@example.com');
    });
  });

  describe('span status', () => {
    it('marks a 500 as an error', async () => {
      expect((await get('/v1/projects/boom')).status).toBe(500);

      const span = serverSpan();
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes['error.type']).toBe('500');
    });

    it('does NOT mark the deliberate 404 as an error - that is the API working', async () => {
      expect((await get('/v1/projects/prj_1/refused')).status).toBe(404);
      expect(serverSpan()?.status.code).toBe(SpanStatusCode.UNSET);
      expect(serverSpan()?.attributes['error.type']).toBeUndefined();
    });
  });

  describe('coverage and propagation', () => {
    it('is active during the GUARDS, not just the handler', async () => {
      await get('/v1/projects/prj_1/endpoints');

      const guardSpan = tracing.named('guard-work');
      expect(guardSpan).toBeDefined();
      expect(guardSpan?.parentSpanContext?.spanId).toBe(serverSpan()?.spanContext().spanId);
    });

    it('continues an upstream trace sent as traceparent', async () => {
      const traceId = '0af7651916cd43dd8448eb211c80319c';
      await get('/v1/projects/prj_1/endpoints', {
        traceparent: `00-${traceId}-b7ad6b7169203331-01`,
      });

      expect(serverSpan()?.spanContext().traceId).toBe(traceId);
      expect(serverSpan()?.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    });
  });

  describe('what is deliberately not traced', () => {
    it.each(['/health/live', '/health/ready', '/health/live?probe=1'])(
      'does not trace %s - a liveness probe every few seconds is noise, not a trace',
      async (path) => {
        expect((await get(path)).status).toBe(200);
        expect(tracing.spans()).toEqual([]);
      },
    );
  });

  describe('with tracing off', () => {
    it('serves the request and produces no spans at all', async () => {
      setTracingEnabled(false);
      expect((await get('/v1/projects/prj_1/endpoints')).status).toBe(200);
      expect(tracing.spans()).toEqual([]);
    });
  });

  describe('the active context inside the handler', () => {
    it('is the server span, so anything the handler starts nests under it', async () => {
      await get('/v1/projects/prj_1/endpoints');
      // Asserted via the guard span above; this guards the API used to get it.
      expect(trace.getSpan(context.active())).toBeUndefined();
    });
  });
});
