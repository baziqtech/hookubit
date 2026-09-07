import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'node:net';
import { AuditService, TenantGuard, TenantResolver, TenantScopeFactory } from '../authz';
import { IDS, seedWorld } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { SessionGuard } from '../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../auth/session.service';
import { AppExceptionFilter } from '../common/errors';
import { THROTTLE_KEY, ThrottleGuard, ThrottleOptions } from '../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../common/throttle.store';
import { testTransactions } from '../endpoint-secrets/testing/harness';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import { RateLimitsController } from '../rate-limits/rate-limits.controller';
import { RateLimitsService } from '../rate-limits/rate-limits.service';
import { RetryPoliciesController } from './retry-policies.controller';
import { RetryPoliciesService } from './retry-policies.service';
import { backfillPolicies } from './testing/harness';

/** Authentication has its own suite; the cookie here is just a user id. */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: {
    error?: { code: string; message: string; details?: Record<string, unknown> };
    [key: string]: unknown;
  };
}

/**
 * Both policy modules as a browser meets them: real Nest, real guards mounted by
 * `@Authorized`, the real global `ValidationPipe` and the real exception filter,
 * on a real port.
 *
 * The unit suites prove the rules. This one proves the WIRING — that the
 * decorators are actually on the handlers, that `policies.read`/`policies.write`
 * really split viewer from developer, that the 404/403 distinction survives all
 * the way to a status code, and that `@Throttle` is not just present in the
 * source but reached at request time.
 */
