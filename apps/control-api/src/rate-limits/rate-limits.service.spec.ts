import { Prisma } from '@prisma/client';
import { CROSS_TENANT_MESSAGE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { CreateRateLimitDto } from './dto';
import { MAX_RATE_LIMIT_POLICIES_PER_PROJECT, RATE_LIMIT_LIMITS } from './rate-limit-limits';
import {
  API_KEYS,
  RateLimitHarness,
  assertUniqueScopeResourcePairs,
  policiesIn,
  rateLimitHarness,
} from './testing/harness';

const BODY: CreateRateLimitDto = { scope: 'project', limit: 100, window_seconds: 60 };

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

describe('resource_id is resolved through the scoped repository for its scope', () => {
  it('accepts an endpoint in this project', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 10,
    });
    expect(created).toMatchObject({
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      project_id: IDS.projectA1,
    });
  });

  /**
   * THE cross-tenant write this module could produce: a row stamped with the
   * caller's `project_id` — so it passes every read fence — while naming a
   * resource inside someone else's project.
   */
  it.each([
    ['endpoint', IDS.endpointB1],
    ['ingest', API_KEYS.b1],
    ['project', IDS.projectB1],
    ['organization', IDS.orgB],
  ])('refuses a %s-scoped policy pointing at another tenant', async (scope, resourceId) => {
    const harness = await rateLimitHarness();
    const error = await refusal(
      harness.rateLimits.create(harness.context, {
        ...BODY,
        scope: scope as CreateRateLimitDto['scope'],
        resource_id: resourceId,
      }),
    );
    expect(error.code).toBe('not_found');
    expect(error.message).toBe(CROSS_TENANT_MESSAGE);
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(0);
  });

  it('gives an absent resource the identical answer to a foreign one', async () => {
    const harness = await rateLimitHarness();
    const foreign = await refusal(
      harness.rateLimits.create(harness.context, {
        scope: 'endpoint',
        resource_id: IDS.endpointB1,
        limit: 5,
      }),
    );
    const absent = await refusal(
      harness.rateLimits.create(harness.context, {
        scope: 'endpoint',
        resource_id: 'ep_nope',
        limit: 5,
      }),
    );
    expect(foreign.message).toBe(absent.message);
    expect(foreign.code).toBe(absent.code);
  });

  it('refuses a sibling project in the same organization, with a 400 that explains', async () => {
    const harness = await rateLimitHarness();
    const error = await refusal(
      harness.rateLimits.create(harness.context, {
        scope: 'project',
        resource_id: IDS.projectA2,
        limit: 5,
      }),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'resource_id' });
  });

  it('accepts this project and this organization by their own ids', async () => {
    const harness = await rateLimitHarness();
    const project = await harness.rateLimits.create(harness.context, {
      scope: 'project',
      resource_id: IDS.projectA1,
      limit: 5,
    });
    const organization = await harness.rateLimits.create(harness.context, {
      scope: 'organization',
      resource_id: IDS.orgA,
      limit: 5,
    });
    expect(project.resource_id).toBe(IDS.projectA1);
    expect(organization.resource_id).toBe(IDS.orgA);
  });

  it('accepts an API key at ingest scope', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'ingest',
      resource_id: API_KEYS.a1,
      limit: 500,
    });
    expect(created.resource_id).toBe(API_KEYS.a1);
  });

  it.each(['organization', 'project', 'endpoint', 'ingest'] as const)(
    'accepts a null resource_id at %s scope, meaning every resource in it',
    async (scope) => {
      const harness = await rateLimitHarness();
      const created = await harness.rateLimits.create(harness.context, {
        scope,
        resource_id: null,
        limit: 5,
      });
      expect(created.resource_id).toBeNull();
    },
  );

  it('re-resolves against the NEW scope when a patch changes it', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 5,
    });
    // The stored resource_id is an endpoint; organization scope does not refer
    // to endpoints, so carrying it over silently would be the bug.
    const error = await refusal(
      harness.rateLimits.update(harness.context, created.id, { scope: 'organization' }),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'resource_id' });

    const ok = await harness.rateLimits.update(harness.context, created.id, {
      scope: 'organization',
      resource_id: null,
    });
    expect(ok).toMatchObject({ scope: 'organization', resource_id: null });
  });

  it('refuses a patch that repoints at another tenant endpoint', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 5,
    });
    const error = await refusal(
      harness.rateLimits.update(harness.context, created.id, { resource_id: IDS.endpointB1 }),
    );
    expect(error.code).toBe('not_found');
    expect(harness.db.rows('rateLimitPolicy').get(created.id)).toMatchObject({
      resourceId: IDS.endpointA1,
    });
  });
});

