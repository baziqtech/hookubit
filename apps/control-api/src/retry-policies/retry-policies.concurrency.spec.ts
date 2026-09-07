import { RequestContext, TenantScope } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { CreateRetryPolicyDto } from './dto';
import { MAX_RETRY_POLICIES_PER_PROJECT } from './retry-policy-limits';
import {
  RetryPolicyHarness,
  assertExactlyOneDefault,
  defaultIdsIn,
  retryHarness,
} from './testing/harness';

const BODY: CreateRetryPolicyDto = { name: 'policy' };

async function withThreePolicies(): Promise<{
  harness: RetryPolicyHarness;
  a: string;
  b: string;
}> {
  const harness = await retryHarness();
  const a = await harness.policies.create(harness.context, { ...BODY, name: 'a' });
  const b = await harness.policies.create(harness.context, { ...BODY, name: 'b' });
  // The fixture's rp_a1 is the default; a and b are not.
  expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([IDS.retryPolicyA1]);
  return { harness, a: a.id, b: b.id };
}

/**
 * "A project with retry policies has exactly one default" is a property of a SET
 * of rows, and there is nothing in the schema that holds it: `retry_policies`
 * has no partial unique index, and PostgreSQL cannot express one through
 * schema.prisma anyway (see the migration request in HANDOFF.md). Two concurrent
 * "make me the default" calls each clear the old default and set a new one,
 * touching DIFFERENT rows — so under READ COMMITTED neither blocks on the other,
 * both commit, and the project ends with two defaults. The delivery workers then
 * have two answers to "which backoff applies to this endpoint", and no rule for
 * choosing between them.
 *
 * These tests assert the PROPERTY under concurrent execution, read straight off
 * the rows. A test that asserted the MECHANISM (that a transaction was opened)
 * would keep passing if the mechanism were swapped for a broken one.
 */
