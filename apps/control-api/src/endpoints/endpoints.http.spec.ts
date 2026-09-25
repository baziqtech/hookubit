import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'node:net';
import { AuditService, TenantGuard, TenantResolver, TenantScopeFactory } from '../authz';
import { IDS, seedWorld } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { SessionGuard } from '../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../auth/session.service';
import { CryptoService } from '../common/crypto.service';
import { AppExceptionFilter } from '../common/errors';
import { ThrottleGuard } from '../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../common/throttle.store';
import { EndpointSecretsController } from '../endpoint-secrets/endpoint-secrets.controller';
import { EndpointSecretsService } from '../endpoint-secrets/endpoint-secrets.service';
import {
  backfillTimestamps,
  buildCrypto,
  testScopeFactory,
  testTransactions,
} from '../endpoint-secrets/testing/harness';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import { EndpointsController } from './endpoints.controller';
import { EndpointHealthService } from './endpoint-health.service';
import { EndpointsService } from './endpoints.service';

/** Authentication has its own suite; the cookie here is just a user id. */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

interface HttpResult {
  status: number;
  body: {
    error?: { code: string; message: string; details?: Record<string, unknown> };
    [key: string]: unknown;
  };
}

/**
 * The two modules as a browser meets them: real Nest, real guards mounted by
 * `@Authorized`, the real global validation pipe and the real exception filter.
 *
 * The unit suites prove the rules. This one proves the WIRING - that the
 * decorators are actually on the handlers, that `@ResolveTenantFrom` on the
 * secrets controller really walks endpoint -> project -> organization, and that
 * the 404/403 split survives all the way to a status code.
 */