describe('retry-policies and rate-limits over HTTP', () => {
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
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : {},
    };
  }

  beforeAll(async () => {
    db = backfillPolicies(seedWorld());
    const scopes = new TenantScopeFactory(db.asPrisma());
    const audit = new AuditService(db.asPrisma());

    const moduleRef = await Test.createTestingModule({
      controllers: [RetryPoliciesController, RateLimitsController],
      providers: [
        { provide: SessionService, useClass: StubSessionService },
        { provide: TenantResolver, useValue: new TenantResolver(db.asPrisma()) },
        { provide: TenantScopeFactory, useValue: scopes },
        { provide: AuditService, useValue: audit },
        { provide: TenantTransactionRunner, useValue: testTransactions(db, scopes, audit) },
        { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
        ThrottleGuard,
        SessionGuard,
        TenantGuard,
        RetryPoliciesService,
        RateLimitsService,
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

  const retryPath = (projectId: string): string => `/v1/projects/${projectId}/retry-policies`;
  const ratePath = (projectId: string): string => `/v1/projects/${projectId}/rate-limits`;

  describe('authentication and tenancy', () => {
    it.each([
      ['retry-policies', retryPath(IDS.projectA1)],
      ['rate-limits', ratePath(IDS.projectA1)],
    ])('401 without a session on %s', async (_name, path) => {
      const res = await call('GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('unauthenticated');
    });

    it.each([
      ['retry-policies', retryPath(IDS.projectB1)],
      ['rate-limits', ratePath(IDS.projectB1)],
    ])('404, not 403, for a project in another organization (%s)', async (_name, path) => {
      const res = await call('GET', path, { as: IDS.ownerA });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Resource not found.' });
    });

    it('404 for another tenant policy addressed by id, identical to an absent one', async () => {
      const foreign = await call('GET', `${retryPath(IDS.projectA1)}/${IDS.retryPolicyB1}`, {
        as: IDS.ownerA,
      });
      const absent = await call('GET', `${retryPath(IDS.projectA1)}/rp_nope`, { as: IDS.ownerA });
      expect(foreign.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(foreign.body.error?.message).toBe(absent.body.error?.message);
    });

    it('404 for a rate limit naming another tenant endpoint - the write never lands', async () => {
      const res = await call('POST', ratePath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { scope: 'endpoint', resource_id: IDS.endpointB1, limit: 10 },
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe('Resource not found.');
    });
  });

  describe('the policies.read / policies.write split', () => {
    it('a viewer may read but not write', async () => {
      const read = await call('GET', retryPath(IDS.projectA1), { as: IDS.viewerA });
      expect(read.status).toBe(200);

      const write = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.viewerA,
        body: { name: 'nope' },
      });
      expect(write.status).toBe(403);
      expect(write.body.error?.code).toBe('forbidden');
    });

    it('a developer may write', async () => {
      const res = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.developerA,
        body: { name: 'developer policy' },
      });
      expect(res.status).toBe(201);
    });

    it('a billing member may not even read', async () => {
      const res = await call('GET', ratePath(IDS.projectA1), { as: IDS.billingA });
      expect(res.status).toBe(403);
    });
  });

  describe('validation reaches the wire', () => {
    it('rejects max_delay_ms = 0 with a 400 that names the field', async () => {
      const res = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'runaway', max_delay_ms: 0 },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('max_delay_ms');
    });

    it('rejects an unknown strategy', async () => {
      const res = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'x', strategy: 'fibonacci' },
      });
      expect(res.status).toBe(400);
    });

    /**
     * `is_default` is not on the update DTO, and `forbidNonWhitelisted` turns
     * that into a 400 rather than a silently ignored field — which matters,
     * because a caller who thinks they moved the default and did not would only
     * find out from the delivery log.
     */
    it('rejects is_default on PATCH rather than ignoring it', async () => {
      const created = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'patch target' },
      });
      const res = await call('PATCH', `${retryPath(IDS.projectA1)}/${created.body.id as string}`, {
        as: IDS.ownerA,
        body: { is_default: true },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('is_default');
    });

    it('rejects a limit of 0 on a rate limit', async () => {
      const res = await call('POST', ratePath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { scope: 'project', limit: 0 },
      });
      expect(res.status).toBe(400);
    });

    it('rejects a page size above the repository ceiling instead of silently clamping', async () => {
      const res = await call('GET', `${retryPath(IDS.projectA1)}?limit=5000`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });
  });

  describe('the list envelope', () => {
    it.each([
      ['retry-policies', retryPath(IDS.projectA1)],
      ['rate-limits', ratePath(IDS.projectA1)],
    ])('is exactly { data, has_more, next_offset } on %s', async (_name, path) => {
      const res = await call('GET', path, { as: IDS.ownerA });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(typeof res.body.has_more).toBe('boolean');
      // null, not absent and not 0, so a client branches on one thing.
      expect(res.body.next_offset === null || typeof res.body.next_offset === 'number').toBe(true);
    });
  });

  describe('set-default and delete', () => {
    it('POST /:id/default moves the default and returns the policy', async () => {
      const created = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'to promote' },
      });
      const res = await call(
        'POST',
        `${retryPath(IDS.projectA1)}/${created.body.id as string}/default`,
        { as: IDS.ownerA },
      );
      expect(res.status).toBe(200);
      expect(res.body.is_default).toBe(true);
    });

    it('DELETE of the default without a replacement is a 409', async () => {
      const list = await call('GET', `${retryPath(IDS.projectA1)}?is_default=true`, {
        as: IDS.ownerA,
      });
      const current = (list.body.data as Array<{ id: string }>)[0];
      const res = await call('DELETE', `${retryPath(IDS.projectA1)}/${current.id}`, {
        as: IDS.ownerA,
      });
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('conflict');
      expect(res.body.error?.message).toContain('replacement_id');
    });

    it('DELETE of a non-default policy is 204', async () => {
      const created = await call('POST', retryPath(IDS.projectA1), {
        as: IDS.ownerA,
        body: { name: 'disposable' },
      });
      const res = await call('DELETE', `${retryPath(IDS.projectA1)}/${created.body.id as string}`, {
        as: IDS.ownerA,
      });
      expect(res.status).toBe(204);
    });
  });

  describe('a duplicate rate limit is a 409, and a ceiling is not', () => {
    it('the NULLS NOT DISTINCT identity collision returns a real conflict', async () => {
      const body = { scope: 'ingest', resource_id: null, limit: 100 };
      const first = await call('POST', ratePath(IDS.projectA1), { as: IDS.ownerA, body });
      expect(first.status).toBe(201);

      const second = await call('POST', ratePath(IDS.projectA1), { as: IDS.ownerA, body });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('conflict');
      expect(second.body.error?.details).toMatchObject({ scope: 'ingest', resource_id: null });
    });
  });

  /**
   * The throttle metadata, read off the handlers.
   *
   * Asserted structurally as well as behaviourally: the 429 test below proves
   * the guard runs, and this proves it is attached to EVERY write route rather
   * than to the one that happened to be tested. A new write route added without
   * a `@Throttle` fails here.
   */
  describe('@Throttle is on every write route', () => {
    const PROTOTYPES: Record<string, object> = {
      RetryPoliciesController: RetryPoliciesController.prototype,
      RateLimitsController: RateLimitsController.prototype,
    };

    const throttleOf = (controller: string, method: string): ThrottleOptions | undefined =>
      Reflect.getMetadata(
        THROTTLE_KEY,
        (PROTOTYPES[controller] as Record<string, () => unknown>)[method],
      ) as ThrottleOptions | undefined;

    it.each([
      ['RetryPoliciesController', 'create'],
      ['RetryPoliciesController', 'update'],
      ['RetryPoliciesController', 'setDefault'],
      ['RetryPoliciesController', 'remove'],
      ['RateLimitsController', 'create'],
      ['RateLimitsController', 'update'],
      ['RateLimitsController', 'remove'],
    ])('%s.%s carries a throttle', (controller, method) => {
      const options = throttleOf(controller, method);
      expect(options).toBeDefined();
      expect(options?.limit).toBeGreaterThan(0);
      expect(options?.windowMs).toBeGreaterThan(0);
    });

    it.each([
      ['RetryPoliciesController', 'list'],
      ['RetryPoliciesController', 'get'],
      ['RateLimitsController', 'list'],
      ['RateLimitsController', 'get'],
    ])('%s.%s does not (reads are not throttled here)', (controller, method) => {
      expect(throttleOf(controller, method)).toBeUndefined();
    });
  });

  /**
   * And the guard is actually reached. Deliberately LAST in the file: it fills
   * the `rate-limits.write` bucket for this address, and anything after it would
   * be 429ed for reasons that have nothing to do with what it was testing.
   *
   * The requests are unauthenticated on purpose. Controller-level guards run
   * before method-level ones in Nest, so `ThrottleGuard` charges the bucket
   * before `SessionGuard` rejects the request — which is the property that makes
   * a rate limit useful against an unauthenticated spray in the first place.
   */
  describe('the throttle actually refuses (runs last - it fills the bucket)', () => {
    it('starts returning 429 with Retry-After once the window budget is spent', async () => {
      let limited: HttpResult | null = null;
      for (let i = 0; i < 120 && !limited; i += 1) {
        const res = await call('POST', ratePath(IDS.projectA1), {
          body: { scope: 'project', limit: 1 },
        });
        if (res.status === 429) limited = res;
        else expect(res.status).toBe(401);
      }

      expect(limited).not.toBeNull();
      expect(limited?.body.error?.code).toBe('rate_limited');
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited?.body.error?.details?.retry_after_seconds).toBeGreaterThan(0);
    }, 20_000);
  });
});