describe('tenant isolation on the policy itself', () => {
  it.each([
    ['get', (h: RateLimitHarness, id: string) => h.rateLimits.get(h.context, id)],
    ['update', (h: RateLimitHarness, id: string) => h.rateLimits.update(h.context, id, { limit: 1 })],
    ['remove', (h: RateLimitHarness, id: string) => h.rateLimits.remove(h.context, id)],
  ])('%s on another tenant policy is a 404 with the one message', async (_name, call) => {
    const harness = await rateLimitHarness();
    harness.db.insert('rateLimitPolicy', {
      id: 'rl_b1',
      projectId: IDS.projectB1,
      scope: 'project',
      resourceId: null,
      limit: 10,
      windowSeconds: 1,
      burst: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const error = await refusal(call(harness, 'rl_b1'));
    expect(error.code).toBe('not_found');
    expect(error.message).toBe(CROSS_TENANT_MESSAGE);
    expect(harness.db.rows('rateLimitPolicy').get('rl_b1')).toBeDefined();
  });
});

describe('validation', () => {
  it.each([
    ['limit', { limit: 0 }],
    ['limit', { limit: -5 }],
    ['limit', { limit: RATE_LIMIT_LIMITS.limit.max + 1 }],
    ['window_seconds', { window_seconds: 0 }],
    ['window_seconds', { window_seconds: -1 }],
    ['window_seconds', { window_seconds: RATE_LIMIT_LIMITS.windowSeconds.max + 1 }],
  ])('refuses a nonsensical %s', async (field, patch) => {
    const harness = await rateLimitHarness();
    const error = await refusal(harness.rateLimits.create(harness.context, { ...BODY, ...patch }));
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field });
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(0);
  });

  it('refuses a burst below the limit, because the limit could never be reached', async () => {
    const harness = await rateLimitHarness();
    const error = await refusal(
      harness.rateLimits.create(harness.context, { ...BODY, limit: 100, burst: 50 }),
    );
    expect(error.details).toMatchObject({ field: 'burst' });
    expect(error.message).toContain('at least limit');
  });

  it('accepts a burst equal to the limit, and null for none', async () => {
    const harness = await rateLimitHarness();
    const equal = await harness.rateLimits.create(harness.context, {
      ...BODY,
      scope: 'endpoint',
      limit: 100,
      burst: 100,
    });
    const none = await harness.rateLimits.create(harness.context, { ...BODY, burst: null });
    expect(equal.burst).toBe(100);
    expect(none.burst).toBeNull();
  });

  /**
   * The cross-field rule a per-field decorator cannot express: each value is
   * legal on its own, and raising `limit` past a stored `burst` is one PATCH.
   */
  it('refuses a patch that raises limit above the stored burst', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      ...BODY,
      limit: 100,
      burst: 120,
    });
    const error = await refusal(
      harness.rateLimits.update(harness.context, created.id, { limit: 500 }),
    );
    expect(error.details).toMatchObject({ field: 'burst' });
    expect(harness.db.rows('rateLimitPolicy').get(created.id)).toMatchObject({ limit: 100 });
  });

  it('defaults window_seconds to 1 rather than leaving it unset', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'project',
      limit: 10,
    });
    expect(created.window_seconds).toBe(1);
  });
});