describe('endpoints and secrets over HTTP', () => {
  let app: INestApplication;
  let db: FakeTenantPrisma;
  let baseUrl: string;

  async function call(
    method: string,
    path: string,
    options: { as?: string; body?: unknown } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.as ? { cookie: `${SESSION_COOKIE}=${options.as}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  beforeAll(async () => {
    db = backfillTimestamps(seedWorld());
    const crypto = buildCrypto();
    const scopes = testScopeFactory(db);
    const audit = new AuditService(db.asPrisma());

    const moduleRef = await Test.createTestingModule({
      controllers: [EndpointsController, EndpointSecretsController],
      providers: [
        { provide: SessionService, useClass: StubSessionService },
        { provide: TenantResolver, useValue: new TenantResolver(db.asPrisma()) },
        { provide: TenantScopeFactory, useValue: scopes },
        { provide: AuditService, useValue: audit },
        {
          provide: TenantTransactionRunner,
          useValue: testTransactions(db, scopes, audit),
        },
        { provide: CryptoService, useValue: crypto },
        // The throttle limits here are far above what this suite issues, so the
        // guard is proved to be MOUNTED without any test depending on a 429.
        { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
        ThrottleGuard,
        SessionGuard,
        TenantGuard,
        EndpointsService,
        EndpointHealthService,
        EndpointSecretsService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const endpointsPath = (projectId: string): string => `/v1/projects/${projectId}/endpoints`;
  const good = { name: 'finance', url: 'https://finance.example.com/hook' };

  describe('authentication and tenancy', () => {
    it('401 without a session', async () => {
      const res = await call('GET', endpointsPath(IDS.projectA1));
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('unauthenticated');
    });

    it('404, not 403, for a project in another organization', async () => {
      const res = await call('GET', endpointsPath(IDS.projectB1), { as: IDS.ownerA });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Resource not found.' });
    });

    it('404 for another tenant endpoint addressed by id, with the same message', async () => {
      const foreign = await call('GET', `${endpointsPath(IDS.projectA1)}/${IDS.endpointB1}`, {
        as: IDS.ownerA,
      });
      const absent = await call('GET', `${endpointsPath(IDS.projectA1)}/ep_nope`, {
        as: IDS.ownerA,
      });
      expect(foreign.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(foreign.body.error?.message).toBe(absent.body.error?.message);
    });

    it('404 for the secrets route on another tenant endpoint - the anchor walks the chain', async () => {
      const res = await call('GET', `/v1/endpoints/${IDS.endpointB1}/secrets`, {
        as: IDS.ownerA,
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe('Resource not found.');
    });
  });

  describe('the endpoint-secrets permission is owner/admin only', () => {
    it('403 for a viewer, who can nonetheless read the endpoint itself', async () => {
      const endpoint = await call('GET', `${endpointsPath(IDS.projectA1)}/${IDS.endpointA1}`, {
        as: IDS.viewerA,
      });
      expect(endpoint.status).toBe(200);

      const secrets = await call('GET', `/v1/endpoints/${IDS.endpointA1}/secrets`, {
        as: IDS.viewerA,
      });
      expect(secrets.status).toBe(403);
      expect(secrets.body.error?.code).toBe('forbidden');
      expect(secrets.body.error?.details).toMatchObject({
        role: 'viewer',
        required_permissions: ['endpoint-secrets.read'],
      });
    });

    it('403 for a developer, who may create endpoints but not read their secrets', async () => {
      const created = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.developerA,
        body: good,
      });
      expect(created.status).toBe(201);
      expect(created.body.secret).toBeNull();
      // Paused, not live: nobody can be handed the key it would sign with.
      expect(created.body).toMatchObject({ secret_pending: true, status: 'paused' });

      const secrets = await call('GET', `/v1/endpoints/${String(created.body.id)}/secrets`, {
        as: IDS.developerA,
      });
      expect(secrets.status).toBe(403);

      const rotate = await call('POST', `/v1/endpoints/${String(created.body.id)}/secrets/rotate`, {
        as: IDS.developerA,
        body: {},
      });
      expect(rotate.status).toBe(403);
    });

    it('200 and a plaintext exactly once for an owner', async () => {
      const created = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: good,
      });
      expect(created.status).toBe(201);
      const endpointId = String(created.body.id);

      const rotated = await call('POST', `/v1/endpoints/${endpointId}/secrets/rotate`, {
        as: IDS.ownerA,
        body: { overlap_seconds: 3600 },
      });
      expect(rotated.status).toBe(201);
      const secret = String(rotated.body.secret);
      expect(secret).toMatch(/^whsec_/);

      const listed = await call('GET', `/v1/endpoints/${endpointId}/secrets`, { as: IDS.ownerA });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(secret);
      // Both still signing: this is the overlap window on the wire.
      const page = listed.body as unknown as {
        data: Array<{ active: boolean }>;
        has_more: boolean;
      };
      expect(page.data.filter((entry) => entry.active)).toHaveLength(2);
      expect(page.has_more).toBe(false);
    });
  });

  describe('request validation at the edge', () => {
    it('400 for an SSRF-shaped URL, naming the reason', async () => {
      const res = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'x', url: 'http://169.254.169.254/latest/meta-data/' },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('cloud instance metadata address');
    });

    it.each([
      ['Webhook-Signature', 'sha256=deadbeef'],
      ['Authorization', 'Bearer x'],
      ['Content-Length', '0'],
    ])('400 for the reserved custom header %s', async (name, value) => {
      const res = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { ...good, custom_headers: { [name]: value } },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('reserved');
    });

    it('400 for out-of-range delivery limits', async () => {
      for (const body of [
        { ...good, timeout_ms: 600_000 },
        { ...good, timeout_ms: 10 },
        { ...good, max_concurrency: 0 },
        { ...good, max_concurrency: 10_000 },
        { ...good, rate_limit_window_seconds: 0 },
      ]) {
        const res = await call('POST', endpointsPath(IDS.projectA1), { as: IDS.ownerA, body });
        expect(res.status).toBe(400);
      }
    });

    it('400 for a status smuggled into the body - the pipe refuses unknown keys', async () => {
      const res = await call('PATCH', `${endpointsPath(IDS.projectA1)}/${IDS.endpointA1}`, {
        as: IDS.ownerA,
        body: { status: 'active' },
      });
      expect(res.status).toBe(400);
    });

    it('accepts a sane endpoint with custom headers', async () => {
      const res = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { ...good, custom_headers: { 'X-Tenant': 'acme' }, timeout_ms: 15_000 },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ custom_headers: { 'X-Tenant': 'acme' }, timeout_ms: 15_000 });
    });
  });

  describe('soft delete over the wire', () => {
    it('204, then the row is still there and still fetchable', async () => {
      const created = await call('POST', endpointsPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: good,
      });
      const id = String(created.body.id);

      const removed = await call('DELETE', `${endpointsPath(IDS.projectA1)}/${id}`, {
        as: IDS.ownerA,
      });
      expect(removed.status).toBe(204);
      expect(db.rows('endpoint').get(id)).toMatchObject({ status: 'deleted' });

      const fetched = await call('GET', `${endpointsPath(IDS.projectA1)}/${id}`, {
        as: IDS.ownerA,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.body.status).toBe('deleted');
    });

    it('403 for a viewer attempting to delete', async () => {
      const res = await call('DELETE', `${endpointsPath(IDS.projectA1)}/${IDS.endpointA1}`, {
        as: IDS.viewerA,
      });
      expect(res.status).toBe(403);
    });
  });
});
