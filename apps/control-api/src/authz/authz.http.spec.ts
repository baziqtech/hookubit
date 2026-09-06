import { AddressInfo } from 'node:net';
import { Controller, Get, INestApplication, Param, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { SESSION_COOKIE, SessionService, SessionUser } from '../auth/session.service';
import { SessionGuard } from '../auth/session.guard';
import { AppExceptionFilter } from '../common/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { Authorized, ResolveTenantFrom, Tenant } from './authz.decorators';
import { AuditService } from './audit.service';
import { RequestContext } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { TenantScopeFactory } from './tenant-scope.factory';
import { TenantGuard } from './tenant.guard';
import { IDS, seedWorld } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

/**
 * The layer as a Phase 2 module will actually meet it: real Nest, real guards
 * mounted by `@Authorized`, real routing, real exception filter, real status
 * codes on the wire.
 *
 * The unit suites prove the rules; this one proves the wiring - guard order,
 * metadata reflection, the param decorator, and that the not-found/forbidden
 * policy survives all the way out to an HTTP status.
 *
 * `SessionService` is stubbed (the cookie is just a user id) because
 * authentication has its own suite in `src/auth`; substituting it keeps this
 * test about authorization.
 */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

/**
 * This controller is also the worked example in HANDOFF.md. Nothing in it
 * mentions organizationId or projectId: the scoping is entirely in
 * `@Authorized` and `scopes.for(ctx)`.
 */
@Controller('v1')
class ExampleController {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
  ) {}

  @Get('organizations/:orgId/projects/:projectId/endpoints')
  @Authorized('endpoints.read')
  async listEndpoints(@Tenant() context: RequestContext): Promise<{ ids: string[] }> {
    const endpoints = await this.scopes.for(context).endpoints.findMany();
    return { ids: endpoints.map((endpoint) => endpoint.id) };
  }

  @Post('organizations/:orgId/projects/:projectId/endpoints')
  @Authorized('endpoints.write')
  async createEndpoint(@Tenant() context: RequestContext): Promise<{ id: string }> {
    const endpoint = await this.scopes.for(context).endpoints.create({
      id: 'ep_created',
      name: 'created',
      url: 'https://created.example.com/hook',
    });
    await this.audit.recordFor(context, {
      action: 'endpoint.created',
      resourceType: 'endpoint',
      resourceId: endpoint.id,
    });
    return { id: endpoint.id };
  }

  @Post('organizations/:orgId/members')
  @Authorized('members.write')
  inviteMember(@Tenant() context: RequestContext): { role: string } {
    return { role: context.role };
  }

  /**
   * Resource-addressed: the tenant is not in the path, so the anchor walks
   * delivery -> endpoint -> project -> organization before the permission is
   * even considered.
   */
  @Get('deliveries/:deliveryId')
  @Authorized('deliveries.read')
  @ResolveTenantFrom('delivery', 'deliveryId')
  async getDelivery(
    @Tenant() context: RequestContext,
    @Param('deliveryId') deliveryId: string,
  ): Promise<{ project: string }> {
    const delivery = await this.scopes.for(context).deliveries.requireById(deliveryId);
    return { project: String(delivery.projectId) };
  }

  /** Guarded but names no tenant: must fail loudly rather than serve anything. */
  @Get('misconfigured')
  @Authorized('endpoints.read')
  misconfigured(): { ok: boolean } {
    return { ok: true };
  }
}

describe('authorization layer over HTTP', () => {
  let app: INestApplication;
  let db: FakeTenantPrisma;
  let baseUrl: string;

  interface HttpResult {
    status: number;
    body: { error?: { code: string; details?: Record<string, unknown> }; ids?: string[] };
  }

  /**
   * Plain fetch against a real listening server rather than supertest: it needs
   * no extra dependency and it exercises the same Express stack.
   */
  async function call(method: string, path: string, userId?: string): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {},
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  beforeAll(async () => {
    db = seedWorld();
    const moduleRef = await Test.createTestingModule({
      controllers: [ExampleController],
      providers: [
        { provide: PrismaService, useValue: db.asPrisma() },
        { provide: SessionService, useClass: StubSessionService },
        SessionGuard,
        TenantGuard,
        TenantResolver,
        TenantScopeFactory,
        AuditService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const endpointsPath = (organizationId: string, projectId: string): string =>
    `/v1/organizations/${organizationId}/projects/${projectId}/endpoints`;

  it('serves a member of the tenant only their own project rows', async () => {
    const res = await call('GET', endpointsPath(IDS.orgA, IDS.projectA1), IDS.viewerA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [IDS.endpointA1] });
  });

  it('401 with no session cookie', async () => {
    const res = await call('GET', endpointsPath(IDS.orgA, IDS.projectA1));
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  it('404 - not 403 - for an organization the caller is not a member of', async () => {
    const res = await call('GET', endpointsPath(IDS.orgB, IDS.projectB1), IDS.ownerA);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('404 for a project id belonging to another organization than the path claims', async () => {
    const res = await call('GET', endpointsPath(IDS.orgA, IDS.projectB1), IDS.ownerA);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('403 for a role that is short of the permission, inside its own tenant', async () => {
    const res = await call('POST', `/v1/organizations/${IDS.orgA}/members`, IDS.developerA);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
    expect(res.body.error?.details).toMatchObject({ role: 'developer' });
  });

  it('lets an admin do what a developer could not', async () => {
    const res = await call('POST', `/v1/organizations/${IDS.orgA}/members`, IDS.adminA);
    expect(res.status).toBe(201);
  });

  it('writes into the resolved project and audits it, without the handler naming either', async () => {
    const res = await call('POST', endpointsPath(IDS.orgA, IDS.projectA1), IDS.developerA);
    expect(res.status).toBe(201);

    expect(db.rows('endpoint').get('ep_created')?.projectId).toBe(IDS.projectA1);
    expect(db.all('auditLog')[0]).toMatchObject({
      organizationId: IDS.orgA,
      userId: IDS.developerA,
      action: 'endpoint.created',
      resourceId: 'ep_created',
    });
  });

  it('serves a resource-addressed route to its owner and 404s it to everyone else', async () => {
    const mine = await call('GET', `/v1/deliveries/${IDS.deliveryA1}`, IDS.ownerA);
    expect(mine.status).toBe(200);

    const theirs = await call('GET', `/v1/deliveries/${IDS.deliveryB1}`, IDS.ownerA);
    expect(theirs.status).toBe(404);
  });

  it('500, not a silent success, on a guarded route that names no tenant', async () => {
    const res = await call('GET', '/v1/misconfigured', IDS.ownerA);
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('internal_error');
  });
});
