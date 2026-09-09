import { Delivery } from '@prisma/client';
import { CROSS_TENANT_MESSAGE, MAX_PAGE_SIZE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { DeliveriesService } from './deliveries.service';
import { MAX_INLINE_ATTEMPTS } from './delivery-limits';
import { DeliveryDetailDto, toDeliveryDto } from './dto';
import {
  FINANCE_ATTEMPTS,
  LEDGER,
  NOISY_ATTEMPTS,
  ledgerHarness,
  rawDelivery,
} from './testing/harness';
import { historyWrites } from './testing/rich-fake';

const ALL = { limit: MAX_PAGE_SIZE } as const;

describe('listing deliveries', () => {
  it('returns this project only, newest first, in the three-field envelope', async () => {
    const { deliveries, context } = await ledgerHarness();

    const page = await deliveries.list(context, ALL);

    expect(Object.keys(page).sort()).toEqual(['data', 'has_more', 'next_offset']);
    // Organization B's delivery, the deliberately corrupt one whose denormalised
    // columns claim org A, and project A2's delivery are all in the same table.
    const ids = page.data.map((delivery) => delivery.id);
    expect(ids).not.toContain(IDS.deliveryB1);
    expect(ids).not.toContain(IDS.deliveryCorrupt);
    expect(ids).not.toContain('del_a2_1');
    expect(ids).toContain(LEDGER.deliveryOrderA1);

    const timestamps = page.data.map((delivery) => Date.parse(delivery.created_at));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it('filters by status, by endpoint and by event', async () => {
    const { deliveries, context } = await ledgerHarness();

    const succeeded = await deliveries.list(context, { ...ALL, status: 'succeeded' });
    expect(succeeded.data.every((delivery) => delivery.status === 'succeeded')).toBe(true);

    const finance = await deliveries.list(context, {
      ...ALL,
      endpoint_id: LEDGER.endpointFinance,
    });
    expect(finance.data.map((delivery) => delivery.id).sort()).toEqual(
      [LEDGER.deliveryNoisy, LEDGER.deliveryOrderFinance].sort(),
    );

    const settled = await deliveries.list(context, { ...ALL, event_id: LEDGER.eventSettled });
    expect(settled.data.map((delivery) => delivery.id).sort()).toEqual(
      [LEDGER.deliverySettledA1, LEDGER.deliverySettledGone].sort(),
    );
  });

  it('`failing_now` is exactly retrying + failed + exhausted', async () => {
    const { deliveries, context } = await ledgerHarness();

    const failing = await deliveries.list(context, { ...ALL, failing_now: true });

    expect(failing.data.map((delivery) => delivery.id).sort()).toEqual(
      [
        LEDGER.deliveryNoisy,
        LEDGER.deliveryOrderFinance,
        LEDGER.deliverySettledA1,
        LEDGER.deliverySettledGone,
      ].sort(),
    );
    expect(failing.data.every((delivery) => !delivery.terminal || delivery.status !== 'succeeded')).toBe(
      true,
    );
  });

  it('refuses `status` and `failing_now` together rather than picking a winner', async () => {
    const { deliveries, context } = await ledgerHarness();

    await expect(
      deliveries.list(context, { ...ALL, status: 'succeeded', failing_now: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('filters by the event type of the event it came from', async () => {
    const { deliveries, context } = await ledgerHarness();

    const settled = await deliveries.list(context, { ...ALL, event_type: 'payment.settled' });

    expect(settled.data.map((delivery) => delivery.id).sort()).toEqual(
      [LEDGER.deliverySettledA1, LEDGER.deliverySettledGone].sort(),
    );
  });

  it('the date range is [after, before) so adjacent windows tile', async () => {
    const { deliveries, context } = await ledgerHarness();
    const boundary = new Date('2026-03-02T10:00:00.000Z');

    const before = await deliveries.list(context, { ...ALL, created_before: boundary });
    const after = await deliveries.list(context, { ...ALL, created_after: boundary });

    const overlap = before.data
      .map((delivery) => delivery.id)
      .filter((id) => after.data.some((delivery) => delivery.id === id));
    expect(overlap).toEqual([]);
    // The boundary row belongs to the [after, ...) window, once.
    expect(after.data.map((delivery) => delivery.id)).toContain(LEDGER.deliverySettledA1);
    expect(before.data.map((delivery) => delivery.id)).not.toContain(LEDGER.deliverySettledA1);
  });

  it('refuses a range that selects nothing', async () => {
    const { deliveries, context } = await ledgerHarness();

    await expect(
      deliveries.list(context, {
        ...ALL,
        created_after: new Date('2026-03-05T00:00:00.000Z'),
        created_before: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('another tenant\'s endpoint id as a filter yields nothing, and says nothing', async () => {
    const { deliveries, context } = await ledgerHarness();

    const page = await deliveries.list(context, { ...ALL, endpoint_id: IDS.endpointB1 });

    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});

describe('pagination at the page boundary', () => {
  it('has_more and next_offset are exact on the last full page', async () => {
    const { deliveries, context } = await ledgerHarness();
    const all = await deliveries.list(context, ALL);
    const total = all.data.length;
    expect(total).toBeGreaterThan(3);

    // Exactly the last row short: more remains, and the offset points at it.
    const short = await deliveries.list(context, { limit: total - 1 });
    expect(short.data).toHaveLength(total - 1);
    expect(short.has_more).toBe(true);
    expect(short.next_offset).toBe(total - 1);

    // Exactly all of them: `take + 1` finds no probe row, so this is the last
    // page even though it is completely full. This is the case a naive
    // `rows.length === take` implementation gets wrong.
    const exact = await deliveries.list(context, { limit: total });
    expect(exact.data).toHaveLength(total);
    expect(exact.has_more).toBe(false);
    expect(exact.next_offset).toBeNull();

    const tail = await deliveries.list(context, { limit: total, offset: short.next_offset ?? 0 });
    expect(tail.data).toHaveLength(1);
    expect(tail.has_more).toBe(false);
    expect(tail.next_offset).toBeNull();
    expect(tail.data[0].id).toBe(all.data[total - 1].id);
  });

  it('paging to exhaustion visits every delivery exactly once', async () => {
    const { deliveries, context } = await ledgerHarness();

    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Awaited<ReturnType<typeof deliveries.list>> = await deliveries.list(context, {
        limit: 3,
        offset,
      });
      seen.push(...page.data.map((delivery) => delivery.id));
      offset = page.next_offset;
    }

    const all = await deliveries.list(context, ALL);
    expect(seen).toHaveLength(all.data.length);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('fetching one delivery', () => {
  it('carries the event, the endpoint as it stands now, and the ordered history', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryOrderA1);

    expect(detail.id).toBe(LEDGER.deliveryOrderA1);
    expect(detail.event.event_type).toBe('order.created');
    expect(detail.endpoint.id).toBe(LEDGER.endpointA1);
    expect(detail.attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
    expect(detail.attempts_truncated).toBe(false);

    const [first, second] = detail.attempts;
    expect(first.status).toBe('failure');
    expect(first.http_status).toBe(503);
    expect(first.duration_ms).toBe(1_204);
    expect(first.error_code).toBe('http_503');
    expect(first.response_headers).toEqual({ 'retry-after': '30' });
    expect(second.status).toBe('success');
    expect(second.http_status).toBe(200);
  });

  /**
   * `attempt_count: 5` beside an empty attempt list is indistinguishable from
   * "the platform never tried" - the single worst thing this ledger can say.
   * Past the attempt horizon, retention reclaims the per-attempt detail and
   * stamps `attempts_pruned_at`, and this field is what turns that silence into
   * an answer. It must survive to the wire, on both shapes.
   */
  it('says when the per-attempt detail was reclaimed by retention', async () => {
    const { deliveries, context, db } = await ledgerHarness();
    const prunedAt = new Date('2026-06-01T00:00:00.000Z');
    const row = rawDelivery(db, LEDGER.deliveryOrderA1);
    db.rows('delivery').set(LEDGER.deliveryOrderA1, { ...row, attemptsPrunedAt: prunedAt });

    const detail = await deliveries.get(context, LEDGER.deliveryOrderA1);
    expect(detail.attempts_pruned_at).toBe(prunedAt.toISOString());

    // And on the SUMMARY shape, which the listing and the replay response both
    // return. `DeliveryDetailDto` extends `DeliveryDto`, so asserting the
    // mapper covers every route that emits either.
    const summary = toDeliveryDto(
      db.rows('delivery').get(LEDGER.deliveryOrderA1) as unknown as Delivery,
    );
    expect(summary.attempts_pruned_at).toBe(prunedAt.toISOString());
  });

  it('reports a delivery whose attempt history is intact as not pruned', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryOrderA1);

    expect(detail.attempts_pruned_at).toBeNull();
    expect(detail.attempts).not.toHaveLength(0);
  });

  it('redacts credential-shaped request headers but keeps the signature', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryOrderA1);
    const headers = detail.attempts[0].request_headers ?? {};

    // `deliveries.read` is a viewer permission; `endpoint-secrets.read` is
    // owner/admin. A customer's own bearer token must not arrive through the
    // cheaper of the two.
    expect(headers.authorization).toBe('[redacted]');
    expect(Object.keys(headers)).toContain('authorization');
    // The signature is an HMAC over the payload, not the key, and it is what a
    // consumer compares against when verification fails.
    expect(headers['x-webhook-signature']).toBe('v1,abc123');
  });

  it('orders 12 attempts numerically, not lexicographically', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryOrderFinance);

    // The failure this pins: string ordering gives 1, 10, 11, 12, 2, 3, ...
    expect(detail.attempts.map((attempt) => attempt.attempt_number)).toEqual(
      Array.from({ length: FINANCE_ATTEMPTS }, (_, index) => index + 1),
    );
    expect(detail.attempts_truncated).toBe(false);
  });

  it('truncates a very long history and says it did', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryNoisy);

    expect(detail.attempts).toHaveLength(MAX_INLINE_ATTEMPTS);
    expect(detail.attempts_truncated).toBe(true);
    expect(detail.attempts[0].attempt_number).toBe(1);
  });

  it('the paged attempts route covers the whole history in order', async () => {
    const { deliveries, context } = await ledgerHarness();

    const seen: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Awaited<ReturnType<typeof deliveries.listAttempts>> =
        await deliveries.listAttempts(context, LEDGER.deliveryNoisy, { limit: 50, offset });
      seen.push(...page.data.map((attempt) => attempt.attempt_number));
      offset = page.next_offset;
    }

    expect(seen).toEqual(Array.from({ length: NOISY_ATTEMPTS }, (_, index) => index + 1));
  });

  it('surfaces the next scheduled attempt and the lease', async () => {
    const { deliveries, context, db } = await ledgerHarness();
    db.rows('delivery').set(LEDGER.deliverySettledA1, {
      ...rawDelivery(db, LEDGER.deliverySettledA1),
      lockedBy: 'worker-7',
      lockedUntil: new Date('2026-03-02T10:05:00.000Z'),
    });

    const detail = await deliveries.get(context, LEDGER.deliverySettledA1);

    expect(detail.next_attempt_at).toBe('2026-03-02T10:30:00.000Z');
    expect(detail.locked_by).toBe('worker-7');
    expect(detail.locked_until).toBe('2026-03-02T10:05:00.000Z');
    expect(detail.terminal).toBe(false);
  });
});

describe('tenant isolation', () => {
  const cases: Array<[string, string]> = [
    ["another organization's delivery", IDS.deliveryB1],
    ['a delivery whose denormalised columns lie about who owns it', IDS.deliveryCorrupt],
    ["another project's delivery in the same organization", 'del_a2_1'],
    ['a delivery that does not exist', 'del_nope'],
  ];

  it.each(cases)('get: %s is one 404 with one message', async (_name, id) => {
    const { deliveries, context } = await ledgerHarness();

    const error = await deliveries.get(context, id).catch((err: AppError) => err);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });

  it.each(cases)('attempts: %s is one 404 with one message', async (_name, id) => {
    const { deliveries, context } = await ledgerHarness();

    const error = await deliveries.listAttempts(context, id, {}).catch((err: AppError) => err);

    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });

  it.each(cases)('replay: %s is one 404 with one message', async (_name, id) => {
    const { deliveries, context } = await ledgerHarness();

    const error = await deliveries.replay(context, id, {}).catch((err: AppError) => err);

    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('the attempt of a delivery in another tenant is not readable through ours', async () => {
    const { deliveries, context } = await ledgerHarness();

    const detail = await deliveries.get(context, LEDGER.deliveryOrderA1);

    expect(detail.attempts.map((attempt) => attempt.id)).not.toContain(IDS.attemptB1);
    expect(detail.attempts.map((attempt) => attempt.id)).not.toContain(IDS.attemptCorrupt);
  });
});

describe('replaying one delivery', () => {
  it('creates a new row and leaves the original byte-identical', async () => {
    const harness = await ledgerHarness();
    const before = rawDelivery(harness.db, LEDGER.deliveryOrderA1);
    const attemptsBefore = harness.db.all('deliveryAttempt').map((row) => ({ ...row }));

    const result = await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {
      reason: 'consumer asked us to re-send',
    });

    expect(result.replayed_count).toBe(1);
    expect(result.replay_of).toEqual([LEDGER.deliveryOrderA1]);

    // THE PROPERTY: the original is untouched, field for field.
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderA1)).toEqual(before);
    // ...and no statement that COULD have touched it was even issued. A row
    // comparison alone can be satisfied by an UPDATE that wrote the same values.
    expect(historyWrites(harness.db)).toEqual([]);
    // Append-only: not one attempt row changed.
    expect(harness.db.all('deliveryAttempt').map((row) => ({ ...row }))).toEqual(attemptsBefore);
  });

  it('the new row is a fresh lifecycle pointing at the original', async () => {
    const harness = await ledgerHarness();
    const original = rawDelivery(harness.db, LEDGER.deliveryOrderA1);

    const [replay] = (await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}))
      .deliveries;

    expect(replay.id).not.toBe(LEDGER.deliveryOrderA1);
    expect(replay.replay_of_delivery_id).toBe(LEDGER.deliveryOrderA1);
    expect(replay.is_replay).toBe(true);
    expect(replay.replayed_by).toBe(IDS.ownerA);
    expect(replay.status).toBe('pending');
    expect(replay.attempt_count).toBe(0);
    expect(replay.completed_at).toBeNull();
    expect(replay.last_error).toBeNull();
    expect(replay.locked_by).toBeNull();
    // Same event, same endpoint, same attempt budget, same ordering key: a
    // replay is a re-run of THAT delivery, not a new one under today's policy.
    expect(replay.event_id).toBe(original.eventId);
    expect(replay.endpoint_id).toBe(original.endpointId);
    expect(replay.max_attempts).toBe(original.maxAttempts);
    expect(replay.ordering_key).toBe(original.orderingKey);
    // `next_attempt_at` is set, not left null: the queue orders by it.
    expect(replay.next_attempt_at).not.toBeNull();
  });

  it('is refused when the endpoint has since been soft-deleted', async () => {
    const harness = await ledgerHarness();
    const before = rawDelivery(harness.db, LEDGER.deliverySettledGone);

    const error = await harness.deliveries
      .replay(harness.context, LEDGER.deliverySettledGone, {})
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).message).toContain('deleted');
    expect((error as AppError).details).toMatchObject({
      endpoint_id: LEDGER.endpointDeleted,
      endpoint_status: 'deleted',
    });
    // Nothing was written, and the original is untouched.
    expect(rawDelivery(harness.db, LEDGER.deliverySettledGone)).toEqual(before);
    expect(
      harness.db.all('delivery').filter((row) => row.replayOfDeliveryId !== null),
    ).toEqual([]);
  });

  it('is refused when the endpoint is paused', async () => {
    const harness = await ledgerHarness();

    const error = await harness.deliveries
      .replay(harness.context, LEDGER.deliveryPaused, {})
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).details).toMatchObject({
      endpoint_id: LEDGER.endpointPaused,
      endpoint_status: 'paused',
      enabled: false,
    });
  });

  it('replaying a replay chains rather than rewriting', async () => {
    const harness = await ledgerHarness();

    const [first] = (await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}))
      .deliveries;
    const firstRow = rawDelivery(harness.db, first.id);

    const [second] = (await harness.deliveries.replay(harness.context, first.id, {})).deliveries;

    expect(second.replay_of_delivery_id).toBe(first.id);
    expect(rawDelivery(harness.db, first.id)).toEqual(firstRow);
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderA1).replayOfDeliveryId).toBeNull();
  });

  it('records the replay in the audit log with both sides of the mapping', async () => {
    const harness = await ledgerHarness();

    const result = await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {
      reason: 'finance reconciliation',
    });

    const entries = harness.db.all('auditLog');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'delivery.replayed',
      resourceType: 'delivery',
      resourceId: LEDGER.deliveryOrderA1,
      userId: IDS.ownerA,
      organizationId: IDS.orgA,
    });
    expect(entries[0].metadata).toMatchObject({
      reason: 'finance reconciliation',
      replayed_count: 1,
      replay_of_delivery_ids: [LEDGER.deliveryOrderA1],
      created_delivery_ids: [result.deliveries[0].id],
      project_id: IDS.projectA1,
    });
  });

  it('drops a subscription id whose subscription no longer exists', async () => {
    const harness = await ledgerHarness();
    // The original carries `sub_a1`. Subscriptions are hard-deletable; the
    // delivery ledger is not.
    harness.db.rows('webhookSubscription').delete(IDS.subscriptionA1);

    const [replay] = (await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}))
      .deliveries;

    expect(rawDelivery(harness.db, LEDGER.deliveryOrderA1).subscriptionId).toBe(
      IDS.subscriptionA1,
    );
    expect(replay.subscription_id).toBeNull();
    // The provenance that matters survives regardless.
    expect(replay.replay_of_delivery_id).toBe(LEDGER.deliveryOrderA1);
  });

  it('the replay is visible in the listing, and distinguishable from the original', async () => {
    const harness = await ledgerHarness();
    const [replay] = (await harness.deliveries.replay(harness.context, LEDGER.deliveryOrderA1, {}))
      .deliveries;

    const originals = await harness.deliveries.list(harness.context, {
      ...ALL,
      origin: 'original',
    });
    const replays = await harness.deliveries.list(harness.context, { ...ALL, origin: 'replay' });

    expect(replays.data.map((delivery) => delivery.id)).toEqual([replay.id]);
    expect(originals.data.map((delivery) => delivery.id)).not.toContain(replay.id);
    expect(originals.data.map((delivery) => delivery.id)).toContain(LEDGER.deliveryOrderA1);
  });
});

describe('DeliveriesService.filterWhere', () => {
  it('never emits a tenant column - the scope owns those', () => {
    const where = DeliveriesService.filterWhere({
      status: 'failed',
      endpoint_id: 'ep_x',
      event_id: 'evt_x',
      event_type: 'a.b',
      origin: 'replay',
      created_after: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(where).not.toHaveProperty('projectId');
    expect(where).not.toHaveProperty('organizationId');
  });

  it('an empty query is an empty predicate, so the scope alone decides', () => {
    expect(DeliveriesService.filterWhere({})).toEqual({});
  });
});

/** A compile-time-ish reminder that the detail DTO really extends the list one. */
it('the detail response is a superset of the list response', async () => {
  const { deliveries, context } = await ledgerHarness();
  const detail: DeliveryDetailDto = await deliveries.get(context, LEDGER.deliveryOrderA1);
  const page = await deliveries.list(context, ALL);
  const summary = page.data.find((delivery) => delivery.id === detail.id);

  expect(summary).toBeDefined();
  for (const key of Object.keys(summary ?? {})) {
    expect(detail).toHaveProperty(key);
  }
});
