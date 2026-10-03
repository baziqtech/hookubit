import { beforeEach, describe, expect, it } from 'vitest';
import type { Endpoint, OffsetPage, RateLimit, RetryPolicy } from '../../types/api';
import { MAX_RETRY_POLICIES_PER_PROJECT } from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The retry-policy and rate-limit routes, refusal for refusal against
 * `RetryPoliciesService` and `RateLimitsService`. The mock IS the contract the
 * Policies page is built against, and every branch below is one the page
 * renders differently: a bounds 400 goes under an input, a coherence 400
 * carries `details.field`, a 409 is a conflict panel, a ceiling is
 * `limit_exceeded` with numbers.
 */
const ORG = 'org_01JQSHAQ';
const PROJECT = 'proj_01JQPAYPROD';
/** Same organization, no policies of its own. */
const SIBLING = 'proj_01JQPAYSTG';
/** Another organization entirely. */
const OTHER_ORG_PROJECT = 'proj_01JQKWIKMAIN';
const DEFAULT_POLICY = 'rp_01JQDEFAULT';
/** Referenced by the live endpoint `ep_01JQANALYTICS`. */
const IN_USE = 'rp_01JQTIGHT';
const UNUSED = 'rp_01JQPATIENT';

beforeEach(() => resetMockState());

async function failure(request: Promise<unknown>): Promise<MockHttpError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof MockHttpError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

const listRetry = (project = PROJECT, search = '') =>
  mockRequest<OffsetPage<RetryPolicy>>('GET', `/v1/projects/${project}/retry-policies${search}`);
const createRetry = (body: Record<string, unknown>, project = PROJECT) =>
  mockRequest<RetryPolicy>('POST', `/v1/projects/${project}/retry-policies`, body);
const patchRetry = (id: string, body: Record<string, unknown>) =>
  mockRequest<RetryPolicy>('PATCH', `/v1/projects/${PROJECT}/retry-policies/${id}`, body);
const deleteRetry = (id: string, search = '') =>
  mockRequest<void>('DELETE', `/v1/projects/${PROJECT}/retry-policies/${id}${search}`);

describe('retry policies — reads', () => {
  it('lists the one offset envelope, scoped to the project', async () => {
    const page = await listRetry();
    expect(page).toHaveProperty('has_more');
    expect(page).toHaveProperty('next_offset');
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((policy) => policy.project_id === PROJECT)).toBe(true);

    const sibling = await listRetry(SIBLING);
    expect(sibling.data).toEqual([]);
  });

  it('has exactly one default, and ?is_default=true finds it', async () => {
    const page = await listRetry(PROJECT, '?is_default=true');
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(DEFAULT_POLICY);
  });

  it('serves one policy under the project and answers the shared 404 across tenants', async () => {
    const policy = await mockRequest<RetryPolicy>(
      'GET',
      `/v1/projects/${PROJECT}/retry-policies/${DEFAULT_POLICY}`,
    );
    expect(policy.id).toBe(DEFAULT_POLICY);

    const error = await failure(
      mockRequest('GET', `/v1/projects/${OTHER_ORG_PROJECT}/retry-policies/${DEFAULT_POLICY}`),
    );
    expect(error.status).toBe(404);
    expect(error.body.error.message).toBe('Resource not found.');
  });
});

