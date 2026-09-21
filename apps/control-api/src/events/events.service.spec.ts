import { CROSS_TENANT_MESSAGE, MAX_PAGE_SIZE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { MAX_REPLAY_FAN_OUT } from '../deliveries/delivery-limits';
import {
  BINARY_PAYLOAD,
  LEDGER,
  T,
  WIDE_ENDPOINTS,
  allDeliveries,
  ledgerHarness,
  rawDelivery,
} from '../deliveries/testing/harness';
import { historyWrites } from '../deliveries/testing/rich-fake';
import { PAYLOAD_NOTICE } from './event-payload';

const ALL = { limit: MAX_PAGE_SIZE } as const;

describe('listing events', () => {
  it('returns this project only, newest first, in the three-field envelope', async () => {
    const { events, context } = await ledgerHarness();

    const page = await events.list(context, ALL);

    expect(Object.keys(page).sort()).toEqual(['data', 'has_more', 'next_offset']);
    const ids = page.data.map((event) => event.id);
    expect(ids).toContain(LEDGER.eventOrder);
    // Organization B and project A2 both have an `order.created` in the table.
    expect(ids).not.toContain(IDS.eventB1);
    expect(ids).not.toContain(LEDGER.eventOtherProject);

    const timestamps = page.data.map((event) => Date.parse(event.created_at));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it('never inlines a payload in a listing', async () => {
    const { events, context } = await ledgerHarness();

    const page = await events.list(context, ALL);

    for (const event of page.data) {
      expect(event).not.toHaveProperty('payload');
      // ...but a listing can still say how big it was and whether it is inline.
      expect(typeof event.payload_size).toBe('number');
      expect(typeof event.payload_inline).toBe('boolean');
    }
    expect(page.data.find((event) => event.id === LEDGER.eventOffloaded)?.payload_inline).toBe(
      false,
    );
  });

  it('filters by event type and by ingest status', async () => {
    const { events, context } = await ledgerHarness();

    const settled = await events.list(context, { ...ALL, event_type: 'payment.settled' });
    expect(settled.data.map((event) => event.id)).toEqual([LEDGER.eventSettled]);

    const processed = await events.list(context, { ...ALL, status: 'processed' });
    expect(processed.data.every((event) => event.status === 'processed')).toBe(true);
  });

  it('searches the idempotency key case-insensitively, on a fragment', async () => {
    const { events, context } = await ledgerHarness();

    // The producer says "I sent order 41f9". The stored key is upper case.
    const found = await events.list(context, { ...ALL, idempotency_key: '41f9' });

    expect(found.data.map((event) => event.id)).toEqual([LEDGER.eventSettled]);
    expect(found.data[0].idempotency_key).toBe('idem-ORDER-41F9');
  });

  it('the idempotency search is still fenced by the tenant', async () => {
    const { events, context } = await ledgerHarness();

    // `idem-order-0001` exists in project A1 AND in project A2, same organization.
    const found = await events.list(context, { ...ALL, idempotency_key: 'idem-order-0001' });

    expect(found.data.map((event) => event.id)).toEqual([LEDGER.eventOrder]);
  });

  it('the date range is [after, before) so adjacent windows tile', async () => {
    const { events, context } = await ledgerHarness();

    const before = await events.list(context, { ...ALL, created_before: T.settled });
    const after = await events.list(context, { ...ALL, created_after: T.settled });

    const overlap = before.data
      .map((event) => event.id)
      .filter((id) => after.data.some((event) => event.id === id));
    expect(overlap).toEqual([]);
    expect(after.data.map((event) => event.id)).toContain(LEDGER.eventSettled);
    expect(before.data.map((event) => event.id)).toEqual([LEDGER.eventOrder]);
  });

  it('has_more and next_offset are exact at the page boundary', async () => {
    const { events, context } = await ledgerHarness();
    const total = (await events.list(context, ALL)).data.length;
    expect(total).toBeGreaterThan(2);

    const short = await events.list(context, { limit: total - 1 });
    expect(short.has_more).toBe(true);
    expect(short.next_offset).toBe(total - 1);

    // A full page that happens to be the last one. `rows.length === take` would
    // get this wrong; the probe row is what makes it right.
    const exact = await events.list(context, { limit: total });
    expect(exact.data).toHaveLength(total);
    expect(exact.has_more).toBe(false);
    expect(exact.next_offset).toBeNull();
  });
});

/**
 * The rollup: what became of the event, as opposed to what became of the
 * ingest.
 *
 * `Event.status` answers "did we store it and work out who wanted it?" and
 * stops there. Every assertion below is about the difference between that and
 * "did anybody receive it?", which is the question the list is actually asked.
 */
describe('the delivery rollup on a listing', () => {
  const rollupOf = async (eventId: string) => {
    const { events, context } = await ledgerHarness();
    const page = await events.list(context, ALL);
    return page.data.find((event) => event.id === eventId)?.deliveries;
  };

  it('an event whose fan-out matched nothing is DROPPED, not delivered', async () => {
    // `status: processed` and zero deliveries. Read off `status` alone this
    // event looks finished and fine; it reached nobody. This is the state
    // newcomers actually hit, and it is invisible in every other column
    // because there is no delivery row to be absent from.
    const rollup = await rollupOf(LEDGER.eventOrphan);
    expect(rollup?.state).toBe('dropped');
    expect(rollup?.total).toBe(0);
  });

  it('an event with one success and one exhausted is PARTLY DELIVERED', async () => {
    const rollup = await rollupOf(LEDGER.eventOrder);
    expect(rollup?.state).toBe('partly_delivered');
    expect(rollup?.succeeded).toBe(1);
    expect(rollup?.failed).toBe(1);
    expect(rollup?.total).toBe(2);
  });

  it('an event with a delivery still retrying is IN PROGRESS', async () => {
    const rollup = await rollupOf(LEDGER.eventSettled);
    expect(rollup?.state).toBe('in_progress');
    expect(rollup?.in_flight).toBeGreaterThan(0);
  });

  it('counts only this event, never the neighbour above it in the page', async () => {
    // The whole rollup is one grouped query over the page's ids. An off-by-a-
    // key here would attribute one event's failures to another, which is the
    // one error this column must not make.
    const { events, context } = await ledgerHarness();
    const page = await events.list(context, ALL);

    for (const event of page.data) {
      const rollup = event.deliveries;
      expect(rollup).not.toBeNull();
      expect(rollup!.total).toBe(
        rollup!.succeeded + rollup!.failed + rollup!.in_flight + rollup!.cancelled,
      );
    }
  });

  it('does not issue one query per event', async () => {
    // The N+1 the paged grouped query exists to avoid. A page of 50 events
    // costing 50 round trips is how a list route becomes the slowest thing in
    // the product.
    const { events, context, db } = await ledgerHarness();
    db.queries.length = 0;
    const page = await events.list(context, ALL);

    const groupBys = db.queries.filter(
      (query) => query.table === 'delivery' && query.op === 'groupBy',
    );
    expect(groupBys.length).toBeLessThan(page.data.length);
    expect(groupBys.length).toBeGreaterThan(0);
  });
});

describe('fetching one event', () => {
  it('returns the AUTHORITATIVE raw bytes as the payload, and labels the jsonb copy', async () => {
    const { events, context } = await ledgerHarness();

    const event = await events.get(context, LEDGER.eventSettled);

    // The raw body: whitespace and key order exactly as received. This is what
    // was signed.
    expect(event.payload.source).toBe('inline');
    expect(event.payload.body).toBe('{ "b": 2,\n  "a": 1 }');
    expect(event.payload.encoding).toBe('utf-8');
    // The jsonb copy: same meaning, different bytes. Present, and explicitly
    // not presented as what was delivered.
    expect(event.payload.normalised_json).toEqual({ a: 1, b: 2 });
    expect(JSON.stringify(event.payload.normalised_json)).not.toBe(event.payload.body);
    expect(event.payload.notice).toBe(PAYLOAD_NOTICE.inline);
    expect(event.payload.sha256).toBe(`sha256-of-${LEDGER.eventSettled}`);
  });

  it('reports an offloaded payload honestly instead of as an empty body', async () => {
    const { events, context } = await ledgerHarness();

    const event = await events.get(context, LEDGER.eventOffloaded);

    expect(event.payload.source).toBe('object_storage');
    expect(event.payload.body).toBeNull();
    expect(event.payload.location).toBe('s3://payloads/proj_a1/evt_a_big.json');
    expect(event.payload.size_bytes).toBe(4_194_304);
    expect(event.payload.notice).toBe(PAYLOAD_NOTICE.object_storage);
    expect(event.payload_inline).toBe(false);
  });

  it('base64-encodes a payload that is not valid UTF-8', async () => {
    const { events, context } = await ledgerHarness();

    const event = await events.get(context, LEDGER.eventBinary);

    expect(event.payload.encoding).toBe('base64');
    expect(Buffer.from(event.payload.body ?? '', 'base64')).toEqual(Buffer.from(BINARY_PAYLOAD));
  });

  it('redacts the ingest credential out of the request headers', async () => {
    const { events, context } = await ledgerHarness();

    const event = await events.get(context, LEDGER.eventOrder);

    // `events.read` is a viewer permission; `api-keys.read` is not. The
    // Authorization header on an ingest call carries the project's live key.
    expect(event.headers?.authorization).toBe('[redacted]');
    expect(event.headers?.['content-type']).toBe('application/json');
  });

  const missing: Array<[string, string]> = [
    ["another organization's event", IDS.eventB1],
    ["another project's event in the same organization", LEDGER.eventOtherProject],
    ['an event that does not exist', 'evt_nope'],
  ];

  it.each(missing)('%s is one 404 with one message', async (_name, id) => {
    const { events, context } = await ledgerHarness();

    const error = await events.get(context, id).catch((err: AppError) => err);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });

  it.each(missing)('the deliveries of %s are one 404 with one message', async (_name, id) => {
    const { events, context } = await ledgerHarness();

    const error = await events.listDeliveries(context, id, {}).catch((err: AppError) => err);

    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });
});

describe('the fan-out of one event - "did finance ever receive this?"', () => {
  it('lists one row per endpoint the event reached, with per-endpoint status', async () => {
    const { events, context } = await ledgerHarness();

    const page = await events.listDeliveries(context, LEDGER.eventOrder, ALL);

    expect(
      page.data.map((delivery) => [delivery.endpoint_id, delivery.status]).sort(),
    ).toEqual(
      [
        [LEDGER.endpointA1, 'succeeded'],
        [LEDGER.endpointFinance, 'exhausted'],
      ].sort(),
    );
  });

  it('an event that matched nothing lists nothing - and says so with an empty page', async () => {
    const { events, context } = await ledgerHarness();

    const page = await events.listDeliveries(context, LEDGER.eventOrphan, ALL);

    // Distinct from a 404: the event IS yours, it just never went anywhere.
    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
  });

  it('an `event_id` in the query cannot widen the route to another event', async () => {
    const { events, context } = await ledgerHarness();

    const page = await events.listDeliveries(context, LEDGER.eventOrder, {
      ...ALL,
      event_id: LEDGER.eventSettled,
    });

    expect(page.data.every((delivery) => delivery.event_id === LEDGER.eventOrder)).toBe(true);
  });
});

describe('replaying an event to all originally matched endpoints', () => {
  it('creates one new delivery per original and leaves every original identical', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const result = await harness.events.replay(harness.context, LEDGER.eventOrder, {
      reason: 'consumer outage, re-sending the backlog',
    });

    expect(result.replayed_count).toBe(2);
    expect(result.replay_of.sort()).toEqual(
      [LEDGER.deliveryOrderA1, LEDGER.deliveryOrderFinance].sort(),
    );
    expect(
      result.deliveries.map((delivery) => delivery.endpoint_id).sort(),
    ).toEqual([LEDGER.endpointA1, LEDGER.endpointFinance].sort());

    // THE PROPERTY: every pre-existing row is byte-identical afterwards.
    const createdIds = new Set(result.deliveries.map((delivery) => delivery.id));
    const after = allDeliveries(harness.db).filter((row) => !createdIds.has(String(row.id)));
    expect(after).toEqual(before);
    expect(historyWrites(harness.db)).toEqual([]);
  });

  it('uses the endpoints that ACTUALLY matched, not a fresh subscription match', async () => {
    const harness = await ledgerHarness();

    // The subscriptions have moved on since the fan-out, in both directions:
    // the one that produced the original delivery is gone, and a new endpoint
    // now subscribes to everything. A re-match would deliver to `ep_a_new` -
    // which was never targeted - and skip `ep_a1`, which was.
    harness.db.rows('webhookSubscription').delete(IDS.subscriptionA1);
    harness.db.insert('endpoint', {
      id: 'ep_a_new',
      projectId: IDS.projectA1,
      name: 'added yesterday',
      url: 'https://new.example.com/hook',
      status: 'active',
      enabled: true,
      createdAt: T.wide,
      updatedAt: T.wide,
    });
    harness.db.insert('webhookSubscription', {
      id: 'sub_a_new',
      projectId: IDS.projectA1,
      endpointId: 'ep_a_new',
      eventTypes: ['*'],
      enabled: true,
    });

    const result = await harness.events.replay(harness.context, LEDGER.eventOrder, {});

    const targeted = result.deliveries.map((delivery) => delivery.endpoint_id).sort();
    expect(targeted).toEqual([LEDGER.endpointA1, LEDGER.endpointFinance].sort());
    expect(targeted).not.toContain('ep_a_new');
  });

  it('replays originals only, so replaying twice does not compound', async () => {
    const harness = await ledgerHarness();

    const first = await harness.events.replay(harness.context, LEDGER.eventOrder, {});
    const second = await harness.events.replay(harness.context, LEDGER.eventOrder, {});

    expect(first.replayed_count).toBe(2);
    // Not 4. The selection is `replay_of_delivery_id IS NULL`, so the rows the
    // first call created are not themselves replayed by the second.
    expect(second.replayed_count).toBe(2);
    expect(second.replay_of.sort()).toEqual(first.replay_of.sort());
  });

  it('refuses an event that reached no endpoint at all', async () => {
    const harness = await ledgerHarness();

    const error = await harness.events
      .replay(harness.context, LEDGER.eventOrphan, {})
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).message).toContain('no deliveries to replay');
    expect(harness.db.all('delivery').filter((row) => row.replayOfDeliveryId !== null)).toEqual([]);
  });

  it('refuses the whole fan-out when ONE endpoint has been deleted', async () => {
    const harness = await ledgerHarness();
    const before = allDeliveries(harness.db);

    const error = await harness.events
      .replay(harness.context, LEDGER.eventSettled, {})
      .catch((err: AppError) => err);

    // All-or-nothing: the live endpoint is not half-replayed while the deleted
    // one errors, and the error names the endpoint that caused it.
    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).details).toMatchObject({ endpoint_id: LEDGER.endpointDeleted });
    expect(allDeliveries(harness.db)).toEqual(before);
  });

  it('refuses a fan-out wider than the cap, and names the real number', async () => {
    const harness = await ledgerHarness();

    const error = await harness.events
      .replay(harness.context, LEDGER.eventWide, {})
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('limit_exceeded');
    expect((error as AppError).details).toEqual({
      limit: MAX_REPLAY_FAN_OUT,
      current: WIDE_ENDPOINTS,
      resource: 'replay_fan_out',
    });
    expect(harness.db.all('delivery').filter((row) => row.replayOfDeliveryId !== null)).toEqual([]);
  });

  it('records one audit entry naming every row it created and replayed', async () => {
    const harness = await ledgerHarness();

    const result = await harness.events.replay(harness.context, LEDGER.eventOrder, {
      reason: 'ticket 8812',
    });

    const entries = harness.db.all('auditLog');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'event.replayed',
      resourceType: 'event',
      resourceId: LEDGER.eventOrder,
      userId: IDS.ownerA,
    });
    expect(entries[0].metadata).toMatchObject({
      reason: 'ticket 8812',
      target: 'all_originally_matched',
      requested_endpoint_id: null,
      replayed_count: 2,
      created_delivery_ids: result.deliveries.map((delivery) => delivery.id),
    });
  });
});

