import { Row } from '../authz/testing/tenant-prisma.fake';
import { IDS } from '../authz/testing/fixtures';
import { newId } from '../common/ids';
import {
  LEDGER,
  LedgerHarness,
  allDeliveries,
  ledgerHarness,
  rawDelivery,
} from './testing/harness';
import { OriginalDeliveryConflict, historyWrites } from './testing/rich-fake';

/**
 * Replay under concurrency.
 *
 * The invariant is ARCHITECTURE.md 34, and it is not a nice-to-have: *do not
 * overwrite original delivery history; the original delivery remains
 * immutable.* Everything below asserts it as a PROPERTY of the rows, read
 * straight out of storage after concurrent execution, rather than trusting the
 * return value of the call that was supposed to uphold it.
 *
 * The database half of the invariant is modelled too. `FakeTenantPrisma` has no
 * unique indexes, so `installRichTables` adds the one that matters here:
 *
 *     CREATE UNIQUE INDEX deliveries_event_endpoint_original_key
 *       ON deliveries (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL
 *
 * partial precisely so replays are exempt. Without it, the pre-fix shape at the
 * bottom of this file would insert happily and the whole suite would be
 * vacuous.
 */

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

/** Every row that existed before is byte-identical now. */
function assertOriginalsIntact(before: Row[], after: Row[]): void {
  const now = new Map(after.map((row) => [String(row.id), row]));
  for (const row of before) {
    const current = now.get(String(row.id));
    if (!current) {
      throw new Error(`delivery ${String(row.id)} was DELETED by a replay`);
    }
    expect({ id: row.id, ...current }).toEqual({ id: row.id, ...row });
  }
}

/** Every row a replay created carries the two columns that make it a replay. */
function assertReplaysAreMarked(before: Row[], after: Row[]): void {
  const known = new Set(before.map((row) => String(row.id)));
  for (const row of after) {
    if (known.has(String(row.id))) continue;
    if ((row.replayOfDeliveryId ?? null) === null) {
      throw new Error(
        `delivery ${String(row.id)} was created with no replay_of_delivery_id; it is indistinguishable from an original and collides with deliveries_event_endpoint_original_key`,
      );
    }
    if ((row.replayedBy ?? null) === null) {
      throw new Error(`delivery ${String(row.id)} records no actor in replayed_by`);
    }
  }
}

/**
 * At most one ORIGINAL per (event, endpoint) - the partial unique index.
 *
 * `IDS.deliveryCorrupt` is excluded: `seedWorld` seeds it as a deliberate
 * data-integrity violation (its denormalised columns claim organization A while
 * its endpoint belongs to B) for the resolver's tests, and it duplicates
 * `del_b1`'s pair. It is a row PostgreSQL would have refused, kept in the
 * fixture on purpose, and it is not what this property is about.
 */
function assertOneOriginalPerPair(rows: Row[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.id === IDS.deliveryCorrupt) continue;
    if ((row.replayOfDeliveryId ?? null) !== null) continue;
    const key = `${String(row.eventId)}|${String(row.endpointId)}`;
    if (seen.has(key)) {
      throw new Error(`two ORIGINAL deliveries for ${key}; the partial unique index is violated`);
    }
    seen.add(key);
  }
}

// ---------------------------------------------------------------------------

describe('concurrent replays of the same delivery', () => {
  it('three at once produce three new rows and leave the original identical', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const outcomes = await Promise.allSettled([
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}),
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}),
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}),
    ]);

    const after = allDeliveries(harness.db);

    // THE PROPERTIES.
    assertOriginalsIntact(before, after);
    assertReplaysAreMarked(before, after);
    assertOneOriginalPerPair(after);

    // Replays are exempt from the index by design, so all three are legitimate.
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
    expect(after).toHaveLength(before.length + 3);
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
    expect(historyWrites(harness.db)).toEqual([]);
  });

  it('a replay racing the same event\'s replay-to-all touches no history', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    await Promise.allSettled([
      harness.events.replay(harness.context, LEDGER.eventOrder, {}),
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}),
      harness.events.replay(harness.context, LEDGER.eventOrder, {
        endpoint_id: LEDGER.endpointFinance,
      }),
    ]);

    const after = allDeliveries(harness.db);
    assertOriginalsIntact(before, after);
    assertReplaysAreMarked(before, after);
    assertOneOriginalPerPair(after);
    expect(historyWrites(harness.db)).toEqual([]);
  });

  it('five concurrent event replays create 5 x 2 rows and no more', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => harness.events.replay(harness.context, LEDGER.eventOrder, {})),
    );

    const after = allDeliveries(harness.db);
    assertOriginalsIntact(before, after);
    assertReplaysAreMarked(before, after);
    assertOneOriginalPerPair(after);

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    // Each call selects `replay_of_delivery_id IS NULL`, so none of them ever
    // sees the rows the others created: 10, never 12 or 30.
    expect(after).toHaveLength(before.length + 10);
  });

  it('a refused replay under concurrency writes nothing at all', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const outcomes = await Promise.allSettled([
      // The fan-out includes the soft-deleted endpoint: refused as a whole.
      harness.events.replay(harness.context, LEDGER.eventSettled, {}),
      harness.deliveries.replay(harness.context, LEDGER.deliverySettledGone, {}),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(allDeliveries(harness.db)).toEqual(before);
    expect(historyWrites(harness.db)).toEqual([]);
  });
});