describe('retry policies — create', () => {
  it('creates with the server defaults and does NOT promote when a default exists', async () => {
    const created = await createRetry({ name: 'Gentle' });
    expect(created.strategy).toBe('exponential');
    expect(created.max_attempts).toBe(8);
    expect(created.initial_delay_ms).toBe(5_000);
    expect(created.is_default).toBe(false);

    const page = await listRetry();
    expect(page.data.filter((policy) => policy.is_default)).toHaveLength(1);
  });

  it('promotes the FIRST policy in a project whether or not it asked', async () => {
    const created = await createRetry({ name: 'Only one', is_default: false }, SIBLING);
    expect(created.is_default).toBe(true);
  });

  it('is_default: true clears the previous default in the same write', async () => {
    const created = await createRetry({ name: 'New default', is_default: true });
    expect(created.is_default).toBe(true);
    const page = await listRetry();
    const defaults = page.data.filter((policy) => policy.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(created.id);
  });

  it('refuses out-of-range fields as a ValidationPipe ARRAY naming each property', async () => {
    const error = await failure(
      createRetry({ name: 'Bad', max_delay_ms: 0, max_attempts: 51, strategy: 'random' }),
    );
    expect(error.status).toBe(400);
    const messages = error.body.error.message as string[];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toContain('max_delay_ms: must not be less than 1');
    expect(messages).toContain('max_attempts: must not be greater than 50');
    expect(messages.some((message) => message.startsWith('strategy: '))).toBe(true);
  });

  it('refuses a name outside 1..200', async () => {
    const error = await failure(createRetry({ name: '' }));
    expect((error.body.error.message as string[])[0]).toContain('name: ');
  });

  /**
   * The three cross-field rules, raised the way the SERVICE raises them: one
   * sentence, with the field in `details` — not the pipe's array. The form
   * reads `details.field` to place it.
   */
  it('refuses initial_delay_ms above max_delay_ms, naming initial_delay_ms in details', async () => {
    const error = await failure(
      createRetry({ name: 'Clamped', initial_delay_ms: 10_000, max_delay_ms: 5_000 }),
    );
    expect(error.status).toBe(400);
    expect(error.body.error.code).toBe('invalid_request');
    expect(typeof error.body.error.message).toBe('string');
    expect(error.body.error.details).toMatchObject({ field: 'initial_delay_ms' });
  });

  it('refuses a retry budget shorter than the first delay, naming max_retry_duration_ms', async () => {
    const error = await failure(
      createRetry({ name: 'Expires', initial_delay_ms: 5_000, max_retry_duration_ms: 1_000 }),
    );
    expect(error.body.error.details).toMatchObject({ field: 'max_retry_duration_ms' });
  });

  it('refuses multiplier <= 1 for exponential, naming multiplier', async () => {
    const error = await failure(createRetry({ name: 'Flat?', multiplier: 1 }));
    expect(error.body.error.details).toMatchObject({ field: 'multiplier' });
    expect(error.body.error.message).toContain('substitute 2');
  });

  it('accepts multiplier 1 for constant, because it is not read there', async () => {
    const created = await createRetry({ name: 'Flat', strategy: 'constant', multiplier: 1 });
    expect(created.multiplier).toBe(1);
  });

  it(
    'answers limit_exceeded with { limit, current, resource } at the project ceiling',
    async () => {
      // The real ceiling, reached the real way: each create is one mock round
      // trip with the mock's latency, hence the longer timeout.
      const existing = (await listRetry(PROJECT, '?limit=200')).data.length;
      for (let index = existing; index < MAX_RETRY_POLICIES_PER_PROJECT; index += 1) {
        await createRetry({ name: `filler ${index}` });
      }
      const error = await failure(createRetry({ name: 'one too many' }));
      expect(error.status).toBe(409);
      expect(error.body.error.code).toBe('limit_exceeded');
      expect(error.body.error.details).toMatchObject({
        limit: MAX_RETRY_POLICIES_PER_PROJECT,
        current: MAX_RETRY_POLICIES_PER_PROJECT,
        resource: 'retry_policies',
      });
    },
    30_000,
  );
});

describe('retry policies — update', () => {
  it('applies a partial update and leaves the rest alone', async () => {
    const before = db.retryPolicies.find((policy) => policy.id === UNUSED)!;
    const updated = await patchRetry(UNUSED, { max_attempts: 6 });
    expect(updated.max_attempts).toBe(6);
    expect(updated.name).toBe(before.name);
    expect(updated.strategy).toBe(before.strategy);
  });

  it('refuses is_default on a PATCH — the default has its own route', async () => {
    const error = await failure(patchRetry(UNUSED, { is_default: true }));
    expect(error.status).toBe(400);
    expect((error.body.error.message as string[])[0]).toContain('is_default');
    expect((error.body.error.message as string[])[0]).toContain('default');
  });

  it('validates the MERGED settings: lowering max_delay_ms under the stored initial delay', async () => {
    // rp_01JQDEFAULT has initial_delay_ms 30_000. Lowering the ceiling alone
    // walks the stored row into a clamped-forever combination.
    const error = await failure(patchRetry(DEFAULT_POLICY, { max_delay_ms: 10_000 }));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'initial_delay_ms' });
  });

  it('validates the merged strategy: switching a multiplier-1 policy to exponential', async () => {
    // rp_01JQTIGHT is constant with multiplier 1.
    const error = await failure(patchRetry(IN_USE, { strategy: 'exponential' }));
    expect(error.body.error.details).toMatchObject({ field: 'multiplier' });
  });
});

