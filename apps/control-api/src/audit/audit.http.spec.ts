import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'node:net';
import { TenantGuard, TenantResolver, TenantScopeFactory } from '../authz';
import { IDS, seedWorld } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { SessionGuard } from '../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../auth/session.service';
import { AppExceptionFilter } from '../common/errors';
import { ThrottleGuard } from '../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../common/throttle.store';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogListDto } from './dto';
import { seedTrail } from './testing/harness';

/** Authentication has its own suite; the cookie here is just a user id. */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

interface HttpResult<T> {
  status: number;
  body: T & { error?: { code: string; message: string; details?: Record<string, unknown> } };
}

/**
 * The audit route as a browser meets it: real Nest, the real guards mounted by
 * `@Authorized`, the real global `ValidationPipe` and the real exception filter.
 *
 * The unit suite proves the query rules. This one proves the WIRING - that
 * `audit.read` is really on the handlers (so a viewer really gets a 403 rather
 * than a page of everyone else's IP addresses), that the tenant is resolved
 * from `:orgId` rather than trusted from it, and that there is no verb but GET
 * on the controller.
 */
describe('audit logs over HTTP', () => {
  let app: INestApplication;
  let db: FakeTenantPrisma;
  let baseUrl: string;

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { as?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
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

  const logs = (orgId: string): string => `/v1/organizations/${orgId}/audit-logs`;

  beforeAll(async () => {
    db = seedWorld();
    seedTrail(db);

    const moduleRef = await Test.createTestingModule({
      controllers: [AuditLogsController],
      providers: [
        { provide: SessionService, useClass: StubSessionService },
        { provide: TenantResolver, useValue: new TenantResolver(db.asPrisma()) },
        { provide: TenantScopeFactory, useValue: new TenantScopeFactory(db.asPrisma()) },
        // Far above what this suite issues, so the guard is proved MOUNTED
        // without any test here depending on a 429.
        { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
        ThrottleGuard,
        SessionGuard,
        TenantGuard,
        AuditLogsService,
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

  // ---------------------------------------------------------------------------
  // Who may read it
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('401s with no session cookie', async () => {
      const res = await call('GET', logs(IDS.orgA));
      expect(res.status).toBe(401);
    });

    it.each([
      ['owner', IDS.ownerA],
      ['admin', IDS.adminA],
    ])('lets an %s read the trail', async (_role, userId) => {
      const res = await call<AuditLogListDto>('GET', logs(IDS.orgA), { as: userId });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it.each([
      ['viewer', IDS.viewerA],
      ['developer', IDS.developerA],
      ['billing', IDS.billingA],
    ])('403s a %s, who holds members.read but not audit.read', async (_role, userId) => {
      // The whole reason `audit.read` exists as its own permission. These rows
      // carry other members' actions, IP addresses and user agents; viewer and
      // billing hold `members.read`, so reusing that would have handed them a
      // log of everyone else's whereabouts.
      const res = await call('GET', logs(IDS.orgA), { as: userId });
      expect(res.status).toBe(403);
    });

    it('403s a viewer on the single-row route as well as the list', async () => {
      const res = await call('GET', `${logs(IDS.orgA)}/aud_a1`, { as: IDS.viewerA });
      expect(res.status).toBe(403);
    });

    it('404s the trail of an organization the caller is not in', async () => {
      // Not 403: a 403 would confirm org B exists and that the caller guessed a
      // live tenant id.
      const res = await call('GET', logs(IDS.orgB), { as: IDS.ownerA });
      expect(res.status).toBe(404);
    });

    it("404s another tenant's audit row addressed through the caller's own org", async () => {
      const res = await call('GET', `${logs(IDS.orgA)}/aud_b1`, { as: IDS.ownerA });
      expect(res.status).toBe(404);
      const absent = await call('GET', `${logs(IDS.orgA)}/aud_missing`, { as: IDS.ownerA });
      expect(absent.body.error?.message).toBe(res.body.error?.message);
    });
  });

  // ---------------------------------------------------------------------------
  // The wire contract
  // ---------------------------------------------------------------------------

  describe('responses', () => {
    it('returns exactly the canonical envelope', async () => {
      const res = await call<AuditLogListDto>('GET', logs(IDS.orgA), { as: IDS.ownerA });
      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
      expect(res.body.has_more).toBe(false);
      expect(res.body.next_offset).toBeNull();
    });

    it('reports a numeric next_offset when the page is bounded, and null on the last', async () => {
      const first = await call<AuditLogListDto>('GET', `${logs(IDS.orgA)}?limit=2`, {
        as: IDS.ownerA,
      });
      expect(first.body.has_more).toBe(true);
      expect(first.body.next_offset).toBe(2);

      const last = await call<AuditLogListDto>(
        'GET',
        `${logs(IDS.orgA)}?limit=2&offset=${first.body.next_offset}`,
        { as: IDS.ownerA },
      );
      expect(last.body.has_more).toBe(false);
      expect(last.body.next_offset).toBeNull();
      expect(last.body.data.map((row) => row.id)).not.toEqual(
        first.body.data.map((row) => row.id),
      );
    });

    it('carries the actor, the resource and the request fingerprint on every row', async () => {
      const res = await call<AuditLogListDto>('GET', `${logs(IDS.orgA)}?action=api_key.revoked`, {
        as: IDS.ownerA,
      });
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: 'aud_a3',
        organization_id: IDS.orgA,
        user_id: IDS.adminA,
        api_key_id: null,
        action: 'api_key.revoked',
        resource_type: 'api_key',
        resource_id: 'ak_a1',
        ip_address: '203.0.113.9',
        user_agent: 'jest',
      });
    });

    it('serves metadata as stored, with the write-time redaction intact', async () => {
      const res = await call<AuditLogListDto>('GET', `${logs(IDS.orgA)}?action=endpoint.created`, {
        as: IDS.ownerA,
      });
      expect(res.body.data[0].metadata).toEqual({
        name: 'finance',
        signing_secret: '[redacted]',
      });
    });

    it('400s an unknown query parameter rather than ignoring it', async () => {
      // `forbidNonWhitelisted`. It matters here: a filter that is silently
      // dropped reads as "no rows matched", which on an audit log is the answer
      // that must never be given by accident.
      const res = await call('GET', `${logs(IDS.orgA)}?metadata=secret`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });

    it('400s an inverted date range', async () => {
      const res = await call(
        'GET',
        `${logs(IDS.orgA)}?created_after=2026-09-05T00:00:00.000Z&created_before=2026-09-01T00:00:00.000Z`,
        { as: IDS.ownerA },
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_request');
    });

    it('400s a limit above the page ceiling instead of silently clamping it', async () => {
      const res = await call('GET', `${logs(IDS.orgA)}?limit=5000`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Append-only, over the wire
  // ---------------------------------------------------------------------------

  describe('no mutating route exists', () => {
    it.each([
      ['POST', logs(IDS.orgA)],
      ['PUT', logs(IDS.orgA)],
      ['PATCH', `${logs(IDS.orgA)}/aud_a1`],
      ['DELETE', `${logs(IDS.orgA)}/aud_a1`],
      ['POST', `${logs(IDS.orgA)}/aud_a1`],
    ])('%s %s is not routed at all', async (method, path) => {
      const res = await call(method, path, { as: IDS.ownerA, body: { action: 'forged.thing' } });
      // 404 from Nest's router, not 403 from a guard: the handler does not
      // exist. An owner has every permission in this organization and still
      // cannot write, alter or remove an audit row through this module.
      expect(res.status).toBe(404);
    });

    it('leaves the table byte-for-byte unchanged after every request above', async () => {
      const rows = db.all('auditLog');
      expect(rows.map((row) => row.id).sort()).toEqual([
        'aud_a1',
        'aud_a2',
        'aud_a3',
        'aud_a4',
        'aud_b1',
      ]);
      expect(db.queries.filter((q) => q.table === 'auditLog' && q.op !== 'find')).toEqual([]);
    });
  });
});
