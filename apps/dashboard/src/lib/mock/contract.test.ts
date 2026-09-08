import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiKey,
  AuditLogEntry,
  CreatedApiKey,
  CreatedEndpoint,
  Delivery,
  DeliveryDetail,
  Endpoint,
  EndpointSecret,
  Member,
  OffsetPage,
  Organization,
  Project,
  RetryPolicy,
  Subscription,
} from '../../types/api';
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
