import { CROSS_TENANT_MESSAGE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import {
  SUBSCRIPTIONS_PATH,
  SUB_IDS,
  HttpHarness,
  startSubscriptionsApp,
} from './testing/harness';
import { SubscriptionDto, SubscriptionListDto } from './dto';

const BODY = { endpoint_id: IDS.endpointA1, event_types: ['payment.settled'] };

describe('subscriptions over HTTP - authentication and authorization', () => {
  let harness: HttpHarness;
  beforeAll(async () => {
    harness = await startSubscriptionsApp();
  });
  afterAll(() => harness.close());

  it('401s an anonymous caller on every route', async () => {
    for (const [method, path] of [
      ['GET', SUBSCRIPTIONS_PATH],
      ['POST', SUBSCRIPTIONS_PATH],
      ['GET', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.a1}`],
      ['PATCH', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.a1}`],
      ['POST', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.a1}/enable`],
      ['DELETE', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.a1}`],
    ] as const) {
      const response = await harness.call(method, path, { body: method === 'GET' ? undefined : {} });
      expect(response.status).toBe(401);
    }
  });

  /**
   * `subscriptions.read` is granted to viewer; `subscriptions.write` is not.
   * The permission matrix is the source of truth and this asserts the routes
   * are wired to the right half of it.
   */
  it('lets a viewer read but not write', async () => {
    const read = await harness.call('GET', SUBSCRIPTIONS_PATH, { as: IDS.viewerA });
    expect(read.status).toBe(200);

    const write = await harness.call('POST', SUBSCRIPTIONS_PATH, {
      as: IDS.viewerA,
      body: BODY,
    });
    expect(write.status).toBe(403);
  });

  it('lets a developer write - subscriptions are project configuration', async () => {
    const response = await harness.call<SubscriptionDto>('POST', SUBSCRIPTIONS_PATH, {
      as: IDS.developerA,
      body: { ...BODY, name: 'dev made this' },
    });
    expect(response.status).toBe(201);
    expect(response.body.event_types).toEqual(['payment.settled']);
  });

  it('404s a member of another organization, with the layer message', async () => {
    const response = await harness.call('GET', SUBSCRIPTIONS_PATH, { as: IDS.ownerB });
    expect(response.status).toBe(404);
    expect(response.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s another tenant subscription addressed through this project', async () => {
    const response = await harness.call('GET', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.b1}`, {
      as: IDS.ownerA,
    });
    expect(response.status).toBe(404);
    expect(response.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });
});

describe('subscriptions over HTTP - validation at the edge', () => {
  let harness: HttpHarness;
  beforeAll(async () => {
    harness = await startSubscriptionsApp();
  });
  afterAll(() => harness.close());

  it.each([
    ['an empty event_types', { ...BODY, event_types: [] }],
    ['an unsupported wildcard', { ...BODY, event_types: ['pay*'] }],
    ['a leading wildcard', { ...BODY, event_types: ['*.settled'] }],
    ['"*" mixed with a named type', { ...BODY, event_types: ['*', 'payment.settled'] }],
    ['a payload filter that matches everything', { ...BODY, payload_filter: {} }],
    ['an unknown filter operator', { ...BODY, payload_filter: { x: { $regex: 'a' } } }],
  ])('400s %s', async (_name, body) => {
    const response = await harness.call('POST', SUBSCRIPTIONS_PATH, { as: IDS.ownerA, body });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('invalid_request');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await harness.call('POST', SUBSCRIPTIONS_PATH, {
      as: IDS.ownerA,
      body: { ...BODY, project_id: IDS.projectB1 },
    });
    expect(response.status).toBe(400);
  });

  /**
   * `enabled` is deliberately absent from the PATCH DTO - enabling and
   * disabling have their own routes so pausing a route is a separately
   * auditable act. `forbidNonWhitelisted` turns that into a 400 rather than a
   * silently ignored field.
   */
  it('refuses `enabled` in a PATCH body', async () => {
    const response = await harness.call('PATCH', `${SUBSCRIPTIONS_PATH}/${SUB_IDS.a1}`, {
      as: IDS.ownerA,
      body: { enabled: false },
    });
    expect(response.status).toBe(400);
  });

  it('parses ?enabled=false as FALSE, not as Boolean("false")', async () => {
    // The BooleanQuery idiom. `@Type(() => Boolean)` would have made this true
    // and returned the opposite of what was asked for, with a 200.
    const response = await harness.call<SubscriptionListDto>(
      'GET',
      `${SUBSCRIPTIONS_PATH}?enabled=false`,
      { as: IDS.ownerA },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.map((row) => row.id)).toEqual([SUB_IDS.a2]);
  });

  it('400s a limit past the page ceiling instead of silently clamping', async () => {
    const response = await harness.call('GET', `${SUBSCRIPTIONS_PATH}?limit=5000`, {
      as: IDS.ownerA,
    });
    expect(response.status).toBe(400);
  });
});

describe('subscriptions over HTTP - the lifecycle', () => {
  let harness: HttpHarness;
  beforeAll(async () => {
    harness = await startSubscriptionsApp({ maxSubscriptions: 50 });
  });
  afterAll(() => harness.close());

  it('creates, fetches, updates, disables, enables and deletes', async () => {
    const created = await harness.call<SubscriptionDto>('POST', SUBSCRIPTIONS_PATH, {
      as: IDS.ownerA,
      body: { ...BODY, name: 'finance' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const fetched = await harness.call<SubscriptionDto>('GET', `${SUBSCRIPTIONS_PATH}/${id}`, {
      as: IDS.ownerA,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ name: 'finance', enabled: true });

    const updated = await harness.call<SubscriptionDto>('PATCH', `${SUBSCRIPTIONS_PATH}/${id}`, {
      as: IDS.ownerA,
      body: { event_types: ['payment.*'] },
    });
    expect(updated.body.event_types).toEqual(['payment.*']);

    const disabled = await harness.call<SubscriptionDto>(
      'POST',
      `${SUBSCRIPTIONS_PATH}/${id}/disable`,
      { as: IDS.ownerA, body: { reason: 'noisy' } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    // The filter survives the pause.
    expect(disabled.body.event_types).toEqual(['payment.*']);

    const enabled = await harness.call<SubscriptionDto>(
      'POST',
      `${SUBSCRIPTIONS_PATH}/${id}/enable`,
      { as: IDS.ownerA, body: {} },
    );
    expect(enabled.body.enabled).toBe(true);

    const removed = await harness.call('DELETE', `${SUBSCRIPTIONS_PATH}/${id}`, {
      as: IDS.ownerA,
    });
    expect(removed.status).toBe(204);

    const gone = await harness.call('GET', `${SUBSCRIPTIONS_PATH}/${id}`, { as: IDS.ownerA });
    expect(gone.status).toBe(404);
  });

  it('returns the pagination envelope, never a bare array', async () => {
    const response = await harness.call<SubscriptionListDto>('GET', SUBSCRIPTIONS_PATH, {
      as: IDS.ownerA,
    });
    expect(Array.isArray(response.body)).toBe(false);
    // Exactly three fields, every time: no `total`, no `count`, and
    // `next_offset` is null rather than absent or 0 on the last page.
    expect(Object.keys(response.body).sort()).toEqual(['data', 'has_more', 'next_offset']);
    expect(response.body).toMatchObject({ has_more: false, next_offset: null });
  });
});

describe('subscriptions over HTTP - the ceiling and the throttle', () => {
  it('409s a create at the project ceiling', async () => {
    const harness = await startSubscriptionsApp({ maxSubscriptions: 2 });
    try {
      const response = await harness.call<Record<string, never>>('POST', SUBSCRIPTIONS_PATH, {
        as: IDS.ownerA,
        body: BODY,
      });
      expect(response.status).toBe(409);
      // Still 409 - the request was well-formed and a slot can be freed - but a
      // distinct CODE, so the dashboard is not reduced to matching on prose.
      expect(response.body.error?.code).toBe('limit_exceeded');
      expect(response.body.error?.details).toMatchObject({
        limit: 2,
        current: 2,
        resource: 'subscriptions',
      });
    } finally {
      await harness.close();
    }
  });

  /**
   * The rate limit bounds how FAST a caller can get to the ceiling, which the
   * ceiling itself does not. A fresh `InMemoryThrottleStore` per app keeps the
   * tripped bucket from leaking into the other suites in this file.
   */
  it('429s once the create burst limit is exceeded, with Retry-After in the body', async () => {
    const harness = await startSubscriptionsApp({ maxSubscriptions: 10_000 });
    try {
      let limited: { status: number; body: { error?: { details?: Record<string, unknown> } } } | null =
        null;
      // SUBSCRIPTION_CREATE_THROTTLE is 30 per minute.
      for (let i = 0; i < 40; i += 1) {
        const response = await harness.call('POST', SUBSCRIPTIONS_PATH, {
          as: IDS.ownerA,
          body: { ...BODY, name: `burst ${i}` },
        });
        if (response.status === 429) {
          limited = response;
          break;
        }
        expect(response.status).toBe(201);
      }
      expect(limited).not.toBeNull();
      expect(limited?.body.error?.details).toHaveProperty('retry_after_seconds');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('does not throttle the read routes', async () => {
    const harness = await startSubscriptionsApp();
    try {
      for (let i = 0; i < 40; i += 1) {
        const response = await harness.call('GET', SUBSCRIPTIONS_PATH, { as: IDS.ownerA });
        expect(response.status).toBe(200);
      }
    } finally {
      await harness.close();
    }
  }, 30_000);
});