describe('retry policies — set default', () => {
  it('moves the default and leaves exactly one', async () => {
    const promoted = await mockRequest<RetryPolicy>(
      'POST',
      `/v1/projects/${PROJECT}/retry-policies/${UNUSED}/default`,
    );
    expect(promoted.is_default).toBe(true);
    const page = await listRetry();
    const defaults = page.data.filter((policy) => policy.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(UNUSED);
  });

  it('is idempotent on the current default', async () => {
    const again = await mockRequest<RetryPolicy>(
      'POST',
      `/v1/projects/${PROJECT}/retry-policies/${DEFAULT_POLICY}/default`,
    );
    expect(again.is_default).toBe(true);
    expect((await listRetry()).data.filter((policy) => policy.is_default)).toHaveLength(1);
  });
});

describe('retry policies — delete', () => {
  it('refuses while a LIVE endpoint references it, with the count in details', async () => {
    const error = await failure(deleteRetry(IN_USE));
    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
    expect(error.body.error.details).toMatchObject({ endpoints: 1 });
    expect(error.body.error.message).toContain('Point them at another policy first');
  });

  it('is not blocked by a soft-deleted endpoint, which is unlinked instead', async () => {
    const removed = db.endpoints.find((endpoint) => endpoint.id === 'ep_01JQREMOVED')!;
    removed.retry_policy_id = UNUSED;
    await deleteRetry(UNUSED);
    const after = await mockRequest<Endpoint>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints/ep_01JQREMOVED`,
    );
    expect(after.retry_policy_id).toBeNull();
  });

  it('refuses deleting the default without a successor while others remain', async () => {
    const error = await failure(deleteRetry(DEFAULT_POLICY));
    expect(error.status).toBe(409);
    expect(error.body.error.message).toContain('replacement_id');
  });

  it('promotes the named successor in the same request', async () => {
    await deleteRetry(DEFAULT_POLICY, `?replacement_id=${UNUSED}`);
    const page = await listRetry();
    expect(page.data.some((policy) => policy.id === DEFAULT_POLICY)).toBe(false);
    const defaults = page.data.filter((policy) => policy.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(UNUSED);
  });

  it('refuses a replacement_id that is the policy itself, naming the field', async () => {
    const error = await failure(deleteRetry(DEFAULT_POLICY, `?replacement_id=${DEFAULT_POLICY}`));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'replacement_id' });
  });

  it('refuses a replacement_id on a policy that is not the default', async () => {
    const error = await failure(deleteRetry(UNUSED, `?replacement_id=${DEFAULT_POLICY}`));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'replacement_id' });
    expect(error.body.error.message).toContain('not the default');
  });

  it('allows deleting the LAST policy with no successor — the built-in default is a defined state', async () => {
    const only = await createRetry({ name: 'Only' }, SIBLING);
    await mockRequest<void>('DELETE', `/v1/projects/${SIBLING}/retry-policies/${only.id}`);
    expect((await listRetry(SIBLING)).data).toEqual([]);
  });

  it('refuses a replacement_id when deleting the only policy', async () => {
    const only = await createRetry({ name: 'Only' }, SIBLING);
    const error = await failure(
      mockRequest(
        'DELETE',
        `/v1/projects/${SIBLING}/retry-policies/${only.id}?replacement_id=${only.id}`,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'replacement_id' });
  });
});

/* ── Rate limits ──────────────────────────────────────────────────────────── */

const listRates = (project = PROJECT, search = '') =>
  mockRequest<OffsetPage<RateLimit>>('GET', `/v1/projects/${project}/rate-limits${search}`);
const createRate = (body: Record<string, unknown>, project = PROJECT) =>
  mockRequest<RateLimit>('POST', `/v1/projects/${project}/rate-limits`, body);
const patchRate = (id: string, body: Record<string, unknown>) =>
  mockRequest<RateLimit>('PATCH', `/v1/projects/${PROJECT}/rate-limits/${id}`, body);

describe('rate limits — reads', () => {
  it('lists the one offset envelope, scoped to the project, with the scope filter', async () => {
    const page = await listRates();
    expect(page).toHaveProperty('has_more');
    expect(page.data.every((policy) => policy.project_id === PROJECT)).toBe(true);
    expect((await listRates(SIBLING)).data).toEqual([]);

    const ingest = await listRates(PROJECT, '?scope=ingest');
    expect(ingest.data.length).toBeGreaterThan(0);
    expect(ingest.data.every((policy) => policy.scope === 'ingest')).toBe(true);
  });

  it('refuses a scope outside the enum and an unknown filter', async () => {
    expect((await failure(listRates(PROJECT, '?scope=galaxy'))).status).toBe(400);
    expect((await failure(listRates(PROJECT, '?search=x'))).status).toBe(400);
  });

  it('carries the every-resource row as resource_id: null, never absent', async () => {
    const page = await listRates(PROJECT, '?scope=project');
    expect(page.data[0]).toHaveProperty('resource_id');
    expect(page.data[0].resource_id).toBeNull();
  });
});

describe('rate limits — create', () => {
  it('creates an endpoint-scoped policy naming an endpoint in this project', async () => {
    const created = await createRate({ scope: 'endpoint', resource_id: 'ep_01JQFINANCE', limit: 10 });
    expect(created.resource_id).toBe('ep_01JQFINANCE');
    expect(created.window_seconds).toBe(1);
    expect(created.burst).toBeNull();
  });

  it('answers the shared 404 for an endpoint or key in another project', async () => {
    const error = await failure(
      createRate({ scope: 'endpoint', resource_id: 'ep_01JQFINANCE', limit: 10 }, SIBLING),
    );
    expect(error.status).toBe(404);
    expect(error.body.error.message).toBe('Resource not found.');
    expect(
      (await failure(createRate({ scope: 'ingest', resource_id: 'key_01JQLIVE', limit: 10 }, SIBLING)))
        .status,
    ).toBe(404);
  });

  it('refuses a duplicate (scope, resource_id) as a conflict naming the existing row', async () => {
    // The every-key ingest row already exists in the fixtures.
    const error = await failure(createRate({ scope: 'ingest', resource_id: null, limit: 10 }));
    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
    expect(error.body.error.details).toMatchObject({
      scope: 'ingest',
      resource_id: null,
      existing_policy_id: 'rl_01JQINGESTALL',
    });
  });

  it('refuses burst below limit, naming burst in details', async () => {
    const error = await failure(createRate({ scope: 'ingest', resource_id: 'key_01JQLIVE', limit: 100, burst: 50 }));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'burst' });
  });

  it('refuses out-of-range numbers as a ValidationPipe array', async () => {
    const error = await failure(createRate({ scope: 'endpoint', limit: 0, window_seconds: 0 }));
    const messages = error.body.error.message as string[];
    expect(messages).toContain('limit: must not be less than 1');
    expect(messages).toContain('window_seconds: must not be less than 1');
  });

  it('at project scope accepts null or this project, and refuses a sibling with a 400', async () => {
    await mockRequest<void>('DELETE', `/v1/projects/${PROJECT}/rate-limits/rl_01JQPROJECT`);
    const own = await createRate({ scope: 'project', resource_id: PROJECT, limit: 500 });
    expect(own.resource_id).toBe(PROJECT);

    const error = await failure(createRate({ scope: 'project', resource_id: SIBLING, limit: 500 }));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'resource_id' });
  });

  it('at organization scope refuses any organization but its own', async () => {
    const error = await failure(createRate({ scope: 'organization', resource_id: 'org_01JQKWIK', limit: 5 }));
    expect(error.status).toBe(404);
    const own = await createRate({ scope: 'organization', resource_id: ORG, limit: 5 });
    expect(own.resource_id).toBe(ORG);
  });
});

describe('rate limits — update', () => {
  it('applies a partial update', async () => {
    const updated = await patchRate('rl_01JQBACKFILLKEY', { limit: 75 });
    expect(updated.limit).toBe(75);
    expect(updated.resource_id).toBe('key_01JQBACKFILL');
  });

  it('validates the merged settings: raising limit above the stored burst', async () => {
    // rl_01JQPARTNERCAP has burst 40.
    const error = await failure(patchRate('rl_01JQPARTNERCAP', { limit: 100 }));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'burst' });
  });

  it('refuses a scope change that leaves a stale resource_id unstated', async () => {
    const error = await failure(patchRate('rl_01JQPARTNERCAP', { scope: 'organization' }));
    expect(error.status).toBe(400);
    expect(error.body.error.details).toMatchObject({ field: 'resource_id' });
    expect(error.body.error.message).toContain('endpoint');
  });

  it('re-identifies the row when scope and resource are restated, re-checking uniqueness', async () => {
    const moved = await patchRate('rl_01JQPARTNERCAP', { scope: 'endpoint', resource_id: null });
    expect(moved.resource_id).toBeNull();

    // Now the every-endpoint row exists, so another cannot move onto it.
    const error = await failure(patchRate('rl_01JQBACKFILLKEY', { scope: 'endpoint', resource_id: null }));
    expect(error.status).toBe(409);
    expect(error.body.error.details).toMatchObject({ existing_policy_id: 'rl_01JQPARTNERCAP' });
  });
});

describe('rate limits — delete', () => {
  it('hard-deletes with no preconditions', async () => {
    await mockRequest<void>('DELETE', `/v1/projects/${PROJECT}/rate-limits/rl_01JQPARTNERCAP`);
    const error = await failure(
      mockRequest('GET', `/v1/projects/${PROJECT}/rate-limits/rl_01JQPARTNERCAP`),
    );
    expect(error.status).toBe(404);
  });

  it('answers the shared 404 across tenants rather than deleting', async () => {
    const error = await failure(
      mockRequest('DELETE', `/v1/projects/${OTHER_ORG_PROJECT}/rate-limits/rl_01JQPARTNERCAP`),
    );
    expect(error.status).toBe(404);
    expect((await listRates()).data.some((policy) => policy.id === 'rl_01JQPARTNERCAP')).toBe(true);
  });
});
