import { INestApplication } from '@nestjs/common';
import { CROSS_TENANT_MESSAGE, assertRoutesAreGuarded } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { THROTTLE_KEY, ThrottleOptions } from '../common/throttle.guard';
import { EventsController } from '../events/events.controller';
import { DeliveriesController } from './deliveries.controller';
import { DeliveryListDto, ReplayResultDto } from './dto';
import {
  DELIVERIES_PATH,
  EVENTS_PATH,
  HttpHarness,
  HttpResult,
  LEDGER,
  startLedgerApp,
} from './testing/harness';

/**
 * Both controllers on a real port, with the real guards, the real
 * `ValidationPipe` settings from main.ts and the real exception filter.
 *
 * `GET /events/:id/deliveries` is served by the events controller out of the
 * deliveries service, so mounting them separately would test a wiring that does
 * not exist.
 */
describe('the ledger over HTTP', () => {
  let harness: HttpHarness;
  const call = <T>(
    method: string,
    path: string,
    options?: { as?: string; body?: unknown },
  ): Promise<HttpResult<T>> => harness.call<T>(method, path, options);

  beforeAll(async () => {
    harness = await startLedgerApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  const deliveryPath = (id: string): string => `${DELIVERIES_PATH}/${id}`;
  const eventPath = (id: string): string => `${EVENTS_PATH}/${id}`;

  describe('every route with authorization metadata has an enforcing guard', () => {
    it('finds no route serving unauthenticated', () => {
      expect(() => assertRoutesAreGuarded(harness.app as INestApplication)).not.toThrow();
    });
  });

  describe('authentication', () => {
    it.each([
      ['GET', DELIVERIES_PATH],
      ['GET', EVENTS_PATH],
      ['GET', deliveryPath(LEDGER.deliveryOrderA1)],
      ['GET', eventPath(LEDGER.eventOrder)],
    ])('%s %s is 401 with no session', async (method, path) => {
      expect((await call(method, path)).status).toBe(401);
    });

    it('a session for a user outside the organization is a 404, not a 403', async () => {
      // A 403 would confirm the project id names a live project somewhere.
      const res = await call(DELIVERIES_PATH.startsWith('/') ? 'GET' : 'GET', DELIVERIES_PATH, {
        as: IDS.stranger,
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    });
  });

  describe('the permission matrix, over the wire', () => {
    it('viewer may read deliveries and events', async () => {
      expect((await call('GET', DELIVERIES_PATH, { as: IDS.viewerA })).status).toBe(200);
      expect((await call('GET', EVENTS_PATH, { as: IDS.viewerA })).status).toBe(200);
      expect(
        (await call('GET', deliveryPath(LEDGER.deliveryOrderA1), { as: IDS.viewerA })).status,
      ).toBe(200);
    });

    it('viewer may NOT replay - it re-sends real traffic to a customer', async () => {
      expect(
        (await call('POST', `${deliveryPath(LEDGER.deliveryOrderA1)}/replay`, {
          as: IDS.viewerA,
          body: {},
        })).status,
      ).toBe(403);
      expect(
        (await call('POST', `${eventPath(LEDGER.eventOrder)}/replay`, {
          as: IDS.viewerA,
          body: {},
        })).status,
      ).toBe(403);
    });

    it('billing sees no events and no deliveries at all', async () => {
      expect((await call('GET', DELIVERIES_PATH, { as: IDS.billingA })).status).toBe(403);
      expect((await call('GET', EVENTS_PATH, { as: IDS.billingA })).status).toBe(403);
    });

    it('developer may read and replay', async () => {
      const res = await call<ReplayResultDto>(
        'POST',
        `${deliveryPath(LEDGER.deliverySettledA1)}/replay`,
        { as: IDS.developerA, body: { reason: 'developer retry' } },
      );
      expect(res.status).toBe(201);
      expect(res.body.replayed_count).toBe(1);
      expect(res.body.deliveries[0].replayed_by).toBe(IDS.developerA);
    });
  });

  describe('list envelopes', () => {
    it('deliveries: exactly {data, has_more, next_offset}', async () => {
      const res = await call<DeliveryListDto>('GET', `${DELIVERIES_PATH}?limit=2`, {
        as: IDS.ownerA,
      });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.has_more).toBe(true);
      expect(res.body.next_offset).toBe(2);
    });

    it('events: the same three keys, never a bare array', async () => {
      const res = await call('GET', `${EVENTS_PATH}?limit=1`, { as: IDS.ownerA });

      expect(Array.isArray(res.body)).toBe(false);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
    });

    it("an event's deliveries: the same three keys", async () => {
      const res = await call('GET', `${eventPath(LEDGER.eventOrder)}/deliveries`, {
        as: IDS.ownerA,
      });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
    });

    it('attempts: the same three keys', async () => {
      const res = await call('GET', `${deliveryPath(LEDGER.deliveryOrderA1)}/attempts`, {
        as: IDS.ownerA,
      });

      expect(Object.keys(res.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
    });
  });

  describe('query parameter parsing', () => {
    it('`failing_now=false` means FALSE', async () => {
      // The BooleanQuery decorator exists because `@Type(() => Boolean)`
      // compiles to `Boolean('false')`, which is true - the caller would have
      // received the exact opposite of what they asked for, with a 200.
      const off = await call<DeliveryListDto>(
        'GET',
        `${DELIVERIES_PATH}?failing_now=false&limit=200`,
        { as: IDS.ownerA },
      );
      const on = await call<DeliveryListDto>(
        'GET',
        `${DELIVERIES_PATH}?failing_now=true&limit=200`,
        { as: IDS.ownerA },
      );

      expect(off.body.data.length).toBeGreaterThan(on.body.data.length);
      expect(off.body.data.some((delivery) => delivery.status === 'succeeded')).toBe(true);
      expect(on.body.data.every((delivery) => delivery.status !== 'succeeded')).toBe(true);
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const res = await call('GET', `${DELIVERIES_PATH}?nonsense=1`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });

    it('rejects a limit above the ceiling with a 400 that says the maximum', async () => {
      const res = await call('GET', `${DELIVERIES_PATH}?limit=5000`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });

    it('rejects an idempotency-key fragment shorter than the minimum', async () => {
      expect((await call('GET', `${EVENTS_PATH}?idempotency_key=41`, { as: IDS.ownerA })).status).toBe(
        400,
      );
      expect(
        (await call('GET', `${EVENTS_PATH}?idempotency_key=41f9`, { as: IDS.ownerA })).status,
      ).toBe(200);
    });

    it('rejects an unparseable date', async () => {
      const res = await call('GET', `${EVENTS_PATH}?created_after=yesterday`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });
  });

  describe('cross-tenant addressing is one 404 with one message', () => {
    it.each([
      ['GET', deliveryPath(IDS.deliveryB1)],
      ['GET', deliveryPath(IDS.deliveryCorrupt)],
      ['GET', `${deliveryPath(IDS.deliveryB1)}/attempts`],
      ['POST', `${deliveryPath(IDS.deliveryB1)}/replay`],
      ['GET', eventPath(IDS.eventB1)],
      ['GET', `${eventPath(IDS.eventB1)}/deliveries`],
      ['POST', `${eventPath(IDS.eventB1)}/replay`],
    ])('%s %s', async (method, path) => {
      const res = await call(method, path, { as: IDS.ownerA, body: method === 'POST' ? {} : undefined });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('not_found');
      expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    });

    it("an endpoint id in the replay BODY gets the same answer as an id in the path", async () => {
      const res = await call('POST', `${eventPath(LEDGER.eventOrder)}/replay`, {
        as: IDS.ownerA,
        body: { endpoint_id: IDS.endpointB1 },
      });

      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    });
  });

  describe('the payload is labelled on the wire', () => {
    it('the raw bytes are the payload; the jsonb copy is marked as not delivered', async () => {
      const res = await call<{
        payload: { source: string; body: string; normalised_json: unknown; notice: string };
      }>('GET', eventPath(LEDGER.eventSettled), { as: IDS.ownerA });

      expect(res.status).toBe(200);
      expect(res.body.payload.source).toBe('inline');
      expect(res.body.payload.body).toBe('{ "b": 2,\n  "a": 1 }');
      expect(res.body.payload.normalised_json).toEqual({ a: 1, b: 2 });
      expect(res.body.payload.notice).toContain('NOT what was delivered');
    });

    it('an offloaded payload is reported, not returned as an empty body', async () => {
      const res = await call<{ payload: { source: string; body: null; location: string } }>(
        'GET',
        eventPath(LEDGER.eventOffloaded),
        { as: IDS.ownerA },
      );

      expect(res.body.payload.source).toBe('object_storage');
      expect(res.body.payload.body).toBeNull();
      expect(res.body.payload.location).toBe('s3://payloads/proj_a1/evt_a_big.json');
    });
  });

  describe('replay refusals carry a reason a human can act on', () => {
    it('409 for a soft-deleted endpoint', async () => {
      const res = await call('POST', `${deliveryPath(LEDGER.deliverySettledGone)}/replay`, {
        as: IDS.ownerA,
        body: {},
      });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('conflict');
      expect(res.body.error?.details).toMatchObject({ endpoint_status: 'deleted' });
    });

    it('409 with structured details for a routing over the cap', async () => {
      const res = await call('POST', `${eventPath(LEDGER.eventWide)}/replay`, {
        as: IDS.ownerA,
        body: {},
      });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('limit_exceeded');
      expect(res.body.error?.details).toMatchObject({ resource: 'replay_deliveries' });
    });

    it('rejects a reason longer than the limit rather than storing it', async () => {
      const res = await call('POST', `${deliveryPath(LEDGER.deliveryOrderA1)}/replay`, {
        as: IDS.ownerA,
        body: { reason: 'x'.repeat(501) },
      });

      expect(res.status).toBe(400);
    });
  });

  /**
   * The throttle metadata, read off the handlers.
   *
   * Structural as well as behavioural: the 429 test below proves the guard
   * runs, and this proves it is attached to EVERY write route rather than to
   * the one that happened to be tested. A new replay route added without a
   * `@Throttle` fails here.
   */
  describe('@Throttle is on every write route', () => {
    const PROTOTYPES: Record<string, object> = {
      DeliveriesController: DeliveriesController.prototype,
      EventsController: EventsController.prototype,
    };
    const throttleOf = (controller: string, method: string): ThrottleOptions | undefined =>
      Reflect.getMetadata(
        THROTTLE_KEY,
        (PROTOTYPES[controller] as Record<string, () => unknown>)[method],
      ) as ThrottleOptions | undefined;

    it.each([
      ['DeliveriesController', 'replay'],
      ['EventsController', 'replay'],
    ])('%s.%s carries a throttle', (controller, method) => {
      const options = throttleOf(controller, method);
      expect(options).toBeDefined();
      expect(options?.limit).toBeGreaterThan(0);
      expect(options?.windowMs).toBeGreaterThan(0);
    });

    it('the event replay is tighter than the single-delivery replay', () => {
      // One event replay can create up to MAX_REPLAY_DELIVERIES real HTTP calls;
      // one delivery replay creates one.
      const perEvent = throttleOf('EventsController', 'replay');
      const perDelivery = throttleOf('DeliveriesController', 'replay');
      expect(perEvent?.limit).toBeLessThan(perDelivery?.limit ?? 0);
    });

    it.each([
      ['DeliveriesController', 'list'],
      ['DeliveriesController', 'get'],
      ['DeliveriesController', 'attempts'],
      ['EventsController', 'list'],
      ['EventsController', 'get'],
      ['EventsController', 'deliveries'],
    ])('%s.%s does not (reads are not throttled here)', (controller, method) => {
      expect(throttleOf(controller, method)).toBeUndefined();
    });
  });

  /**
   * And the guard is actually reached. Deliberately LAST in the file: it fills
   * the `events.replay` bucket for this address, and anything after it would be
   * 429ed for reasons unrelated to what it was testing.
   *
   * The requests are unauthenticated on purpose. Controller-level guards run
   * before method-level ones in Nest, so `ThrottleGuard` charges the bucket
   * before `SessionGuard` rejects - which is the property that makes a rate
   * limit useful against an unauthenticated spray in the first place.
   */
  describe('the replay throttle actually refuses (runs last - it fills the bucket)', () => {
    it('starts returning 429 with Retry-After once the window budget is spent', async () => {
      let limited: HttpResult<unknown> | null = null;
      for (let i = 0; i < 60 && !limited; i += 1) {
        const res = await call('POST', `${eventPath(LEDGER.eventOrder)}/replay`, { body: {} });
        if (res.status === 429) limited = res;
        else expect(res.status).toBe(401);
      }

      expect(limited).not.toBeNull();
      expect(limited?.body.error?.code).toBe('rate_limited');
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    }, 20_000);
  });
});