describe('replaying an event to one endpoint', () => {
  it('replays that endpoint only, from its original delivery', async () => {
    const harness = await ledgerHarness();
    const before = rawDelivery(harness.db, LEDGER.deliveryOrderFinance);

    const result = await harness.events.replay(harness.context, LEDGER.eventOrder, {
      endpoint_id: LEDGER.endpointFinance,
    });

    expect(result.replayed_count).toBe(1);
    expect(result.deliveries[0].endpoint_id).toBe(LEDGER.endpointFinance);
    expect(result.deliveries[0].replay_of_delivery_id).toBe(LEDGER.deliveryOrderFinance);
    expect(rawDelivery(harness.db, LEDGER.deliveryOrderFinance)).toEqual(before);
    expect(historyWrites(harness.db)).toEqual([]);
  });

  it('picks the ORIGINAL even after the pair has been replayed before', async () => {
    const harness = await ledgerHarness();
    const first = await harness.events.replay(harness.context, LEDGER.eventOrder, {
      endpoint_id: LEDGER.endpointFinance,
    });

    const second = await harness.events.replay(harness.context, LEDGER.eventOrder, {
      endpoint_id: LEDGER.endpointFinance,
    });

    // Both point at the original, not at each other: the partial unique index
    // guarantees exactly one row with `replay_of_delivery_id IS NULL` per pair.
    expect(first.deliveries[0].replay_of_delivery_id).toBe(LEDGER.deliveryOrderFinance);
    expect(second.deliveries[0].replay_of_delivery_id).toBe(LEDGER.deliveryOrderFinance);
    expect(second.deliveries[0].id).not.toBe(first.deliveries[0].id);
  });

  it('refuses an endpoint this event never reached', async () => {
    const harness = await ledgerHarness();

    // `ep_a_finance` is a real endpoint in this project - it just never received
    // `payment.settled`.
    const error = await harness.events
      .replay(harness.context, LEDGER.eventSettled, { endpoint_id: LEDGER.endpointFinance })
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).message).toContain('never fanned out');
    expect((error as AppError).details).toMatchObject({
      event_id: LEDGER.eventSettled,
      endpoint_id: LEDGER.endpointFinance,
    });
  });

  it("another tenant's endpoint id is the shared 404, never a 409", async () => {
    const harness = await ledgerHarness();

    const error = await harness.events
      .replay(harness.context, LEDGER.eventOrder, { endpoint_id: IDS.endpointB1 })
      .catch((err: AppError) => err);

    // A 409 saying "this event never reached that endpoint" would confirm the
    // id names a live endpoint somewhere.
    expect((error as AppError).code).toBe('not_found');
    expect((error as AppError).message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('refuses a deleted endpoint with the reason rather than queueing to nowhere', async () => {
    const harness = await ledgerHarness();

    const error = await harness.events
      .replay(harness.context, LEDGER.eventSettled, { endpoint_id: LEDGER.endpointDeleted })
      .catch((err: AppError) => err);

    expect((error as AppError).code).toBe('conflict');
    expect((error as AppError).message).toContain('deleted');
    expect((error as AppError).details).toMatchObject({ endpoint_status: 'deleted' });
  });
});
