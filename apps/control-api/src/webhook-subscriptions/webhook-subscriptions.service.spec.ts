import { Prisma } from '@prisma/client';
import { CROSS_TENANT_MESSAGE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError, ErrorCode } from '../common/errors';
import { CreateSubscriptionDto } from './dto';
import { SUB_IDS, harnessFor } from './testing/harness';

async function expectError(
  promise: Promise<unknown>,
  code: ErrorCode,
  message?: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const error = err as AppError;
    expect(error.code).toBe(code);
    if (message !== undefined) expect(error.message).toBe(message);
    return error;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

const BODY: CreateSubscriptionDto = {
  endpoint_id: IDS.endpointA1,
  event_types: ['payment.settled'],
};

describe('WebhookSubscriptionsService - tenant isolation', () => {
  it('answers 404, with the layer message, for a subscription in another tenant', async () => {
    const { subscriptions, context } = await harnessFor();
    await expectError(subscriptions.get(context, SUB_IDS.b1), 'not_found', CROSS_TENANT_MESSAGE);
  });

  it('gives an absent id and a foreign id the same answer, byte for byte', async () => {
    const { subscriptions, context } = await harnessFor();
    const messages: string[] = [];
    for (const id of [SUB_IDS.b1, 'sub_does_not_exist']) {
      messages.push((await expectError(subscriptions.get(context, id), 'not_found')).message);
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(CROSS_TENANT_MESSAGE);
  });

  /**
   * THE ONE THE SECURITY REVIEW NAMED. `endpoint_id` is the only field on this
   * resource that points at another table. Unchecked, a subscription would be
   * stamped with the caller's project while pointing at another customer's
   * endpoint - or at an attacker's URL, from inside the victim's project.
   */
  it('refuses to create a subscription bound to another tenant endpoint', async () => {
    const { subscriptions, context, db } = await harnessFor();
    const before = db.rows('webhookSubscription').size;

    await expectError(
      subscriptions.create(context, { ...BODY, endpoint_id: IDS.endpointB1 }),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );

    // Refused BEFORE the insert, not compensated afterwards.
    expect(db.rows('webhookSubscription').size).toBe(before);
  });

  it('refuses to re-point an existing subscription at another tenant endpoint', async () => {
    const { subscriptions, context, db } = await harnessFor();
    await expectError(
      subscriptions.update(context, SUB_IDS.a1, { endpoint_id: IDS.endpointB1 }),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );
    expect(db.rows('webhookSubscription').get(SUB_IDS.a1)).toMatchObject({
      endpointId: IDS.endpointA1,
    });
  });

  /**
   * The cross-tenant endpoint and the cross-tenant subscription must answer with
   * the SAME string. `ScopedRepository` says "Endpoint not found." for one and
   * "Subscription not found." for the other; a 404 that says what an id IS
   * confirms the id is live infrastructure belonging to another customer.
   */
  it('does not let a caller tell a foreign endpoint id from a foreign subscription id', async () => {
    const { subscriptions, context } = await harnessFor();
    const viaEndpoint = await expectError(
      subscriptions.create(context, { ...BODY, endpoint_id: IDS.endpointB1 }),
      'not_found',
    );
    const viaSubscription = await expectError(
      subscriptions.get(context, SUB_IDS.b1),
      'not_found',
    );
    expect(viaEndpoint.message).toBe(viaSubscription.message);
  });

  it('refuses to update or delete another tenant subscription, and leaves it untouched', async () => {
    const { subscriptions, context, db } = await harnessFor();
    await expectError(
      subscriptions.update(context, SUB_IDS.b1, { event_types: ['*'] }),
      'not_found',
    );
    await expectError(subscriptions.disable(context, SUB_IDS.b1), 'not_found');
    // Delete is idempotent, so a foreign id is a silent no-op rather than a 404
    // - the important part is that the row survives.
    await subscriptions.remove(context, SUB_IDS.b1);
    expect(db.rows('webhookSubscription').get(SUB_IDS.b1)).toMatchObject({
      eventTypes: ['*'],
      enabled: true,
    });
  });

  it('lists only this project subscriptions', async () => {
    const { subscriptions, context, db } = await harnessFor();
    expect(db.all('webhookSubscription')).toHaveLength(3);
    const listed = await subscriptions.list(context, {});
    expect(listed.data.map((row) => row.id).sort()).toEqual([SUB_IDS.a1, SUB_IDS.a2].sort());
    expect(listed).toMatchObject({ has_more: false, next_offset: null });
  });

  it('404s a list filtered by another tenant endpoint rather than answering empty', async () => {
    const { subscriptions, context } = await harnessFor();
    await expectError(
      subscriptions.list(context, { endpoint_id: IDS.endpointB1 }),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );
  });
});

describe('WebhookSubscriptionsService - filters are never widened', () => {
  it('stores the event types exactly as given, and reads them back unchanged', async () => {
    const { subscriptions, context, db } = await harnessFor();
    const types = ['payment.settled', 'payment.failed', 'refund.*'];

    const created = await subscriptions.create(context, { ...BODY, event_types: types });

    expect(created.event_types).toEqual(types);
    expect(db.rows('webhookSubscription').get(created.id)).toMatchObject({ eventTypes: types });
    expect((await subscriptions.get(context, created.id)).event_types).toEqual(types);
  });

  /**
   * The whole point. Every one of these is refused with a 400 naming the field.
   * Not one of them becomes `["*"]`, and not one of them is stored as something
   * the router would read differently.
   */
  it.each([
    ['an empty array', []],
    ['a bare star suffix', ['pay*']],
    ['a leading wildcard', ['*.settled']],
    ['a dot-star with no prefix', ['.*']],
    ['"*" mixed with a named type', ['*', 'payment.settled']],
    ['whitespace the router would never match', ['payment.settled ']],
    ['a duplicate', ['payment.settled', 'payment.settled']],
  ])('refuses %s on create rather than widening it', async (_name, eventTypes) => {
    const { subscriptions, context, db } = await harnessFor();
    const before = db.rows('webhookSubscription').size;

    const error = await expectError(
      subscriptions.create(context, { ...BODY, event_types: eventTypes as string[] }),
      'invalid_request',
    );
    expect(error.details).toMatchObject({ field: 'event_types' });
    expect(db.rows('webhookSubscription').size).toBe(before);
  });

  it('refuses the same things on update, and leaves the stored filter alone', async () => {
    const { subscriptions, context, db } = await harnessFor();
    await expectError(
      subscriptions.update(context, SUB_IDS.a2, { event_types: [] }),
      'invalid_request',
    );
    await expectError(
      subscriptions.update(context, SUB_IDS.a2, { event_types: ['pay*'] }),
      'invalid_request',
    );
    // Untouched: not widened, not emptied.
    expect(db.rows('webhookSubscription').get(SUB_IDS.a2)).toMatchObject({
      eventTypes: ['payment.settled'],
    });
  });

  /**
   * `@IsOptional()` skips every other validator for `null` as well as
   * `undefined`, so a PATCH body of `{"event_types": null}` walks past the DTO
   * constraint. The service asserts it again for exactly this reason.
   */
  it('refuses a null event_types that got past the DTO', async () => {
    const { subscriptions, context } = await harnessFor();
    await expectError(
      subscriptions.update(context, SUB_IDS.a1, {
        event_types: null as unknown as string[],
      }),
      'invalid_request',
    );
  });

  it('records both sides of a filter change in the audit log', async () => {
    const { subscriptions, context, db } = await harnessFor();

    await subscriptions.update(context, SUB_IDS.a2, { event_types: ['*'] });

    const entry = db.all('auditLog').find((row) => row.action === 'subscription.updated');
    expect(entry).toMatchObject({
      organizationId: IDS.orgA,
      userId: IDS.ownerA,
      resourceType: 'subscription',
      resourceId: SUB_IDS.a2,
    });
    // "Who widened this, and when?" is the question asked after a leak, and it
    // must be answerable without a database session.
    expect(entry?.metadata).toMatchObject({
      event_types_from: ['payment.settled'],
      event_types_to: ['*'],
      project_id: IDS.projectA1,
    });
  });
});

describe('WebhookSubscriptionsService - payload filters', () => {
  it('stores a valid predicate and returns it unchanged', async () => {
    const { subscriptions, context } = await harnessFor();
    const filter = { 'data.currency': 'GHS', 'data.amount': { $gte: 1000 } };

    const created = await subscriptions.create(context, { ...BODY, payload_filter: filter });

    expect(created.payload_filter).toEqual(filter);
  });

  it('refuses an unbounded or malformed predicate', async () => {
    const { subscriptions, context } = await harnessFor();
    for (const filter of [
      {},
      { status: { $regex: '^s' } },
      { 'a b': 1 },
      { x: 'y'.repeat(5000) },
    ]) {
      const error = await expectError(
        subscriptions.create(context, {
          ...BODY,
          payload_filter: filter as Record<string, unknown>,
        }),
        'invalid_request',
      );
      expect(error.details).toMatchObject({ field: 'payload_filter' });
    }
  });

  /**
   * `Prisma.DbNull`, not `Prisma.JsonNull` and not a bare `null`.
   *
   * The column should be SQL NULL when there is no filter, not the JSON value
   * `null` - which reads back as present-but-null, makes "does this
   * subscription filter on the body?" unanswerable in SQL, and would be read by
   * the Go side as a filter it cannot evaluate (rule 7: fail closed, deliver
   * nothing). Asserted on what the service HANDS the repository, because the
   * fixture faithfully turns DbNull into the `null` PostgreSQL would give back.
   */
  it('writes Prisma.DbNull - SQL NULL - when there is no filter', async () => {
    const { subscriptions, context, db } = await harnessFor();
    const written: unknown[] = [];
    const create = db.webhookSubscription.create;
    db.webhookSubscription.create = async (args: { data: Record<string, unknown> }) => {
      written.push(args.data.payloadFilter);
      return create(args);
    };

    const created = await subscriptions.create(context, BODY);

    expect(written).toEqual([Prisma.DbNull]);
    expect(created.payload_filter).toBeNull();
  });

  it('clears a filter when null is sent, and leaves it alone when the field is absent', async () => {
    const { subscriptions, context } = await harnessFor();
    const created = await subscriptions.create(context, {
      ...BODY,
      payload_filter: { status: 'settled' },
    });

    const renamed = await subscriptions.update(context, created.id, { name: 'renamed' });
    expect(renamed.payload_filter).toEqual({ status: 'settled' });

    const cleared = await subscriptions.update(context, created.id, { payload_filter: null });
    expect(cleared.payload_filter).toBeNull();
  });
});

describe('WebhookSubscriptionsService - lifecycle', () => {
  it('creates enabled by default, bound to the named endpoint, and audits it', async () => {
    const { subscriptions, context, db } = await harnessFor();

    const created = await subscriptions.create(context, { ...BODY, name: 'finance' });

    expect(created).toMatchObject({
      project_id: IDS.projectA1,
      endpoint_id: IDS.endpointA1,
      name: 'finance',
      enabled: true,
    });
    expect(created.id).toMatch(/^sub_/);
    expect(created.created_at).toBe(created.updated_at);
    expect(db.all('auditLog').find((row) => row.action === 'subscription.created')).toMatchObject({
      resourceId: created.id,
    });
  });

  it('refuses to subscribe to a deleted endpoint, with a conflict rather than a 404', async () => {
    const { subscriptions, context } = await harnessFor();
    // 409, not 404: the endpoint IS visible to this caller through GET, so
    // hiding it here would be confusing rather than protective.
    const error = await expectError(
      subscriptions.create(context, { ...BODY, endpoint_id: SUB_IDS.endpointADeleted }),
      'conflict',
    );
    expect(error.message).toContain('could never deliver');
  });

  it('disables and re-enables without touching the filter', async () => {
    const { subscriptions, context, db } = await harnessFor();

    const disabled = await subscriptions.disable(context, SUB_IDS.a1, 'noisy consumer');
    expect(disabled).toMatchObject({ enabled: false, event_types: ['*'] });
    expect(
      db.all('auditLog').find((row) => row.action === 'subscription.disabled'),
    ).toMatchObject({ resourceId: SUB_IDS.a1 });

    const enabled = await subscriptions.enable(context, SUB_IDS.a1);
    expect(enabled).toMatchObject({ enabled: true, event_types: ['*'] });
  });

  it('is idempotent about enable and disable, and does not audit a no-op', async () => {
    const { subscriptions, context, db } = await harnessFor();
    await subscriptions.enable(context, SUB_IDS.a1); // already enabled
    expect(db.all('auditLog').filter((row) => row.action === 'subscription.enabled')).toHaveLength(
      0,
    );
  });

  it('re-points a subscription at another endpoint in the same project', async () => {
    const { subscriptions, context, db } = await harnessFor();

    const updated = await subscriptions.update(context, SUB_IDS.a1, {
      endpoint_id: SUB_IDS.endpointA2,
    });

    expect(updated.endpoint_id).toBe(SUB_IDS.endpointA2);
    expect(db.all('auditLog').find((row) => row.action === 'subscription.updated')?.metadata)
      .toMatchObject({
        endpoint_id_from: IDS.endpointA1,
        endpoint_id_to: SUB_IDS.endpointA2,
      });
  });

  it('treats an empty update as a no-op that returns the current row', async () => {
    const { subscriptions, context, db } = await harnessFor();
    const before = db.all('auditLog').length;
    const updated = await subscriptions.update(context, SUB_IDS.a2, {});
    expect(updated.event_types).toEqual(['payment.settled']);
    expect(db.all('auditLog')).toHaveLength(before);
  });
});

describe('WebhookSubscriptionsService - hard delete', () => {
  /**
   * The decision, asserted. Nothing has a foreign key to
   * `webhook_subscriptions` (`deliveries.subscription_id` is a bare nullable
   * TEXT column with no relation), the delivery ledger keeps its own
   * `endpoint_id` and `event_id`, and there is no status column a soft delete
   * could use. So the row really goes.
   */
  it('removes the row', async () => {
    const { subscriptions, context, db } = await harnessFor();
    await subscriptions.remove(context, SUB_IDS.a1);
    expect(db.rows('webhookSubscription').get(SUB_IDS.a1)).toBeUndefined();
    expect((await subscriptions.list(context, {})).data.map((row) => row.id)).toEqual([
      SUB_IDS.a2,
    ]);
  });

  /**
   * The price of the hard delete, paid at the moment it is taken: the entire
   * routing rule goes into `audit_logs`, so a historical
   * `deliveries.subscription_id` pointing at a row that no longer exists is
   * still explainable.
   */
  it('writes the whole routing rule to the audit log on the way out', async () => {
    const { subscriptions, context, db } = await harnessFor();
    const created = await subscriptions.create(context, {
      ...BODY,
      name: 'finance',
      event_types: ['payment.settled', 'refund.*'],
      payload_filter: { 'data.currency': 'GHS' },
    });

    await subscriptions.remove(context, created.id);

    const entry = db.all('auditLog').find((row) => row.action === 'subscription.deleted');
    expect(entry).toMatchObject({ resourceId: created.id, resourceType: 'subscription' });
    expect(entry?.metadata).toMatchObject({
      hard_delete: true,
      endpoint_id: IDS.endpointA1,
      name: 'finance',
      event_types: ['payment.settled', 'refund.*'],
      payload_filter: { 'data.currency': 'GHS' },
      enabled: true,
    });
  });

  it('is idempotent - deleting twice is not an error', async () => {
    const { subscriptions, context } = await harnessFor();
    await subscriptions.remove(context, SUB_IDS.a1);
    await expect(subscriptions.remove(context, SUB_IDS.a1)).resolves.toBeUndefined();
  });

  it('frees a slot against the ceiling', async () => {
    const { subscriptions, context } = await harnessFor(undefined, undefined, {
      maxSubscriptions: 2,
    });
    // Two already exist in project A1.
    await expectError(subscriptions.create(context, BODY), 'limit_exceeded');
    await subscriptions.remove(context, SUB_IDS.a2);
    await expect(subscriptions.create(context, BODY)).resolves.toMatchObject({ enabled: true });
  });
});

describe('WebhookSubscriptionsService - the ceiling', () => {
  it('refuses a create at the ceiling and names the numbers', async () => {
    const { subscriptions, context } = await harnessFor(undefined, undefined, {
      maxSubscriptions: 2,
    });
    const error = await expectError(subscriptions.create(context, BODY), 'limit_exceeded');
    // The DETAILS are the contract. A client must never have to read the
    // sentence to tell a ceiling from a duplicate or a deleted endpoint.
    expect(error.details).toMatchObject({ limit: 2, current: 2, resource: 'subscriptions' });
    expect(error.message).toContain('MAX_SUBSCRIPTIONS_PER_PROJECT');
  });

  it('counts only this project rows', async () => {
    // Project A1 holds two; project B1 holds one. A ceiling of 3 must leave A1
    // with one slot, not zero.
    const { subscriptions, context } = await harnessFor(undefined, undefined, {
      maxSubscriptions: 3,
    });
    await expect(subscriptions.create(context, BODY)).resolves.toBeDefined();
    await expectError(subscriptions.create(context, BODY), 'limit_exceeded');
  });
});

describe('WebhookSubscriptionsService - pagination', () => {
  /**
   * The page boundary is where a bounded read lies about being complete. The
   * whole point of `findPage` over `findMany` is that `has_more` makes "I saw
   * all of them" expressible - so it is asserted at exactly the size where a
   * bare array would be indistinguishable from a full result.
   */
  it('is correct at the page boundary', async () => {
    const { subscriptions, context } = await harnessFor(undefined, undefined, {
      maxSubscriptions: 50,
    });
    // Two seeded plus three created: five rows, paged three at a time.
    for (const suffix of ['a', 'b', 'c']) {
      await subscriptions.create(context, { ...BODY, name: suffix });
    }

    const first = await subscriptions.list(context, { limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first).toMatchObject({ has_more: true, next_offset: 3 });

    const second = await subscriptions.list(context, { limit: 3, offset: first.next_offset ?? 0 });
    expect(second.data).toHaveLength(2);
    expect(second).toMatchObject({ has_more: false, next_offset: null });

    // No row is repeated and none is missed.
    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('says has_more=false when the last page is exactly full', async () => {
    const { subscriptions, context } = await harnessFor();
    // Exactly two rows in project A1, asked for exactly two.
    const page = await subscriptions.list(context, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page).toMatchObject({ has_more: false, next_offset: null });
  });

  it('filters by endpoint and by enabled', async () => {
    const { subscriptions, context } = await harnessFor();
    const byEndpoint = await subscriptions.list(context, { endpoint_id: SUB_IDS.endpointA2 });
    expect(byEndpoint.data.map((row) => row.id)).toEqual([SUB_IDS.a2]);

    const enabled = await subscriptions.list(context, { enabled: true });
    expect(enabled.data.map((row) => row.id)).toEqual([SUB_IDS.a1]);

    const disabled = await subscriptions.list(context, { enabled: false });
    expect(disabled.data.map((row) => row.id)).toEqual([SUB_IDS.a2]);
  });
});
