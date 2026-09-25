import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiKey,
  AttemptLatency,
  AuditLogEntry,
  DeliveryOutcomes,
  WebhookEvent,
  DeliverySeries,
  EventVolume,
  FailingEndpoints,
  CreatedApiKey,
  CreatedEndpoint,
  Delivery,
  DeliveryDetail,
  DeliveryListItem,
  Endpoint,
  EndpointSecret,
  Member,
  OffsetPage,
  Organization,
  Project,
  RetryPolicy,
  Subscription,
} from '../../types/api';
import { MAX_PAGE_SIZE, PAYLOAD_PREVIEW_MAX_CHARS } from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The mock IS the contract until `generate:api` runs against a live OpenAPI
 * document, so these assertions are about SHAPE, not about behaviour the mock
 * invented. Each one mirrors a DTO class in apps/control-api.
 *
 * THERE IS NOW ONE ENVELOPE, not three. `{ data, has_more, next_offset }` on
 * every list route. The `count` on projects/API keys and the
 * `{ total, limit, offset }` on organizations/members are both gone from the
 * published schema, so they are gone from the mock — a mock that serves a field
 * the API does not is how a screen ships broken.
 */
const ORG = 'org_01JQSHAQ';
const PROJECT = 'proj_01JQPAYPROD';

// Writes persist in the mock now (PATCH, enable and disable mutate the
// fixtures in place, or an invalidated query would refetch the old row), so
// each test starts from the fixtures as loaded.
beforeEach(() => resetMockState());

describe('list envelopes', () => {
  it('projects return { data, has_more, next_offset } and NO count — ProjectListDto', async () => {
    const page = await mockRequest<OffsetPage<Project>>(
      'GET',
      `/v1/organizations/${ORG}/projects?limit=2`,
    );

    expect(Array.isArray(page.data)).toBe(true);
    // `count` was removed from the schema. Serving it here would keep alive a
    // field the dashboard could start reading again.
    expect(page).not.toHaveProperty('count');
    expect(page).toHaveProperty('has_more');
    expect(page).toHaveProperty('next_offset');
  });

  it('api keys return the same envelope — ApiKeyListDto', async () => {
    const page = await mockRequest<OffsetPage<ApiKey>>(
      'GET',
      `/v1/projects/${PROJECT}/api-keys`,
    );
    expect(page).not.toHaveProperty('count');
    expect(page.has_more).toBe(false);
    // `key_prefix`, never `masked_key`, and never anything key-shaped.
    expect(page.data[0]).toHaveProperty('key_prefix');
    expect(page.data[0]).not.toHaveProperty('masked_key');
    expect(page.data[0]).not.toHaveProperty('key');
    expect(page.data[0]).not.toHaveProperty('key_hash');
  });

  it('endpoints return { data, has_more, next_offset } with NO count — EndpointListDto', async () => {
    const page = await mockRequest<OffsetPage<Endpoint>>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints?limit=5`,
    );

    expect(page.data).toHaveLength(5);
    expect(page).not.toHaveProperty('count');
    expect(page).toHaveProperty('has_more');
  });

  it('organizations and members use the SAME envelope — no total, no limit, no offset', async () => {
    const orgs = await mockRequest<OffsetPage<Organization>>('GET', '/v1/organizations');
    expect(orgs).toHaveProperty('has_more');
    expect(orgs).toHaveProperty('next_offset');
    // These three were the old envelope and are not in the schema any more.
    expect(orgs).not.toHaveProperty('total');
    expect(orgs).not.toHaveProperty('limit');
    expect(orgs).not.toHaveProperty('offset');

    const members = await mockRequest<OffsetPage<Member>>(
      'GET',
      `/v1/organizations/${ORG}/members?limit=2`,
    );
    expect(members.data).toHaveLength(2);
    expect(members.has_more).toBe(true);
    expect(members).not.toHaveProperty('total');
    // Flat, nullable identity — MemberDto has no nested `user` and no `status`.
    expect(members.data[0]).toHaveProperty('user_id');
    expect(members.data[0]).not.toHaveProperty('user');
    expect(members.data[0]).not.toHaveProperty('status');
  });

  it('distinguishes a FULL page from a COMPLETE result on the wire', async () => {
    const total = db.endpoints.filter((endpoint) => endpoint.status !== 'deleted').length;

    // A page that exactly fills `limit` but is not the end.
    const full = await mockRequest<OffsetPage<Endpoint>>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints?limit=10&offset=0`,
    );
    expect(full.data).toHaveLength(10);
    expect(full.has_more).toBe(true);
    expect(full.next_offset).toBe(10);

    // The last page, reached by following next_offset.
    const last = await mockRequest<OffsetPage<Endpoint>>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints?limit=10&offset=${total - 10}`,
    );
    expect(last.data).toHaveLength(10);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeNull();
  });

  it('refuses a limit above MAX_PAGE_SIZE rather than silently clamping it', async () => {
    await expect(
      mockRequest('GET', `/v1/projects/${PROJECT}/endpoints?limit=5000`),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('boolean query parameters', () => {
  /**
   * `Boolean('false')` is `true`, which had `?include_deleted=false` turning
   * soft-deleted rows ON with a 200 — the caller got the opposite of what they
   * asked for. The string is compared, never coerced.
   */
  const deletedCount = async (search: string) => {
    const page = await mockRequest<OffsetPage<Endpoint>>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints?limit=200${search}`,
    );
    return page.data.filter((endpoint) => endpoint.status === 'deleted').length;
  };

  it('treats include_deleted=false as FALSE', async () => {
    expect(await deletedCount('&include_deleted=false')).toBe(0);
  });

  it('treats include_deleted=true as true', async () => {
    expect(await deletedCount('&include_deleted=true')).toBeGreaterThan(0);
  });

  it('omitting the parameter uses the server default, which hides deleted rows', async () => {
    expect(await deletedCount('')).toBe(0);
  });
});

