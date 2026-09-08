import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiKey,
  CountedOffsetPage,
  CreatedApiKey,
  CreatedEndpoint,
  Endpoint,
  EndpointSecret,
  Member,
  OffsetPage,
  Organization,
  Project,
  TotalPage,
} from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The mock IS the contract until `generate:api` runs against a live OpenAPI
 * document, so these assertions are about SHAPE, not about behaviour the mock
 * invented. Each one mirrors a DTO class in apps/control-api.
 *
 * The three envelopes are deliberately kept apart. Collapsing them into one
 * optional-everything type is exactly how a missing `has_more` becomes
 * `undefined` and a truncated list renders as a complete one.
 */
const ORG = 'org_01JQSHAQ';
const PROJECT = 'proj_01JQPAYPROD';

// Writes persist in the mock now (PATCH, enable and disable mutate the
// fixtures in place, or an invalidated query would refetch the old row), so
// each test starts from the fixtures as loaded.
beforeEach(() => resetMockState());

describe('list envelopes', () => {
  it('projects return { data, count, has_more, next_offset } — ProjectListDto', async () => {
    const page = await mockRequest<CountedOffsetPage<Project>>(
      'GET',
      `/v1/organizations/${ORG}/projects?limit=2`,
    );

    expect(Array.isArray(page.data)).toBe(true);
    expect(page.count).toBe(page.data.length);
    expect(page).toHaveProperty('has_more');
    expect(page).toHaveProperty('next_offset');
  });

  it('api keys return the counted envelope too — ApiKeyListDto', async () => {
    const page = await mockRequest<CountedOffsetPage<ApiKey>>(
      'GET',
      `/v1/projects/${PROJECT}/api-keys`,
    );
    expect(page.count).toBe(page.data.length);
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

  it('organizations and members return { data, total, limit, offset } with NO has_more', async () => {
    const orgs = await mockRequest<TotalPage<Organization>>('GET', '/v1/organizations');
    expect(orgs).not.toHaveProperty('has_more');
    expect(orgs).not.toHaveProperty('next_offset');
    expect(orgs.total).toBe(orgs.data.length);
    expect(orgs.offset).toBe(0);

    const members = await mockRequest<TotalPage<Member>>(
      'GET',
      `/v1/organizations/${ORG}/members?limit=2`,
    );
    expect(members.data).toHaveLength(2);
    expect(members.total).toBeGreaterThan(2);
    expect(members.limit).toBe(2);
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

    const page = await mockRequest<CountedOffsetPage<ApiKey>>(
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