describe('uniqueness on (project, scope, resource_id), NULLS NOT DISTINCT', () => {
  it('refuses a second policy for the same scope and resource', async () => {
    const harness = await rateLimitHarness();
    await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 10,
    });
    const error = await refusal(
      harness.rateLimits.create(harness.context, {
        scope: 'endpoint',
        resource_id: IDS.endpointA1,
        limit: 20,
      }),
    );
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ scope: 'endpoint', resource_id: IDS.endpointA1 });
    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
  });

  /**
   * The row the index was fixed FOR. Under the default NULLS DISTINCT the
   * constraint enforced nothing here, so "every endpoint in this project" could
   * exist twice with different limits.
   */
  it('refuses a second null-resource policy in the same scope', async () => {
    const harness = await rateLimitHarness();
    await harness.rateLimits.create(harness.context, { scope: 'endpoint', resource_id: null, limit: 10 });
    const error = await refusal(
      harness.rateLimits.create(harness.context, { scope: 'endpoint', resource_id: null, limit: 20 }),
    );
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ scope: 'endpoint', resource_id: null });
    expect(error.message).toContain('every endpoint in this project');
    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
  });

  it('allows the same scope for different resources, and null alongside them', async () => {
    const harness = await rateLimitHarness();
    await harness.rateLimits.create(harness.context, { scope: 'endpoint', resource_id: null, limit: 10 });
    await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 20,
    });
    await harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 30 });
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(3);
    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
  });

  it('refuses a patch that would collide with an existing policy', async () => {
    const harness = await rateLimitHarness();
    await harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 10 });
    const second = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: null,
      limit: 20,
    });
    const error = await refusal(
      harness.rateLimits.update(harness.context, second.id, { scope: 'project' }),
    );
    expect(error.code).toBe('conflict');
    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
  });

  it('lets a policy be patched without tripping over itself', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: null,
      limit: 10,
    });
    const updated = await harness.rateLimits.update(harness.context, created.id, {
      scope: 'endpoint',
      resource_id: null,
      limit: 99,
    });
    expect(updated.limit).toBe(99);
  });
});

/**
 * The database's own answer, mapped by INDEX rather than by error code.
 *
 * The check inside the transaction is what produces a readable 409 in the
 * normal case; this is the path that holds under a genuine race, and it is the
 * one that is easy to get wrong: `catch (P2002) -> 409 "duplicate rate limit"`
 * reports a collision on a DIFFERENT index as this one, which sends the caller
 * looking in the wrong place for a failure that was fixable.
 */
describe('P2002 handling', () => {
  function prismaError(target: unknown): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: target === undefined ? undefined : { target },
    });
  }

  async function createThrowing(
    harness: RateLimitHarness,
    error: unknown,
  ): Promise<AppError | unknown> {
    const delegate = harness.db.rateLimitPolicy as unknown as Record<string, unknown>;
    const original = delegate.create;
    delegate.create = async (): Promise<never> => {
      throw error;
    };
    try {
      return await refusal(
        harness.rateLimits.create(harness.context, {
          scope: 'endpoint',
          resource_id: IDS.endpointA1,
          limit: 10,
        }),
      );
    } catch (err) {
      // `refusal` rethrows only when the call SUCCEEDED, which would itself be
      // the failure; anything else is the error under test.
      return err;
    } finally {
      delegate.create = original;
    }
  }

  it.each([
    ['the column list', ['project_id', 'scope', 'resource_id']],
    ['camelCased column names', ['projectId', 'scope', 'resourceId']],
    ['the constraint name', 'rate_limit_policies_project_id_scope_resource_id_key'],
  ])('turns a violation reported as %s into a real 409', async (_shape, target) => {
    const harness = await rateLimitHarness();
    const error = (await createThrowing(harness, prismaError(target))) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ scope: 'endpoint', resource_id: IDS.endpointA1 });
  });

  it.each([
    ['a unique index this module does not own', prismaError(['endpoints_project_id_url_key'])],
    ['a P2002 with no target at all', prismaError(undefined)],
    ['a foreign-key violation', new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: '5.22.0' })],
    ['an ordinary error', new Error('connection reset')],
  ])('rethrows %s unchanged rather than laundering it into a 409', async (_shape, thrown) => {
    const harness = await rateLimitHarness();
    const error = await createThrowing(harness, thrown);
    expect(error).toBe(thrown);
    expect(error).not.toBeInstanceOf(AppError);
  });
});