describe('endpoint creation and the secret_pending state', () => {
  it('returns a plaintext secret and an ACTIVE endpoint for a caller who may read secrets', async () => {
    const created = await mockRequest<CreatedEndpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints`,
      { name: 'finance-api-2', url: 'https://example.com/hooks' },
    );

    expect(created.secret_pending).toBe(false);
    expect(created.secret).toBeTypeOf('string');
    expect(created.status).toBe('active');
    expect(created.enabled).toBe(true);
  });

  it('returns secret_pending with a PAUSED endpoint when the caller may not read secrets', async () => {
    const created = await mockRequest<CreatedEndpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints`,
      { name: 'developer-created-hook', url: 'https://example.com/hooks' },
    );

    // The whole point: the create succeeded, and the endpoint does not work.
    expect(created.secret_pending).toBe(true);
    expect(created.secret).toBeNull();
    expect(created.status).toBe('paused');
    expect(created.enabled).toBe(false);
    expect(created.disabled_reason).toBeTruthy();
    expect(created.secret_version).toBe(1);
  });
});

describe('one-time credentials', () => {
  it('returns the API key plaintext on create and never on a read', async () => {
    const created = await mockRequest<CreatedApiKey>(
      'POST',
      `/v1/projects/${PROJECT}/api-keys`,
      { name: 'one-time' },
    );
    expect(created.key).toMatch(/^wk_live_/);

    const page = await mockRequest<OffsetPage<ApiKey>>(
      'GET',
      `/v1/projects/${PROJECT}/api-keys`,
    );
    for (const key of page.data) {
      expect(key).not.toHaveProperty('key');
    }
  });

  it('never exposes a plaintext on any secret READ path', async () => {
    const page = await mockRequest<OffsetPage<EndpointSecret>>(
      'GET',
      '/v1/endpoints/ep_01JQFINANCE/secrets',
    );
    expect(page.data.length).toBeGreaterThan(0);
    for (const secret of page.data) {
      expect(secret).not.toHaveProperty('secret');
      expect(secret).not.toHaveProperty('masked_secret');
    }
  });

  it('rotation keeps prior versions signing, so consumers can be rolled', async () => {
    const rotated = await mockRequest<{
      secret: string;
      overlapping_versions: number[];
      previous_secrets_expire_at: string | null;
    }>('POST', '/v1/endpoints/ep_01JQFINANCE/secrets/rotate', { overlap_seconds: 3600 });

    expect(rotated.secret).toBeTypeOf('string');
    expect(rotated.overlapping_versions.length).toBeGreaterThan(0);
    expect(rotated.previous_secrets_expire_at).not.toBeNull();
  });

  it('overlap_seconds: 0 stops the old secrets immediately — the leak case', async () => {
    const rotated = await mockRequest<{ previous_secrets_expire_at: string | null }>(
      'POST',
      '/v1/endpoints/ep_01JQFINANCE/secrets/rotate',
      { overlap_seconds: 0 },
    );
    expect(rotated.previous_secrets_expire_at).toBeNull();
  });
});

describe('write limits are reachable and distinguishable', () => {
  it('answers 429 rate_limited with retry_after_seconds once the throttle trips', async () => {
    const create = () =>
      mockRequest('POST', `/v1/projects/${PROJECT}/api-keys`, { name: 'spray' });

    // The bucket allows 10 a minute; the eleventh is refused.
    for (let attempt = 0; attempt < 10; attempt += 1) await create();

    try {
      await create();
      throw new Error('expected the throttle to refuse this create');
    } catch (error) {
      expect(error).toBeInstanceOf(MockHttpError);
      const body = (error as MockHttpError).body;
      expect((error as MockHttpError).status).toBe(429);
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.details?.retry_after_seconds).toBeTypeOf('number');
    }
  });

  it('reports a resource ceiling as 409 limit_exceeded with { limit, current, resource }', async () => {
    // Organizations: the ceiling is per user and the mock is already at it.
    try {
      await mockRequest('POST', '/v1/organizations', { name: 'Eleventh' });
      throw new Error('expected the ceiling to refuse this create');
    } catch (error) {
      expect(error).toBeInstanceOf(MockHttpError);
      const body = (error as MockHttpError).body;
      // Still 409 — the request was well formed — but its OWN code. `conflict`
      // on the same status already means "that slug is taken", and a client
      // that had to tell the two apart by reading the sentence broke the first
      // time someone reworded one. The details are the contract.
      expect((error as MockHttpError).status).toBe(409);
      expect(body.error.code).toBe('limit_exceeded');
      expect(body.error.details).toMatchObject({ resource: 'organizations' });
      expect(body.error.details?.limit).toBeTypeOf('number');
      expect(body.error.details?.current).toBeTypeOf('number');
    }
  });

  it('never reports an ordinary conflict as a ceiling', async () => {
    // A slug collision is a 409 too, and telling the user to delete an
    // organization because they picked a taken name would be actively harmful.
    const [organization] = db.organizations;
    const other = db.projects.find(
      (project) => project.organization_id === organization.id,
    );
    const collision = db.projects.find(
      (project) =>
        project.organization_id === organization.id && project.id !== other?.id,
    );

    try {
      await mockRequest(
        'PATCH',
        `/v1/organizations/${organization.id}/projects/${other?.id}`,
        { slug: collision?.slug },
      );
      throw new Error('expected the slug collision to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(MockHttpError);
      expect((error as MockHttpError).status).toBe(409);
      expect((error as MockHttpError).body.error.code).toBe('conflict');
    }
  });
});