describe('the two-defaults race', () => {
  it('two simultaneous set-default calls leave exactly one default', async () => {
    const { harness, a, b } = await withThreePolicies();

    const outcomes = await Promise.allSettled([
      harness.policies.setDefault(harness.context, a),
      harness.policies.setDefault(harness.context, b),
    ]);

    // THE PROPERTY.
    assertExactlyOneDefault(harness.db, IDS.projectA1);
    // Both are legitimate requests, so both are allowed to succeed; what is not
    // allowed is for both to still be the default afterwards.
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toHaveLength(1);
    expect([a, b]).toContain(defaultIdsIn(harness.db, IDS.projectA1)[0]);
  });

  it('four simultaneous set-default calls still leave exactly one', async () => {
    const { harness, a, b } = await withThreePolicies();
    const c = await harness.policies.create(harness.context, { ...BODY, name: 'c' });

    await Promise.allSettled([
      harness.policies.setDefault(harness.context, a),
      harness.policies.setDefault(harness.context, b),
      harness.policies.setDefault(harness.context, c.id),
      harness.policies.setDefault(harness.context, IDS.retryPolicyA1),
    ]);

    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('two simultaneous creates that both ask to be default leave exactly one', async () => {
    const harness = await retryHarness();

    await Promise.allSettled([
      harness.policies.create(harness.context, { ...BODY, name: 'x', is_default: true }),
      harness.policies.create(harness.context, { ...BODY, name: 'y', is_default: true }),
    ]);

    assertExactlyOneDefault(harness.db, IDS.projectA1);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).not.toContain(IDS.retryPolicyA1);
  });

  /**
   * The other interleave, and the one that would silently produce ZERO defaults:
   * a set-default racing the delete of the current default. The delete promotes
   * its named successor in the same transaction, so whichever order they land in,
   * the project is never left with policies and no default.
   */
  it('a set-default racing a delete-with-replacement cannot empty the set', async () => {
    const { harness, a, b } = await withThreePolicies();

    await Promise.allSettled([
      harness.policies.setDefault(harness.context, a),
      harness.policies.remove(harness.context, IDS.retryPolicyA1, b),
    ]);

    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('a create racing a set-default cannot leave two', async () => {
    const { harness, a } = await withThreePolicies();

    await Promise.allSettled([
      harness.policies.create(harness.context, { ...BODY, name: 'z', is_default: true }),
      harness.policies.setDefault(harness.context, a),
    ]);

    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });
});

/**
 * The guard on the guard.
 *
 * `assertExactlyOneDefault` is only worth anything if it actually fails for the
 * shape being fixed, so the pre-fix shape is reproduced here and run against the
 * same assertion. This is the code that was NOT written: read the current
 * default, clear that specific row, set the new one — three statements, no
 * transaction, and the clear targets a snapshot rather than the set.
 *
 * If this test ever starts passing (i.e. the unsafe version stops producing two
 * defaults), the property check has stopped detecting the bug and every test
 * above it is vacuous.
 */
describe('the pre-fix shape, run against the same property check', () => {
  async function setDefaultUnsafe(
    harness: RetryPolicyHarness,
    context: RequestContext,
    policyId: string,
  ): Promise<void> {
    const scope: TenantScope = harness.scopes.for(context);
    // 1. Read the current default. Two callers both see the SAME row here.
    const previous = await scope.retryPolicies.findFirst({ where: { isDefault: true } });
    // 2. Clear the one that was read - not "every other default".
    if (previous && previous.id !== policyId) {
      await scope.retryPolicies.updateById(previous.id, { isDefault: false });
    }
    // 3. Set the new one. Nothing above is atomic with anything below.
    await scope.retryPolicies.updateById(policyId, { isDefault: true });
  }

  it('produces two defaults, and the property check catches it', async () => {
    const { harness, a, b } = await withThreePolicies();

    await Promise.allSettled([
      setDefaultUnsafe(harness, harness.context, a),
      setDefaultUnsafe(harness, harness.context, b),
    ]);

    expect(defaultIdsIn(harness.db, IDS.projectA1).sort()).toEqual([a, b].sort());
    expect(() => assertExactlyOneDefault(harness.db, IDS.projectA1)).toThrow(
      /2 of them are the default/,
    );
  });

  it('and the real service, given the identical interleaving, does not', async () => {
    const { harness, a, b } = await withThreePolicies();

    await Promise.allSettled([
      harness.policies.setDefault(harness.context, a),
      harness.policies.setDefault(harness.context, b),
    ]);

    expect(() => assertExactlyOneDefault(harness.db, IDS.projectA1)).not.toThrow();
  });
});

/**
 * The transaction protecting the default is not the only thing the ceiling
 * needs: two concurrent creates at the boundary must not both get in. This is
 * the same read-then-write shape, and it is here rather than in the service
 * suite because the assertion is about concurrency, not about the message.
 */
describe('the ceiling under concurrency', () => {
  it('two simultaneous creates at the boundary cannot both pass the ceiling', async () => {
    const harness = await retryHarness();
    const now = new Date();
    const inProjectA = (): Record<string, unknown>[] =>
      harness.db.all('retryPolicy').filter((row) => row.projectId === IDS.projectA1);

    // Fill to exactly ONE slot below the ceiling, counting this project's rows
    // only - the fixture also seeds a policy in the other tenant.
    for (let i = inProjectA().length; i < MAX_RETRY_POLICIES_PER_PROJECT - 1; i += 1) {
      harness.db.insert('retryPolicy', {
        id: `rp_filler_${i}`,
        projectId: IDS.projectA1,
        name: `filler ${i}`,
        isDefault: false,
        strategy: 'exponential',
        maxAttempts: 8,
        initialDelayMs: 5_000,
        maxDelayMs: 3_600_000,
        multiplier: 2,
        jitterRatio: 0.2,
        maxRetryDurationMs: 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    }
    expect(inProjectA()).toHaveLength(MAX_RETRY_POLICIES_PER_PROJECT - 1);

    const outcomes = await Promise.allSettled([
      harness.policies.create(harness.context, { ...BODY, name: 'over-1' }),
      harness.policies.create(harness.context, { ...BODY, name: 'over-2' }),
    ]);

    // One slot, two callers: the ceiling is a read-then-write over a set of
    // rows exactly like the default is, and without the transaction both
    // counts read 49 and both inserts land.
    expect(inProjectA()).toHaveLength(MAX_RETRY_POLICIES_PER_PROJECT);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(error.code).toBe('limit_exceeded');
    expect(error.details).toMatchObject({
      limit: MAX_RETRY_POLICIES_PER_PROJECT,
      current: MAX_RETRY_POLICIES_PER_PROJECT,
      resource: 'retry_policies',
    });
  });
});