describe('ceilings, listing and audit', () => {
  it('refuses a create past the per-project ceiling with limit_exceeded, not conflict', async () => {
    const harness = await rateLimitHarness();
    const now = new Date();
    for (let i = 0; i < MAX_RATE_LIMIT_POLICIES_PER_PROJECT; i += 1) {
      harness.db.insert('rateLimitPolicy', {
        id: `rl_filler_${i}`,
        projectId: IDS.projectA1,
        scope: 'endpoint',
        resourceId: `ep_filler_${i}`,
        limit: 10,
        windowSeconds: 1,
        burst: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const error = await refusal(
      harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 10 }),
    );
    // A ceiling is NOT a collision - the dashboard must be able to tell a
    // duplicate on the unique index from running out of slots.
    expect(error.code).toBe('limit_exceeded');
    expect(error.details).toMatchObject({
      limit: MAX_RATE_LIMIT_POLICIES_PER_PROJECT,
      current: MAX_RATE_LIMIT_POLICIES_PER_PROJECT,
      resource: 'rate_limit_policies',
    });
  });

  it('pages correctly at the boundary and never returns a bare array', async () => {
    const harness = await rateLimitHarness();
    for (const scope of ['organization', 'project', 'endpoint', 'ingest'] as const) {
      await harness.rateLimits.create(harness.context, { scope, resource_id: null, limit: 10 });
    }
    const first = await harness.rateLimits.list(harness.context, { limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(3);

    const last = await harness.rateLimits.list(harness.context, { limit: 3, offset: 3 });
    expect(last.data).toHaveLength(1);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeNull();

    const exact = await harness.rateLimits.list(harness.context, { limit: 4 });
    expect(exact.has_more).toBe(false);
    expect(exact.next_offset).toBeNull();
    expect(Object.keys(exact).sort()).toEqual(['data', 'has_more', 'next_offset']);
  });

  it('filters by scope and resource, within this tenant only', async () => {
    const harness = await rateLimitHarness();
    await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 10,
    });
    await harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 20 });
    harness.db.insert('rateLimitPolicy', {
      id: 'rl_b1',
      projectId: IDS.projectB1,
      scope: 'endpoint',
      resourceId: IDS.endpointB1,
      limit: 10,
      windowSeconds: 1,
      burst: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const endpoints = await harness.rateLimits.list(harness.context, { scope: 'endpoint' });
    expect(endpoints.data.map((row) => row.resource_id)).toEqual([IDS.endpointA1]);

    const everything = await harness.rateLimits.list(harness.context, {});
    expect(everything.data.map((row) => row.project_id)).toEqual([IDS.projectA1, IDS.projectA1]);
  });

  it('records every write against the resolved tenant', async () => {
    const harness = await rateLimitHarness();
    const created = await harness.rateLimits.create(harness.context, {
      scope: 'endpoint',
      resource_id: IDS.endpointA1,
      limit: 10,
    });
    await harness.rateLimits.update(harness.context, created.id, { limit: 20 });
    await harness.rateLimits.remove(harness.context, created.id);

    expect(harness.db.all('auditLog').map((row) => row.action)).toEqual([
      'rate_limit_policy.created',
      'rate_limit_policy.updated',
      'rate_limit_policy.deleted',
    ]);
    for (const row of harness.db.all('auditLog')) {
      expect(row).toMatchObject({ organizationId: IDS.orgA, userId: IDS.ownerA });
      expect((row.metadata as Record<string, unknown>).project_id).toBe(IDS.projectA1);
    }
    expect(harness.db.rows('rateLimitPolicy').get(created.id)).toBeUndefined();
  });
});
