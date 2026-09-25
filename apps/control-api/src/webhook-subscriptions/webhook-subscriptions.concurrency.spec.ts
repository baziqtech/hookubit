import { Prisma } from '@prisma/client';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { CreateSubscriptionDto } from './dto';
import { maxSubscriptionsPerProject } from './subscription-limits';
import { Harness, harnessFor } from './testing/harness';

const BODY: CreateSubscriptionDto = {
  endpoint_id: IDS.endpointA1,
  event_types: ['payment.settled'],
};

/**
 * THE PROPERTY, restated where the tests can call it and read STRAIGHT OFF THE
 * ROWS rather than through the service.
 *
 * A service that believes an invariant holds while the table says otherwise is
 * the failure being guarded against, so a check that asks the service is a check
 * that would have passed the whole time.
 */
function subscriptionCount(harness: Harness, projectId = IDS.projectA1): number {
  return harness.db
    .all('webhookSubscription')
    .filter((row) => row.projectId === projectId).length;
}

function assertUnderCeiling(harness: Harness): void {
  const ceiling = maxSubscriptionsPerProject(harness.config);
  const actual = subscriptionCount(harness);
  if (actual <= ceiling) return;
  throw new Error(
    `invariant violated: project holds ${actual} subscriptions with a ceiling of ${ceiling}. ` +
      'Every subscription past the ceiling is another delivery row, another HTTP attempt and ' +
      'another retry chain per event.',
  );
}

/**
 * The subscription ceiling is a read-then-write over a SET of rows: count what
 * the project holds, then insert one more. That is the exact shape of the
 * last-owner bug `TenantTransactionRunner` was built for - the two INSERTs touch
 * DIFFERENT rows, so at READ COMMITTED there is no row lock to contend on,
 * neither transaction blocks, and both commit.
 *
 * It matters more here than it looks. Subscriptions are the delivery multiplier:
 * one ingested event becomes one `deliveries` row PER matching subscription,
 * each with its own retry chain and its own share of the endpoint's concurrency
 * budget. A ceiling that concurrent writers can walk past is not a ceiling on
 * rows, it is a ceiling on amplification that does not hold.
 *
 * These tests assert the PROPERTY under concurrent execution rather than the
 * mechanism. A test that asserted "create opens a transaction" would keep
 * passing if the transaction were opened around the wrong statements - which is
 * precisely the pre-fix shape reproduced at the bottom of this file.
 */
describe('the subscription ceiling under concurrency', () => {
  it('three simultaneous creates cannot all take the last slot', async () => {
    // Project A1 is seeded with two; a ceiling of three leaves exactly one.
    const harness = await harnessFor(undefined, undefined, { maxSubscriptions: 3 });
    expect(subscriptionCount(harness)).toBe(2);

    const outcomes = await Promise.allSettled([
      harness.subscriptions.create(harness.context, BODY),
      harness.subscriptions.create(harness.context, BODY),
      harness.subscriptions.create(harness.context, BODY),
    ]);

    // THE PROPERTY.
    assertUnderCeiling(harness);
    expect(subscriptionCount(harness)).toBe(3);

    // Exactly one winner, and the losers are told why in the terms the API
    // already uses - not a 500, and not a silent success.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(rejected).toHaveLength(2);
    for (const failure of rejected) {
      const error = failure.reason as AppError;
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('limit_exceeded');
      expect(error.details).toMatchObject({ limit: 3, resource: 'subscriptions' });
    }
  });

  it('holds when the burst is much larger than the headroom', async () => {
    const harness = await harnessFor(undefined, undefined, { maxSubscriptions: 5 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => harness.subscriptions.create(harness.context, BODY)),
    );

    assertUnderCeiling(harness);
    expect(subscriptionCount(harness)).toBe(5);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
  });

  /**
   * A create racing a delete must not end up over the ceiling either. The
   * delete frees a slot, so at most one extra create can succeed - and never
   * more than the ceiling in total, whichever order they land in.
   */
  it('holds when creates race a delete that frees a slot', async () => {
    const harness = await harnessFor(undefined, undefined, { maxSubscriptions: 2 });

    await Promise.allSettled([
      harness.subscriptions.create(harness.context, BODY),
      harness.subscriptions.remove(harness.context, IDS.subscriptionA1),
      harness.subscriptions.create(harness.context, BODY),
    ]);

    assertUnderCeiling(harness);
  });
});

/**
 * THE DISCRIMINATION CHECK.
 *
 * A property test is only worth the paper it is written on if it fails against
 * the shape being fixed. This reproduces the pre-fix implementation - count
 * OUTSIDE the transaction, insert inside it, which is how the endpoint and
 * API-key ceilings are written and why their docblocks call themselves
 * "advisory under concurrency" - and asserts that the same property, run the
 * same way, is violated by it.
 *
 * Without this block, the tests above would pass equally well against a service
 * that never opened a transaction at all, because nothing else in this suite
 * forces the two statements to be serialised.
 */
describe('the pre-fix shape, kept only to prove the property test discriminates', () => {
  /**
   * Count first, transaction second. Everything else - the tenant scope, the
   * repository, the serialisable runner - is identical to the real service.
   */
  async function createWithCeilingOutsideTransaction(harness: Harness): Promise<void> {
    const scope = harness.scopes.for(harness.context);
    const ceiling = maxSubscriptionsPerProject(harness.config);
    const existing = await scope.subscriptions.count();
    if (existing >= ceiling) {
      throw new AppError('limit_exceeded', 'ceiling reached', {
        limit: ceiling,
        current: existing,
        resource: 'subscriptions',
      });
    }
    const now = new Date();
    await harness.transactions.run(harness.context, async (tx) => {
      await tx.subscriptions.create({
        id: newId('subscription'),
        endpointId: BODY.endpoint_id,
        name: null,
        eventTypes: [...BODY.event_types],
        payloadFilter: Prisma.DbNull,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  it('lets three concurrent creates all take the last slot', async () => {
    const harness = await harnessFor(undefined, undefined, { maxSubscriptions: 3 });
    expect(subscriptionCount(harness)).toBe(2);

    const outcomes = await Promise.allSettled([
      createWithCeilingOutsideTransaction(harness),
      createWithCeilingOutsideTransaction(harness),
      createWithCeilingOutsideTransaction(harness),
    ]);

    // All three read `2 < 3` before any of them wrote.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    expect(subscriptionCount(harness)).toBe(5);
    // And the property test above fails against it, which is the point.
    expect(() => assertUnderCeiling(harness)).toThrow(/invariant violated/);
  });
});