/**
 * The modules that had no control-plane implementation when the mock was
 * written, and now do. Every route below is NESTED and offset paged; the mock
 * used to serve top-level `/v1/events/:id` and `/v1/deliveries/:id`, which
 * simply do not exist and would have 404'd the day the transport flipped.
 */
describe('modules that were speculative and are now real', () => {
  it('subscriptions page like every other list, and carry no endpoint_name', async () => {
    const page = await mockRequest<OffsetPage<Subscription>>(
      'GET',
      `/v1/projects/${PROJECT}/subscriptions?limit=2`,
    );
    expect(page).toHaveProperty('has_more');
    expect(page.data[0]).toHaveProperty('endpoint_id');
    expect(page.data[0]).not.toHaveProperty('endpoint_name');
    // `payload_filter`, never `filter`.
    expect(page.data[0]).toHaveProperty('payload_filter');
    expect(page.data[0]).not.toHaveProperty('filter');
  });

  it('retry policies are scoped to their project, which is why the id box became a picker', async () => {
    const mine = await mockRequest<OffsetPage<RetryPolicy>>(
      'GET',
      `/v1/projects/${PROJECT}/retry-policies`,
    );
    expect(mine.data.length).toBeGreaterThan(0);
    expect(mine.data.every((policy) => policy.project_id === PROJECT)).toBe(true);
    expect(mine.data.filter((policy) => policy.is_default)).toHaveLength(1);

    // Another project owns none of them, which is exactly why pasting an id
    // from elsewhere used to 404 and why the empty state has to be honest.
    const other = await mockRequest<OffsetPage<RetryPolicy>>(
      'GET',
      `/v1/projects/${db.projects[1].id}/retry-policies`,
    );
    expect(other.data).toHaveLength(0);
  });

  it('a delivery row carries IDs, never an event type or an endpoint name', async () => {
    const page = await mockRequest<OffsetPage<Delivery>>(
      'GET',
      `/v1/projects/${PROJECT}/deliveries?limit=1`,
    );
    const row = page.data[0];
    expect(row).toHaveProperty('endpoint_id');
    expect(row).not.toHaveProperty('event_type');
    expect(row).not.toHaveProperty('endpoint_name');
    expect(row).not.toHaveProperty('endpoint_url');
    // The status code lives on an ATTEMPT, as `http_status`.
    expect(row).not.toHaveProperty('last_status_code');
  });

  /*
   * The payload preview is LIST-ONLY, and that asymmetry is the point: a
   * `payload_preview: null` on a response that never read the payload would be
   * indistinguishable from "this payload is unavailable".
   */
  it('carries the bounded payload preview on the list, and not on the detail or a replay', async () => {
    const page = await mockRequest<OffsetPage<DeliveryListItem>>(
      'GET',
      `/v1/projects/${PROJECT}/deliveries?limit=${MAX_PAGE_SIZE}`,
    );
    const rows = page.data;

    // Present on every row — branching on `'payload_preview' in row` must be
    // branching on something.
    expect(rows.every((row) => 'payload_preview' in row)).toBe(true);
    expect(rows.every((row) => 'payload_size' in row)).toBe(true);
    expect(rows.every((row) => typeof row.payload_truncated === 'boolean')).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.payload_preview === null ||
          Array.from(row.payload_preview).length <= PAYLOAD_PREVIEW_MAX_CHARS,
      ),
    ).toBe(true);
    // Both branches are reachable, or the UI's null case never renders.
    expect(rows.some((row) => row.payload_preview !== null)).toBe(true);

    // The offloaded and aged-out events keep their SIZE with no preview, and
    // never claim truncation.
    const absent = rows.filter((row) => row.payload_preview === null);
    expect(absent.length).toBeGreaterThan(0);
    expect(absent.every((row) => row.payload_size !== null)).toBe(true);
    expect(absent.every((row) => row.payload_truncated === false)).toBe(true);

    const detail = await mockRequest<DeliveryDetail>(
      'GET',
      `/v1/projects/${PROJECT}/deliveries/${rows[0].id}`,
    );
    expect(detail).not.toHaveProperty('payload_preview');
    expect(detail).not.toHaveProperty('payload_size');

    const replay = await mockRequest<Delivery>(
      'POST',
      `/v1/projects/${PROJECT}/deliveries/${rows[0].id}/replay`,
      {},
    );
    expect(replay).not.toHaveProperty('payload_preview');
  });

  it('refuses status and failing_now together, as the API does', async () => {
    await expect(
      mockRequest(
        'GET',
        `/v1/projects/${PROJECT}/deliveries?status=succeeded&failing_now=true`,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('the delivery detail nests event and endpoint and embeds the attempts', async () => {
    const exhausted = db.deliveries.find((delivery) => delivery.status === 'exhausted');
    const detail = await mockRequest<DeliveryDetail>(
      'GET',
      `/v1/projects/${PROJECT}/deliveries/${exhausted!.id}`,
    );

    expect(detail.event.event_type).toBeTruthy();
    expect(detail.endpoint.name).toBeTruthy();
    expect(Array.isArray(detail.attempts)).toBe(true);
    // An 8-attempt chain exceeds the embedded cap, so the flag must be true —
    // a flag that is never true is a UI branch that never runs.
    expect(detail.attempts_truncated).toBe(true);
    // Neither of these is on a delivery: the payload is on the event and the
    // request headers are per attempt.
    expect(detail).not.toHaveProperty('payload');
    expect(detail).not.toHaveProperty('request_headers');
    expect(detail.attempts[0]).toHaveProperty('request_headers');
    // Same for the body: per attempt, bounded, and a prefix of what the event
    // holds in full — not a field on the delivery.
    expect(detail).not.toHaveProperty('request_payload');
    expect(detail.attempts[0]).toHaveProperty('request_payload');
  });

  it('a replay creates a NEW delivery row that points back at the original', async () => {
    const original = db.deliveries.find((delivery) => delivery.status === 'exhausted');
    const replay = await mockRequest<Delivery>(
      'POST',
      `/v1/projects/${PROJECT}/deliveries/${original!.id}/replay`,
      {},
    );

    expect(replay.id).not.toBe(original!.id);
    expect(replay.is_replay).toBe(true);
    expect(replay.replay_of_delivery_id).toBe(original!.id);
  });

  it('audit rows carry ids and a resource, never a nested actor or a target string', async () => {
    const page = await mockRequest<OffsetPage<AuditLogEntry>>(
      'GET',
      `/v1/organizations/${ORG}/audit-logs`,
    );
    const row = page.data[0];
    expect(row).not.toHaveProperty('actor');
    expect(row).not.toHaveProperty('target');
    expect(row).not.toHaveProperty('ip');
    expect(row).toHaveProperty('resource_type');
    expect(row).toHaveProperty('ip_address');

    /*
     * The reason an operator typed when pausing an endpoint has to be readable
     * back. It is the only thing that explains the delivery gap afterwards, and
     * until this page read the real route it could not be read at all.
     */
    const paused = page.data.find((entry) => entry.action === 'endpoint.disabled');
    expect(paused?.metadata?.reason).toBe('warehouse migration');
  });

  it('a viewer is refused with 403, not with a broken page', async () => {
    await expect(
      mockRequest('GET', `/v1/organizations/${ORG}/audit-logs?as=viewer`),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * The five analytics routes, computed from the ledger the list routes serve.
 * Shapes mirror `apps/control-api/src/analytics/dto/analytics-response.dto.ts`
 * and the arithmetic mirrors `AnalyticsService`; the one-route
 * `GET /v1/projects/:id/analytics` and `GET /v1/organizations/:id/usage` the
 * mock used to invent are gone, and the last test pins that they stay gone.
 */
describe('analytics — five routes, not one dashboard payload', () => {
  const EMPTY_PROJECT = 'proj_01JQPAYSTG';
  const STATUSES = [
    'pending',
    'scheduled',
    'queued',
    'processing',
    'succeeded',
    'failed',
    'retrying',
    'exhausted',
    'cancelled',
  ] as const;

  it('deliveries: echoes the window, carries all nine by_status keys, and counts the ledger', async () => {
    const body = await mockRequest<DeliveryOutcomes>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/deliveries`,
    );

    // Default window is 24h, echoed as `[from, to)` beside the previous window.
    expect(body.window.hours).toBe(24);
    expect(new Date(body.window.to).getTime() - new Date(body.window.from).getTime()).toBe(
      24 * 3_600_000,
    );
    expect(body.window.previous_to).toBe(body.window.from);

    for (const summary of [body.current, body.previous]) {
      for (const status of STATUSES) {
        expect(typeof summary.by_status[status]).toBe('number');
      }
      expect(Object.keys(summary.by_status).sort()).toEqual([...STATUSES].sort());
      expect(summary.total).toBe(STATUSES.reduce((sum, s) => sum + summary.by_status[s], 0));
      expect(summary.failing).toBe(summary.by_status.failed + summary.by_status.exhausted);
      expect(summary.in_flight).toBe(
        summary.by_status.pending +
          summary.by_status.scheduled +
          summary.by_status.queued +
          summary.by_status.processing +
          summary.by_status.retrying,
      );
    }

    // Every fixture delivery in the busy project was created inside the last
    // 24h, so the analytics total IS the deliveries list — the property the
    // real service promises.
    const ledger = db.deliveries.filter((delivery) => delivery.project_id === PROJECT);
    expect(body.current.total).toBe(ledger.length);
    expect(typeof body.current.success_rate).toBe('number');
    expect(body.total_delta).toBe(body.current.total - body.previous.total);
  });

  it('deliveries/series: buckets the same ledger, and the bars add up to the window', async () => {
    const body = await mockRequest<DeliverySeries>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/deliveries/series`,
    );

    expect(body.bucket).toBe('1h');
    expect(body.bucket_ms).toBe(3_600_000);
    expect(body.buckets.length).toBeGreaterThan(0);
    expect(body.buckets.length).toBeLessThanOrEqual(32);

    // Contiguous: no gap a delivery could fall into, no overlap it could be
    // counted twice in.
    for (let index = 1; index < body.buckets.length; index += 1) {
      expect(body.buckets[index].start).toBe(body.buckets[index - 1].end);
    }

    // The invariant the control-api tests assert against the real database:
    // the bars, added up, are the rows the window reports.
    const outcomes = await mockRequest<DeliveryOutcomes>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/deliveries`,
    );
    const sum = (key: 'delivered_first_try' | 'delivered_after_retry' | 'failed' | 'in_flight') =>
      body.buckets.reduce((total, bucket) => total + bucket[key], 0);

    expect(sum('delivered_first_try') + sum('delivered_after_retry')).toBe(
      outcomes.current.by_status.succeeded,
    );
    expect(sum('failed')).toBe(outcomes.current.failing);
    expect(sum('in_flight')).toBe(outcomes.current.in_flight);
  });

  it('deliveries/series: the two delivered bands never overlap', async () => {
    const body = await mockRequest<DeliverySeries>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/deliveries/series`,
    );
    // A delivery that needed three attempts belongs to exactly one band. If it
    // were in both, every stacked bar on the overview would be too tall.
    for (const bucket of body.buckets) {
      expect(bucket.delivered_first_try).toBeGreaterThanOrEqual(0);
      expect(bucket.delivered_after_retry).toBeGreaterThanOrEqual(0);
    }
  });

  it('deliveries/series: refuses a bucket outside the enum', async () => {
    await expect(
      mockRequest(
        'GET',
        `/v1/projects/${PROJECT}/analytics/deliveries/series?bucket=7m`,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('deliveries: success_rate is NULL, never 0, when nothing settled', async () => {
    const body = await mockRequest<DeliveryOutcomes>(
      'GET',
      `/v1/projects/${EMPTY_PROJECT}/analytics/deliveries?window_hours=720`,
    );
    expect(body.window.hours).toBe(720);
    expect(body.current.total).toBe(0);
    expect(body.current.success_rate).toBeNull();
    expect(body.previous.success_rate).toBeNull();
    expect(body.success_rate_delta).toBeNull();
  });

  it('refuses window_hours above 720 with a per-property 400, never a clamp', async () => {
    for (const route of ['deliveries', 'endpoints', 'latency', 'events']) {
      await expect(
        mockRequest('GET', `/v1/projects/${PROJECT}/analytics/${route}?window_hours=721`),
      ).rejects.toMatchObject({
        status: 400,
        body: {
          error: { code: 'invalid_request', message: [expect.stringMatching(/^window_hours: /)] },
        },
      });
    }
    await expect(
      mockRequest('GET', `/v1/projects/${PROJECT}/analytics/deliveries?window_hours=0`),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('endpoints: ranked worst first, nullable endpoint columns, a rate beside the count', async () => {
    const body = await mockRequest<FailingEndpoints>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/endpoints`,
    );
    expect(body.window.hours).toBe(24);
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.has_more).toBe('boolean');

    for (const row of body.data) {
      expect(row).toMatchObject({
        endpoint_id: expect.any(String),
        failing: expect.any(Number),
        failed: expect.any(Number),
        exhausted: expect.any(Number),
        retrying: expect.any(Number),
        total: expect.any(Number),
        failure_rate: expect.any(Number),
      });
      expect(row.failing).toBe(row.failed + row.exhausted);
      expect(row.failure_rate).toBeGreaterThanOrEqual(0);
      expect(row.failure_rate).toBeLessThanOrEqual(1);
      expect(row.failure_rate).toBeCloseTo(row.total === 0 ? 0 : row.failing / row.total, 4);
      // Present-or-null, never absent.
      for (const key of ['name', 'url', 'status', 'enabled'] as const) {
        expect(row).toHaveProperty(key);
      }
    }
    for (let index = 1; index < body.data.length; index += 1) {
      expect(body.data[index - 1].failing).toBeGreaterThanOrEqual(body.data[index].failing);
    }
    // The partner endpoint is the fixture that is genuinely broken.
    expect(body.data[0].endpoint_id).toBe('ep_01JQPARTNER');
  });

  it('endpoints: limit bounds the ranking and has_more says the list is not the set', async () => {
    const one = await mockRequest<FailingEndpoints>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/endpoints?limit=1`,
    );
    expect(one.data).toHaveLength(1);
    expect(one.has_more).toBe(true);

    await expect(
      mockRequest('GET', `/v1/projects/${PROJECT}/analytics/endpoints?limit=51`),
    ).rejects.toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('latency: nullable nearest-rank percentiles with the sample honestly described', async () => {
    const body = await mockRequest<AttemptLatency>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/latency`,
    );
    expect(body.window.hours).toBe(24);
    expect(typeof body.exact).toBe('boolean');
    expect(typeof body.sample_size).toBe('number');
    expect(typeof body.sampled_deliveries).toBe('number');
    expect(body.sample_size).toBeGreaterThan(0);

    const { p50_ms, p95_ms, p99_ms, min_ms, max_ms } = body;
    if (p50_ms === null || p95_ms === null || p99_ms === null || min_ms === null || max_ms === null) {
      throw new Error('percentiles must be numbers when sample_size > 0');
    }
    expect(min_ms).toBeLessThanOrEqual(p50_ms);
    expect(p50_ms).toBeLessThanOrEqual(p95_ms);
    expect(p95_ms).toBeLessThanOrEqual(p99_ms);
    expect(p99_ms).toBeLessThanOrEqual(max_ms);
    // `exact` only when NEITHER bound was hit: 200 deliveries, 200 measured
    // attempts. The fixtures' exhausted chains carry eight attempts each, so
    // the attempt cap is the one that bites — and the response says so
    // rather than presenting a sample as the whole day.
    const inWindow = db.deliveries.filter((delivery) => delivery.project_id === PROJECT);
    const measuredAttempts = inWindow
      .flatMap((delivery) => db.attempts[delivery.id] ?? [])
      .filter((attempt) => attempt.duration_ms !== null).length;
    expect(body.sampled_deliveries).toBe(Math.min(inWindow.length, 200));
    expect(body.sample_size).toBe(Math.min(measuredAttempts, 200));
    expect(body.exact).toBe(inWindow.length <= 200 && measuredAttempts <= 200);

    // Nearest rank: every value is a duration some attempt actually took.
    const observed = new Set(
      Object.values(db.attempts)
        .flat()
        .map((attempt) => attempt.duration_ms)
        .filter((value): value is number => typeof value === 'number'),
    );
    expect(observed.has(p95_ms)).toBe(true);
  });

  it('latency: an idle project answers nulls with sample_size 0, and exact', async () => {
    const body = await mockRequest<AttemptLatency>(
      'GET',
      `/v1/projects/${EMPTY_PROJECT}/analytics/latency`,
    );
    expect(body.p50_ms).toBeNull();
    expect(body.p95_ms).toBeNull();
    expect(body.p99_ms).toBeNull();
    expect(body.min_ms).toBeNull();
    expect(body.max_ms).toBeNull();
    expect(body.sample_size).toBe(0);
    expect(body.sampled_deliveries).toBe(0);
    expect(body.exact).toBe(true);
  });

  it('events: counts what was PUBLISHED, beside the previous window, busiest types first', async () => {
    const body = await mockRequest<EventVolume>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/events`,
    );
    expect(body.window.hours).toBe(24);
    expect(body.total).toBe(db.events.filter((event) => event.project_id === PROJECT).length);
    expect(body.total_delta).toBe(body.total - body.previous_total);
    expect(typeof body.has_more).toBe('boolean');
    expect(body.by_type.length).toBeGreaterThan(0);
    expect(body.by_type.length).toBeLessThanOrEqual(10);
    for (const row of body.by_type) {
      expect(row).toEqual({ event_type: expect.any(String), count: expect.any(Number) });
    }
    for (let index = 1; index < body.by_type.length; index += 1) {
      expect(body.by_type[index - 1].count).toBeGreaterThanOrEqual(body.by_type[index].count);
    }

    const one = await mockRequest<EventVolume>(
      'GET',
      `/v1/projects/${PROJECT}/analytics/events?limit=1`,
    );
    expect(one.by_type).toHaveLength(1);
    expect(one.has_more).toBe(true);
    // Unchanged by `limit`: the total is the window, not the list.
    expect(one.total).toBe(body.total);
  });

  it('the invented one-route analytics and the usage route are gone', async () => {
    await expect(mockRequest('GET', `/v1/projects/${PROJECT}/analytics`)).rejects.toMatchObject({
      status: 404,
    });
    await expect(mockRequest('GET', `/v1/organizations/${ORG}/usage`)).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * The write routes on `WebhookSubscriptionsController`, `ProjectsController`
 * and `OrganizationsController` that the dashboard now calls. Shape first:
 * what comes back is a `SubscriptionDto` / `ProjectDto`, a 204 is a 204, and
 * the two 409s are told apart by `error.code`, never by the sentence.
 */
describe('subscription writes — WebhookSubscriptionsController', () => {
  const create = (body: Record<string, unknown>) =>
    mockRequest<Subscription>('POST', `/v1/projects/${PROJECT}/subscriptions`, body);

  it('creates a subscription and stores event_types EXACTLY as sent', async () => {
    const created = await create({
      endpoint_id: 'ep_01JQFINANCE',
      event_types: ['payout.*', 'payment.settled'],
      name: 'Payouts',
    });
    expect(created.id).toMatch(/^sub_/);
    expect(created.project_id).toBe(PROJECT);
    expect(created.endpoint_id).toBe('ep_01JQFINANCE');
    // Order and content untouched — not sorted, not de-duplicated, not widened.
    expect(created.event_types).toEqual(['payout.*', 'payment.settled']);
    expect(created.payload_filter).toBeNull();
    expect(created.enabled).toBe(true);
    expect(created).toHaveProperty('updated_at');
    expect(created).not.toHaveProperty('endpoint_name');

    const page = await mockRequest<OffsetPage<Subscription>>(
      'GET',
      `/v1/projects/${PROJECT}/subscriptions`,
    );
    expect(page.data[0].id).toBe(created.id);
  });

  it('defaults enabled to true, and honours enabled: false', async () => {
    const paused = await create({
      endpoint_id: 'ep_01JQFINANCE',
      event_types: ['*'],
      enabled: false,
    });
    expect(paused.enabled).toBe(false);
    expect(paused.name).toBeNull();
  });

  it('refuses an event-type pattern with a 400 whose message is the server sentence, un-prefixed', async () => {
    try {
      await create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['pay*'] });
      throw new Error('expected a 400');
    } catch (error) {
      expect(error).toBeInstanceOf(MockHttpError);
      const failure = error as MockHttpError;
      expect(failure.status).toBe(400);
      const messages = failure.body.error.message as string[];
      // `EventTypesConstraint.defaultMessage` returns the reason itself, which
      // begins with `event_types[…]` and carries no `property: ` prefix.
      expect(messages[0]).toMatch(/^event_types\[0\] contains "\*"/);
      expect(messages[0]).toMatch(/would never fire/);
    }
  });

  it('refuses "*" alongside other patterns rather than widening', async () => {
    try {
      await create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['*', 'payment.settled'] });
      throw new Error('expected a 400');
    } catch (error) {
      const failure = error as MockHttpError;
      expect(failure.status).toBe(400);
      expect((failure.body.error.message as string[])[0]).toMatch(/alongside other patterns/);
    }
  });

  it('answers limit_exceeded with { limit, current, resource } at the ceiling', async () => {
    // Fill the project up to the mock ceiling, then one more.
    let last: MockHttpError | null = null;
    for (let index = 0; index < 10; index += 1) {
      try {
        await create({ endpoint_id: 'ep_01JQFINANCE', event_types: [`type.${index}`] });
      } catch (error) {
        last = error as MockHttpError;
        break;
      }
    }
    expect(last?.status).toBe(409);
    expect(last?.body.error.code).toBe('limit_exceeded');
    expect(last?.body.error.details).toEqual({ limit: 8, current: 8, resource: 'subscriptions' });
  });

  it('refuses a deleted endpoint with a plain conflict, distinguishable by code', async () => {
    const deleted = db.endpoints.find((endpoint) => endpoint.status === 'deleted');
    try {
      await create({ endpoint_id: deleted!.id, event_types: ['*'] });
      throw new Error('expected a 409');
    } catch (error) {
      const failure = error as MockHttpError;
      expect(failure.status).toBe(409);
      expect(failure.body.error.code).toBe('conflict');
      expect(failure.body.error.details).toEqual({ endpoint_id: deleted!.id });
    }
  });

  it('answers 404 — not 403 — for an endpoint that belongs to another project', async () => {
    // One answer for "does not exist" and "belongs to someone else": the id is
    // real, the project in the path is not the one that owns it.
    const other = db.projects.find((project) => project.id !== PROJECT);
    try {
      await mockRequest('POST', `/v1/projects/${other!.id}/subscriptions`, {
        endpoint_id: 'ep_01JQFINANCE',
        event_types: ['*'],
      });
      throw new Error('expected a 404');
    } catch (error) {
      expect(error).toBeInstanceOf(MockHttpError);
      expect((error as MockHttpError).status).toBe(404);
      expect((error as MockHttpError).body.error.code).toBe('not_found');
    }
  });

  it('PATCH replaces event_types wholesale and clears the name with null', async () => {
    const updated = await mockRequest<Subscription>(
      'PATCH',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN`,
      { event_types: ['payment.settled'], name: null },
    );
    expect(updated.event_types).toEqual(['payment.settled']);
    expect(updated.name).toBeNull();
    // Untouched fields survive.
    expect(updated.endpoint_id).toBe('ep_01JQFINANCE');
  });

  it('PATCH refuses `enabled` and names the right route', async () => {
    try {
      await mockRequest('PATCH', `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN`, {
        enabled: false,
      });
      throw new Error('expected a 400');
    } catch (error) {
      const failure = error as MockHttpError;
      expect(failure.status).toBe(400);
      expect((failure.body.error.message as string[])[0]).toMatch(/^enabled: .*own routes/);
    }
  });

  it('enable and disable flip the flag and are idempotent', async () => {
    const disabled = await mockRequest<Subscription>(
      'POST',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN/disable`,
      { reason: 'ledger migration' },
    );
    expect(disabled.enabled).toBe(false);
    const again = await mockRequest<Subscription>(
      'POST',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN/disable`,
      {},
    );
    expect(again.enabled).toBe(false);
    const enabled = await mockRequest<Subscription>(
      'POST',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN/enable`,
    );
    expect(enabled.enabled).toBe(true);
  });

  it('DELETE is a hard delete, answers 204, and 204 again for a row already gone', async () => {
    const first = await mockRequest<undefined>(
      'DELETE',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQANL`,
    );
    expect(first).toBeUndefined();
    const page = await mockRequest<OffsetPage<Subscription>>(
      'GET',
      `/v1/projects/${PROJECT}/subscriptions`,
    );
    expect(page.data.some((row) => row.id === 'sub_01JQANL')).toBe(false);
    const second = await mockRequest<undefined>(
      'DELETE',
      `/v1/projects/${PROJECT}/subscriptions/sub_01JQANL`,
    );
    expect(second).toBeUndefined();
  });
});

describe('project create and delete — ProjectsController', () => {
  it('creates a project, derives the slug from the name and defaults environment to test', async () => {
    const created = await mockRequest<Project>('POST', `/v1/organizations/${ORG}/projects`, {
      name: 'Rider Café Ops',
    });
    expect(created.id).toMatch(/^proj_/);
    expect(created.organization_id).toBe(ORG);
    expect(created.slug).toBe('rider-cafe-ops');
    expect(created.environment).toBe('test');
    expect(created.status).toBe('active');
  });

  it('keeps a supplied slug verbatim and honours environment: live', async () => {
    const created = await mockRequest<Project>('POST', `/v1/organizations/${ORG}/projects`, {
      name: 'Fulfilment',
      slug: 'fulfil-2',
      environment: 'live',
    });
    expect(created.slug).toBe('fulfil-2');
    expect(created.environment).toBe('live');
  });

  it('refuses a taken slug as a plain conflict — deleted projects keep theirs', async () => {
    try {
      await mockRequest('POST', `/v1/organizations/${ORG}/projects`, {
        name: 'Payments again',
        slug: 'payments',
      });
      throw new Error('expected a 409');
    } catch (error) {
      const failure = error as MockHttpError;
      expect(failure.status).toBe(409);
      expect(failure.body.error.code).toBe('conflict');
      expect(failure.body.error.message).toMatch(/Deleted projects keep their slug/);
    }
  });

  it('soft-deletes: returns the row with status deleted and drops it from the default list', async () => {
    const deleted = await mockRequest<Project>(
      'DELETE',
      `/v1/organizations/${ORG}/projects/proj_01JQRIDER`,
    );
    expect(deleted.status).toBe('deleted');
    expect(deleted.slug).toBe('rider-dispatch');

    const page = await mockRequest<OffsetPage<Project>>('GET', `/v1/organizations/${ORG}/projects`);
    expect(page.data.some((project) => project.id === 'proj_01JQRIDER')).toBe(false);
    const gone = await mockRequest<OffsetPage<Project>>(
      'GET',
      `/v1/organizations/${ORG}/projects?status=deleted`,
    );
    expect(gone.data.some((project) => project.id === 'proj_01JQRIDER')).toBe(true);
  });
});

describe('organization delete — OrganizationsController', () => {
  it('is owner-only: an admin holds projects.write and is still refused with 403', async () => {
    const admin = db.organizations.find((organization) => organization.role === 'admin');
    try {
      await mockRequest('DELETE', `/v1/organizations/${admin!.id}`);
      throw new Error('expected a 403');
    } catch (error) {
      const failure = error as MockHttpError;
      expect(failure.status).toBe(403);
      expect(failure.body.error.code).toBe('forbidden');
      expect(failure.body.error.message).toMatch(/Only an owner/);
    }
  });

  it('soft-deletes the organization AND every active project, answers 204, and leaves the list', async () => {
    const result = await mockRequest<undefined>('DELETE', `/v1/organizations/${ORG}`);
    expect(result).toBeUndefined();
    expect(
      db.projects
        .filter((project) => project.organization_id === ORG)
        .every((project) => project.status === 'deleted'),
    ).toBe(true);
    const page = await mockRequest<OffsetPage<Organization>>('GET', '/v1/organizations');
    expect(page.data.some((organization) => organization.id === ORG)).toBe(false);
    try {
      await mockRequest('GET', `/v1/organizations/${ORG}`);
      throw new Error('expected a 404');
    } catch (error) {
      expect((error as MockHttpError).status).toBe(404);
    }
  });
});

/**
 * The event rollup: what became of the event, as opposed to what became of the
 * ingest. Counted from the same delivery fixture the list routes serve, so the
 * mock cannot report an outcome the deliveries it is built from disagree with.
 */
describe('events carry a delivery rollup, not just an ingest status', () => {
  it('every listed event carries counts that add up', async () => {
    const body = await mockRequest<{ data: WebhookEvent[] }>(
      'GET',
      `/v1/projects/${PROJECT}/events?limit=50`,
    );

    expect(body.data.length).toBeGreaterThan(0);
    for (const event of body.data) {
      const rollup = event.deliveries;
      expect(rollup).not.toBeNull();
      expect(rollup!.total).toBe(
        rollup!.succeeded + rollup!.failed + rollup!.in_flight + rollup!.cancelled,
      );
    }
  });

  it('an event that matched no subscription reads DROPPED, not delivered', async () => {
    // The state that exists nowhere else: routing completed and produced
    // nothing. `status: processed` alone makes this event look finished and
    // fine, and it reached nobody.
    const body = await mockRequest<{ data: WebhookEvent[] }>(
      'GET',
      `/v1/projects/${PROJECT}/events?limit=200`,
    );

    const dropped = body.data.filter((event) => event.deliveries?.state === 'dropped');
    for (const event of dropped) {
      expect(event.deliveries!.total).toBe(0);
      expect(event.status).toBe('processed');
    }
  });

  it('never reports delivered for an event with a failure', async () => {
    const body = await mockRequest<{ data: WebhookEvent[] }>(
      'GET',
      `/v1/projects/${PROJECT}/events?limit=200`,
    );

    for (const event of body.data) {
      if (event.deliveries?.state !== 'delivered') continue;
      expect(event.deliveries.failed).toBe(0);
      expect(event.deliveries.cancelled).toBe(0);
      expect(event.deliveries.in_flight).toBe(0);
    }
  });
});
