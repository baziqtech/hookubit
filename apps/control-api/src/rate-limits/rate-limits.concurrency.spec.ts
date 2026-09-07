import { RequestContext, TenantScope } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { CreateRateLimitDto } from './dto';
import {
  RateLimitHarness,
  assertUniqueScopeResourcePairs,
  policiesIn,
  rateLimitHarness,
} from './testing/harness';

const WIDE: CreateRateLimitDto = { scope: 'endpoint', resource_id: null, limit: 100 };

/**
 * "One rate limit per (project, scope, resource_id)" is what the NULLS NOT
 * DISTINCT unique index enforces in PostgreSQL — and a unique index is exactly
 * the wrong thing to lean on alone, because the check that produces a readable
 * error is a SEPARATE read-then-write: two concurrent creates both find no
 * existing row, and both insert.
 *
 * In production the index catches the loser and `mapConflict` turns its P2002
 * into a 409. These tests assert the PROPERTY — never two policies for one
 * (scope, resource) pair — under concurrent execution, read straight off the
 * rows, because the fake has no unique indexes at all: what is being exercised
 * here is the SERIALIZABLE check-then-insert, which is the half that has to
 * hold on its own.
 */
describe('the duplicate-policy race', () => {
  it('two simultaneous creates of the same null-resource policy leave one', async () => {
    const harness = await rateLimitHarness();

    const outcomes = await Promise.allSettled([
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 10 }),
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 20 }),
    ]);

    // THE PROPERTY.
    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(1);

    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ scope: 'endpoint', resource_id: null });
  });

  it('two simultaneous creates for the same endpoint leave one', async () => {
    const harness = await rateLimitHarness();

    await Promise.allSettled([
      harness.rateLimits.create(harness.context, {
        scope: 'endpoint',
        resource_id: IDS.endpointA1,
        limit: 10,
      }),
      harness.rateLimits.create(harness.context, {
        scope: 'endpoint',
        resource_id: IDS.endpointA1,
        limit: 20,
      }),
    ]);

    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(1);
  });

  it('a create racing a patch onto the same identity cannot produce a pair', async () => {
    const harness = await rateLimitHarness();
    const existing = await harness.rateLimits.create(harness.context, {
      scope: 'project',
      resource_id: null,
      limit: 10,
    });

    await Promise.allSettled([
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 30 }),
      harness.rateLimits.update(harness.context, existing.id, { scope: 'endpoint' }),
    ]);

    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
  });

  it('four simultaneous creates across two identities leave exactly two rows', async () => {
    const harness = await rateLimitHarness();

    await Promise.allSettled([
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 10 }),
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 20 }),
      harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 30 }),
      harness.rateLimits.create(harness.context, { scope: 'project', resource_id: null, limit: 40 }),
    ]);

    assertUniqueScopeResourcePairs(harness.db, IDS.projectA1);
    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(2);
  });
});

/**
 * The guard on the guard, again: the property check is only worth something if
 * it fails for the shape being fixed.
 *
 * The pre-fix shape here is the ordinary one — check for an existing row, then
 * insert, with nothing making the pair atomic. Note that this is ALSO what a
 * codebase relying on the unique index alone looks like against a database
 * where the index is NULLS DISTINCT: the `resource_id IS NULL` row, the one
 * that means "every resource in this scope", is precisely the row the default
 * index does not constrain.
 */
describe('the pre-fix shape, run against the same property check', () => {
  async function createUnsafe(
    harness: RateLimitHarness,
    context: RequestContext,
    limit: number,
  ): Promise<void> {
    const scope: TenantScope = harness.scopes.for(context);
    // 1. Check. Two callers both see nothing here.
    const existing = await scope.rateLimitPolicies.findFirst({
      where: { scope: 'endpoint', resourceId: null },
    });
    if (existing) throw new AppError('conflict', 'already exists');
    // 2. Insert. Not atomic with the check above.
    await scope.rateLimitPolicies.create({
      id: newId('rateLimitPolicy'),
      scope: 'endpoint',
      resourceId: null,
      limit,
      windowSeconds: 1,
      burst: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('produces two policies for one identity, and the property check catches it', async () => {
    const harness = await rateLimitHarness();

    await Promise.allSettled([
      createUnsafe(harness, harness.context, 10),
      createUnsafe(harness, harness.context, 20),
    ]);

    expect(policiesIn(harness.db, IDS.projectA1)).toHaveLength(2);
    expect(() => assertUniqueScopeResourcePairs(harness.db, IDS.projectA1)).toThrow(
      /duplicate rate limits/,
    );
  });

  it('and the real service, given the identical interleaving, does not', async () => {
    const harness = await rateLimitHarness();

    await Promise.allSettled([
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 10 }),
      harness.rateLimits.create(harness.context, { ...WIDE, limit: 20 }),
    ]);

    expect(() => assertUniqueScopeResourcePairs(harness.db, IDS.projectA1)).not.toThrow();
  });
});
