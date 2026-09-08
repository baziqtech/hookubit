import { INestApplication } from '@nestjs/common';
import { CROSS_TENANT_MESSAGE, assertRoutesAreGuarded } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { THROTTLE_KEY, ThrottleOptions } from '../common/throttle.guard';
import { AnalyticsController } from './analytics.controller';
import { MAX_WINDOW_HOURS } from './analytics-window';
import {
  AttemptLatencyDto,
  DeliveryOutcomesDto,
  EventVolumeDto,
  FailingEndpointsDto,
} from './dto';
import { ANALYTICS, EXPECTED, HttpHarness, HttpResult, analyticsPath, startAnalyticsApp } from './testing/harness';

/**
 * The controller on a real port, with the real guards, the real `ValidationPipe`
 * settings from main.ts and the real exception filter.
 *
 * The status codes are the product here. A 403 where a 404 belongs turns
 * `GET /v1/projects/<guessed id>/analytics/deliveries` into an oracle for
 * whether that id names a live project belonging to someone else - and an
 * analytics route is a particularly attractive one to probe, because a single
 * unauthorised response would carry another customer's traffic volume.
 */
describe('analytics over HTTP', () => {
  let harness: HttpHarness;
  const call = <T>(path: string, as?: string): Promise<HttpResult<T>> =>
    harness.call<T>('GET', path, { as });

  const A1 = analyticsPath(IDS.projectA1);
  const B1 = analyticsPath(IDS.projectB1);
  const ROUTES = ['deliveries', 'endpoints', 'latency', 'events'] as const;

  beforeAll(async () => {
    harness = await startAnalyticsApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  describe('every route with authorization metadata has an enforcing guard', () => {
    it('finds no route serving unauthenticated', () => {
      expect(() => assertRoutesAreGuarded(harness.app as INestApplication)).not.toThrow();
    });
  });

  describe('authentication', () => {
    it.each(ROUTES)('GET /analytics/%s is 401 with no session', async (route) => {
      expect((await call(`${A1}/${route}`)).status).toBe(401);
    });
  });

  describe('the tenant boundary', () => {
    it.each(ROUTES)(
      '%s: a user outside the organization gets 404 with the shared message, never 403',
      async (route) => {
        const res = await call(`${A1}/${route}`, IDS.stranger);
        expect(res.status).toBe(404);
        expect(res.body.error?.code).toBe('not_found');
        expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
      },
    );

    it.each(ROUTES)("%s: organization A's owner cannot read organization B", async (route) => {
      const res = await call(`${B1}/${route}`, IDS.ownerA);
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    });

    it.each(ROUTES)('%s: an absent project id is the SAME answer as a foreign one', async (route) => {
      const absent = await call(`${analyticsPath('proj_does_not_exist')}/${route}`, IDS.ownerA);
      const foreign = await call(`${B1}/${route}`, IDS.ownerA);
      expect(absent.status).toBe(foreign.status);
      expect(absent.body.error?.message).toBe(foreign.body.error?.message);
    });

    it('a cross-tenant 404 carries no numbers at all', async () => {
      const res = await call<DeliveryOutcomesDto>(`${B1}/deliveries`, IDS.ownerA);
      // Organization B really does have nine exhausted deliveries in the
      // window. None of that may appear here, in any field.
      expect(JSON.stringify(res.body)).not.toContain('exhausted');
      expect(res.body.current).toBeUndefined();
    });
  });

  describe('the permission matrix, over the wire', () => {
    it.each(ROUTES)('viewer may read %s', async (route) => {
      // `deliveries.read` and `events.read` both include viewer, and an
      // aggregate of rows a viewer may already list one by one is not a
      // stronger grant than the listing itself.
      expect((await call(`${A1}/${route}`, IDS.viewerA)).status).toBe(200);
    });

    it.each(ROUTES)('billing may NOT read %s', async (route) => {
      // `billing` is deliberately fenced out of both `deliveries.read` and
      // `events.read`: it sees money and seats, not traffic. It is IN the
      // tenant, so this is the one case that is a 403 rather than a 404.
      const res = await call(`${A1}/${route}`, IDS.billingA);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('forbidden');
    });

    it.each(ROUTES)('developer may read %s', async (route) => {
      expect((await call(`${A1}/${route}`, IDS.developerA)).status).toBe(200);
    });
  });

  describe('the window ceiling, on the wire', () => {
    it.each(ROUTES)('%s: the ceiling exactly is accepted', async (route) => {
      const res = await call(`${A1}/${route}?window_hours=${MAX_WINDOW_HOURS}`, IDS.ownerA);
      expect(res.status).toBe(200);
    });

    it.each(ROUTES)('%s: one hour past the ceiling is a 400, not a clamp', async (route) => {
      const res = await call<DeliveryOutcomesDto>(
        `${A1}/${route}?window_hours=${MAX_WINDOW_HOURS + 1}`,
        IDS.ownerA,
      );
      expect(res.status).toBe(400);
      // The failure mode being prevented: a 200 whose `window.hours` is 720
      // when 721 was asked for.
      expect(res.body.window).toBeUndefined();
    });

    it.each([0, -1, 'abc', '1.5'])('window_hours=%p is a 400', async (value) => {
      expect((await call(`${A1}/deliveries?window_hours=${value}`, IDS.ownerA)).status).toBe(400);
    });

    it('an unknown query parameter is refused rather than ignored', async () => {
      // `forbidNonWhitelisted`. A silently ignored `window=30d` would return the
      // 24h default under a 30-day label.
      expect((await call(`${A1}/deliveries?window=30d`, IDS.ownerA)).status).toBe(400);
    });

    it('the response echoes the window that was actually used', async () => {
      const res = await call<DeliveryOutcomesDto>(`${A1}/deliveries?window_hours=48`, IDS.ownerA);
      expect(res.status).toBe(200);
      expect(res.body.window.hours).toBe(48);
    });
  });

  describe('the payloads', () => {
    it('deliveries: the counts a caller sees are the project\'s own', async () => {
      const res = await call<DeliveryOutcomesDto>(`${A1}/deliveries`, IDS.ownerA);
      expect(res.status).toBe(200);
      expect(res.body.current.total).toBe(EXPECTED.window.total);
      expect(res.body.current.succeeded).toBe(EXPECTED.window.succeeded);
      expect(res.body.current.success_rate).toBe(EXPECTED.window.successRate);
      expect(res.body.previous.total).toBe(EXPECTED.previous.total);
    });

    it('endpoints: worst first', async () => {
      const res = await call<FailingEndpointsDto>(`${A1}/endpoints`, IDS.ownerA);
      expect(res.status).toBe(200);
      expect(res.body.data[0].endpoint_id).toBe(ANALYTICS.endpointPayments);
      expect(res.body.data[0].failing).toBe(7);
    });

    it('latency: percentiles plus the honesty flags', async () => {
      const res = await call<AttemptLatencyDto>(`${A1}/latency`, IDS.ownerA);
      expect(res.status).toBe(200);
      expect(res.body.p50_ms).toBe(EXPECTED.latency.p50);
      expect(res.body.p95_ms).toBe(EXPECTED.latency.p95);
      expect(res.body.sample_size).toBe(EXPECTED.latency.sampleSize);
      expect(res.body.exact).toBe(true);
    });

    it('events: volume and the busiest types', async () => {
      const res = await call<EventVolumeDto>(`${A1}/events`, IDS.ownerA);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(EXPECTED.events.total);
      expect(res.body.by_type[0]).toEqual(EXPECTED.events.byType[0]);
    });
  });

  describe('throttling', () => {
    it.each(ROUTES)('%s declares a limit', (route) => {
      // Aggregates over the three largest tables in the product. An
      // unthrottled one is a self-inflicted load test one auto-refresh away.
      const handler = (AnalyticsController.prototype as unknown as Record<string, unknown>)[
        route === 'deliveries' ? 'deliveries' : route
      ];
      const options = Reflect.getMetadata(THROTTLE_KEY, handler as object) as
        | ThrottleOptions
        | undefined;
      expect(options).toBeDefined();
      expect(options?.name).toBe(`analytics.${route}`);
      expect(options?.limit).toBeGreaterThan(0);
      expect(options?.windowMs).toBeGreaterThan(0);
    });

    it('the latency route is the most tightly limited of the four', () => {
      const limitOf = (name: string): number => {
        const handler = (AnalyticsController.prototype as unknown as Record<string, unknown>)[name];
        return (Reflect.getMetadata(THROTTLE_KEY, handler as object) as ThrottleOptions).limit;
      };
      expect(limitOf('latency')).toBeLessThan(limitOf('deliveries'));
    });
  });
});