/**
 * The guard on the guard: a property check is only worth something if it fails
 * for the shape being fixed. Two pre-fix shapes, both real - the second is what
 * an author reaches for after hitting the first.
 */
describe('the pre-fix shapes, run against the same property checks', () => {
  /**
   * PRE-FIX 1: the insert that forgets `replay_of_delivery_id`.
   *
   * It reads as harmless - "copy the row, reset the counters, insert" - and it
   * is what a replay looks like if nobody has read the migration. The partial
   * unique index is the arbiter the fan-out router names, so an unmarked insert
   * is not a second delivery, it is a duplicate ORIGINAL, and the database
   * refuses it.
   */
  async function replayUnmarked(harness: LedgerHarness, deliveryId: string): Promise<void> {
    const scope = harness.scopes.for(harness.context);
    const original = await scope.deliveries.findById(deliveryId);
    if (!original) throw new Error('fixture');
    await scope.deliveries.create({
      id: newId('delivery'),
      eventId: original.eventId,
      endpointId: original.endpointId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: original.maxAttempts,
      nextAttemptAt: new Date(),
      // The whole bug, in one omission.
      replayOfDeliveryId: null,
      replayedBy: harness.context.user.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('collides with the original on deliveries_event_endpoint_original_key', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const outcomes = await Promise.allSettled([
      replayUnmarked(harness, LEDGER.deliveryOrderA1),
      replayUnmarked(harness, LEDGER.deliveryOrderA1),
    ]);

    // Every one of them is refused by the index, so this shape cannot replay at
    // all - which is exactly why `replay_of_delivery_id` is not optional.
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(OriginalDeliveryConflict);
      expect((reason as Error).message).toContain('ORIGINAL delivery already exists');
    }
    expect(allDeliveries(harness.db)).toEqual(before);
  });

  it('and if the index were absent, assertReplaysAreMarked catches it', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    // Stand in for a database without the partial index: insert the unmarked
    // row directly. This is the state the fan-out router's ON CONFLICT would
    // then be unable to arbitrate - the reason the index exists at all.
    harness.db.insert('delivery', {
      id: 'del_unmarked',
      eventId: LEDGER.eventOrder,
      endpointId: LEDGER.endpointA1,
      organizationId: IDS.orgA,
      projectId: IDS.projectA1,
      status: 'pending',
      replayOfDeliveryId: null,
      replayedBy: IDS.ownerA,
    });
    const after = allDeliveries(harness.db);

    expect(() => assertReplaysAreMarked(before, after)).toThrow(/no replay_of_delivery_id/);
    expect(() => assertOneOriginalPerPair(after)).toThrow(/two ORIGINAL deliveries/);
  });

  /**
   * PRE-FIX 2: having hit the collision above, "fix" it by reusing the row.
   *
   * This is the shape ARCHITECTURE.md 34 is actually written against, and it
   * looks reasonable from the outside: the delivery goes back to `pending`, a
   * worker picks it up, the customer gets their webhook. What it destroys is
   * the ledger - the attempt count, the terminal status, the error and the
   * timestamps of the delivery that failed are gone, and "did finance ever
   * receive this, and what happened the first time?" is now unanswerable.
   */
  async function replayByOverwrite(harness: LedgerHarness, deliveryId: string): Promise<void> {
    const scope = harness.scopes.for(harness.context);
    await scope.deliveries.updateById(deliveryId, {
      status: 'pending',
      attemptCount: 0,
      completedAt: null,
      lastError: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('overwriting the original is caught by assertOriginalsIntact', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderFinance).status).toBe('exhausted');

    await Promise.allSettled([
      replayByOverwrite(harness, LEDGER.deliveryOrderFinance),
      replayByOverwrite(harness, LEDGER.deliveryOrderFinance),
    ]);

    const after = allDeliveries(harness.db);
    // The property check FAILS. If this ever stops throwing, every assertion in
    // the suites above has stopped meaning anything.
    expect(() => assertOriginalsIntact(before, after)).toThrow();
    // And the statement-level check sees it too, which is the version that
    // survives an UPDATE that happens to write identical values back.
    expect(historyWrites(harness.db).map((entry) => entry.op)).toContain('updateMany');
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderFinance).status).toBe('pending');
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderFinance).attemptCount).toBe(0);
  });

  it('the shipped implementation passes both checks on the same input', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    await Promise.allSettled([
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderFinance, {}),
      harness.deliveries.replay(harness.context, LEDGER.deliveryOrderFinance, {}),
    ]);

    const after = allDeliveries(harness.db);
    expect(() => assertOriginalsIntact(before, after)).not.toThrow();
    expect(() => assertReplaysAreMarked(before, after)).not.toThrow();
    expect(() => assertOneOriginalPerPair(after)).not.toThrow();
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderFinance).status).toBe('exhausted');
  });
});
