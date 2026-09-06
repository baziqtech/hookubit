import { AppError, ErrorCode } from '../common/errors';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { TenantScope, TenantScopeFactory } from './tenant-scope.factory';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './tenant-scope';
import { IDS, requestWith, seedWorld, sessionUser } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

/**
 * The scope is always built the way production builds it - by resolving a real
 * request through `TenantResolver` - so these tests exercise the whole path a
 * Phase 2 service will take, not a hand-made context that could be wrong in the
 * caller's favour.
 */
async function scopeFor(
  userId: string,
  params: Record<string, string>,
): Promise<{ db: FakeTenantPrisma; scope: TenantScope; context: RequestContext }> {
  const db = seedWorld();
  const resolver = new TenantResolver(db.asPrisma());
  const context = await resolver.resolve(
    sessionUser(userId),
    requestWith(params, userId),
    DEFAULT_TENANT_SPEC,
  );
  const scope = new TenantScopeFactory(db.asPrisma()).for(context);
  return { db, scope, context };
}

describe('ScopedRepository - project-scoped tables', () => {
  it('lists only this project rows, with the other tenant sitting in the same table', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    expect(db.all('endpoint')).toHaveLength(2);

    const endpoints = await scope.endpoints.findMany();
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([IDS.endpointA1]);
  });

  it('returns null rather than the row for another tenant id', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    expect(await scope.endpoints.findById(IDS.endpointB1)).toBeNull();
    expect(await scope.endpoints.findById(IDS.endpointA1)).not.toBeNull();
  });

  it('raises not_found - never forbidden - for another tenant id', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(scope.endpoints.requireById(IDS.endpointB1), 'not_found');
  });

  it('gives an absent id and a foreign id the same answer', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const messages: string[] = [];
    for (const id of [IDS.endpointB1, 'ep_does_not_exist']) {
      await scope.endpoints.requireById(id).catch((err: AppError) => messages.push(err.message));
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });

  it('cannot be escaped by a caller-supplied where clause naming another tenant', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    // ANDed, not replaced: {projectId: mine} AND {projectId: theirs} = nothing.
    expect(await scope.endpoints.findMany({ where: { projectId: IDS.projectB1 } })).toEqual([]);
    expect(await scope.endpoints.count({ projectId: IDS.projectB1 })).toBe(0);
  });

  it('cannot be escaped by an OR clause either', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const found = await scope.endpoints.findMany({
      where: { OR: [{ id: IDS.endpointA1 }, { id: IDS.endpointB1 }] },
    });
    expect(found.map((endpoint) => endpoint.id)).toEqual([IDS.endpointA1]);
  });

  it('creates into the resolved project, with no way to name another one', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    const created = await scope.endpoints.create({
      id: 'ep_new',
      name: 'new',
      url: 'https://example.com/hook',
    });
    expect(created.projectId).toBe(IDS.projectA1);
    expect(db.rows('endpoint').get('ep_new')?.projectId).toBe(IDS.projectA1);
  });

  it('refuses to update another tenant row, and leaves it untouched', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    await expectCode(scope.endpoints.updateById(IDS.endpointB1, { name: 'pwned' }), 'not_found');
    expect(db.rows('endpoint').get(IDS.endpointB1)?.name).toBe('b1');
  });

  it('updates its own row and returns the persisted state', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const updated = await scope.endpoints.updateById(IDS.endpointA1, { name: 'renamed' });
    expect(updated.name).toBe('renamed');
  });

  it('refuses to delete another tenant row, and leaves it in place', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    await expectCode(scope.endpoints.deleteById(IDS.endpointB1), 'not_found');
    expect(db.rows('endpoint').has(IDS.endpointB1)).toBe(true);
  });

  it('bulk updates stay inside the tenant', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    const count = await scope.endpoints.updateMany({ status: 'active' }, { status: 'paused' });
    expect(count).toBe(1);
    expect(db.rows('endpoint').get(IDS.endpointB1)?.status).toBe('active');
  });
});

describe('ScopedRepository - nested ownership chains', () => {
  it('scopes endpoint secrets through their endpoint', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const secrets = await scope.endpointSecrets.findMany();
    expect(secrets.map((secret) => secret.id)).toEqual([IDS.secretA1]);
    await expectCode(scope.endpointSecrets.requireById(IDS.secretB1), 'not_found');
  });

  it('scopes delivery attempts through delivery -> endpoint -> project', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const attempts = await scope.deliveryAttempts.findMany();
    expect(attempts.map((attempt) => attempt.id)).toEqual([IDS.attemptA1]);
    await expectCode(scope.deliveryAttempts.requireById(IDS.attemptB1), 'not_found');
  });

  it('refuses to create a row whose tenancy comes from a parent', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpointSecrets.create({
        id: 'eps_new',
        endpointId: IDS.endpointA1,
        secretEncrypted: 'v1.k1.x.y.z',
        version: 2,
      }),
      'internal_error',
    );
  });
});

describe('ScopedRepository - organization-level routes', () => {
  it('spans every project in the organization, and stops at its boundary', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA });
    db.insert('endpoint', {
      id: 'ep_a2',
      projectId: IDS.projectA2,
      name: 'a2',
      url: 'https://a2.example.com',
      status: 'active',
    });

    const endpoints = await scope.endpoints.findMany();
    expect(endpoints.map((endpoint) => endpoint.id).sort()).toEqual([IDS.endpointA1, 'ep_a2']);
    expect(await scope.endpoints.findById(IDS.endpointB1)).toBeNull();
  });

  it('scopes projects to the organization', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA });
    const projects = await scope.projects.findMany();
    expect(projects.every((project) => project.organizationId === IDS.orgA)).toBe(true);
    expect(await scope.projects.findById(IDS.projectB1)).toBeNull();
  });

  it('scopes members to the organization', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA });
    const members = await scope.members.findMany();
    expect(members).toHaveLength(5);
    expect(members.every((member) => member.organizationId === IDS.orgA)).toBe(true);
  });

  it('refuses a project-scoped create when the route resolved no project', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA });
    await expectCode(
      scope.endpoints.create({ id: 'ep_x', name: 'x', url: 'https://x.example.com' }),
      'internal_error',
    );
  });
});

describe('ScopedRepository - events and deliveries', () => {
  it('scopes deliveries through the endpoint chain, not the denormalised columns', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const deliveries = await scope.deliveries.findMany();
    // FIX 3. del_corrupt claims org A and project A on its own columns while its
    // endpoint belongs to B. `TenantResolver` refuses it when it is addressed by
    // id, calling the disagreement a data-integrity bug; the listing used to
    // serve it anyway, which is the same repository disagreeing with the
    // resolver in the same directory. Both routes now refuse it.
    expect(deliveries.map((delivery) => delivery.id)).toEqual([IDS.deliveryA1]);
    expect(await scope.deliveries.findById(IDS.deliveryCorrupt)).toBeNull();
    expect(await scope.deliveries.findById(IDS.deliveryB1)).toBeNull();
  });

  it('does not leak the corrupt delivery one hop down either', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const attempts = await scope.deliveryAttempts.findMany();
    expect(attempts.map((attempt) => attempt.id)).toEqual([IDS.attemptA1]);
    await expectCode(scope.deliveryAttempts.requireById(IDS.attemptCorrupt), 'not_found');
  });

  it('scopes events', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    expect((await scope.events.findMany()).map((event) => event.id)).toEqual([IDS.eventA1]);
    await expectCode(scope.events.requireById(IDS.eventB1), 'not_found');
  });
});

/**
 * The write side. Every test below is the negative: the reviews found that the
 * two most natural calls a module author makes - `create` with a required
 * sibling foreign key, and `updateById` with a request body - were the two that
 * crossed the tenant boundary, while the types and docblocks said they were
 * safe. An author told "scoping is handled" does not then write the ownership
 * check they would have written from scratch, so each of these has to fail
 * loudly rather than merely be discouraged.
 *
 * `as never` casts below stand in for the JavaScript caller: the types now
 * reject these payloads at compile time, and the point of the test is that the
 * runtime rejects them too, because types are erased.
 */
describe('ScopedRepository - the tenant columns are not writable (FIX 1)', () => {
  it('refuses to move a row out of its tenant through updateById', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, { projectId: IDS.projectB1 } as never),
      'invalid_request',
    );
    expect(db.rows('endpoint').get(IDS.endpointA1)?.projectId).toBe(IDS.projectA1);
  });

  it('refuses a subscription hand-off into another tenant project', async () => {
    // The reviewed exploit: PATCH {"project_id": "<org B's project>"} committed
    // the move and then 404ed on the read-back, so the caller was told nothing
    // had happened while org B's events started flowing to the attacker's URL.
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.subscriptions.updateById(IDS.subscriptionA1, { projectId: IDS.projectB1 } as never),
      'invalid_request',
    );
    expect(db.rows('webhookSubscription').get(IDS.subscriptionA1)?.projectId).toBe(IDS.projectA1);
  });

  it('refuses to rewrite the primary key', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, { id: 'ep_stolen' } as never),
      'invalid_request',
    );
  });

  it('refuses the tenant columns on bulk update too', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateMany({ status: 'active' }, { projectId: IDS.projectB1 } as never),
      'invalid_request',
    );
  });

  it('refuses the tenant columns on create, rather than silently ignoring them', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.create({
        id: 'ep_elsewhere',
        name: 'x',
        url: 'https://x.example.com',
        projectId: IDS.projectB1,
      } as never),
      'invalid_request',
    );
    expect(db.rows('endpoint').has('ep_elsewhere')).toBe(false);
  });

  it('reads the updated row back inside the same transaction', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const updated = await scope.endpoints.updateById(IDS.endpointA1, { name: 'renamed' });
    expect(updated.name).toBe('renamed');
    // updateMany and the read-back are one unit: both statements are issued
    // against the transaction client, not the outer one.
    const ops = db.queries.filter((query) => query.table === 'endpoint');
    expect(ops.some((query) => query.op === 'updateMany')).toBe(true);
  });
});

describe('ScopedRepository - sibling foreign keys are proved, not trusted (FIX 2a)', () => {
  it('refuses a subscription pointed at another tenant endpoint', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.subscriptions.create({
        id: 'sub_evil',
        endpointId: IDS.endpointB1,
        eventTypes: ['*'],
      }),
      'not_found',
    );
    expect(db.rows('webhookSubscription').has('sub_evil')).toBe(false);
  });

  it('still creates a subscription against an endpoint in this project', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const created = await scope.subscriptions.create({
      id: 'sub_new',
      endpointId: IDS.endpointA1,
      eventTypes: ['payment.settled'],
    });
    expect(created.projectId).toBe(IDS.projectA1);
    expect(created.endpointId).toBe(IDS.endpointA1);
  });

  it('refuses an endpoint pointed at another tenant retry policy', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, { retryPolicyId: IDS.retryPolicyB1 }),
      'not_found',
    );
    await expect(
      scope.endpoints.updateById(IDS.endpointA1, { retryPolicyId: IDS.retryPolicyA1 }),
    ).resolves.toMatchObject({ retryPolicyId: IDS.retryPolicyA1 });
  });

  it('sees through Prisma’s `{ set: ... }` scalar wrapper', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, {
        retryPolicyId: { set: IDS.retryPolicyB1 },
      }),
      'not_found',
    );
  });

  it('refuses a delivery bound to another tenant endpoint', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.deliveries.create({
        id: 'del_evil',
        eventId: IDS.eventA1,
        endpointId: IDS.endpointB1,
        maxAttempts: 5,
      }),
      'not_found',
    );
    expect(db.rows('delivery').has('del_evil')).toBe(false);
  });

  it('exposes the same check to module authors as requireOwned/assertOwned', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expect(scope.subscriptions.assertOwned('endpointId', IDS.endpointA1)).resolves.toBeUndefined();
    await expectCode(scope.subscriptions.assertOwned('endpointId', IDS.endpointB1), 'not_found');
    // A field that is not a declared foreign key is a programming error, not a
    // silently skipped check.
    await expectCode(scope.subscriptions.assertOwned('name', IDS.endpointA1), 'internal_error');
  });
});

describe('ScopedRepository - nested relation writes are rejected (FIX 2b)', () => {
  it('refuses to re-point another tenant HMAC secret at my endpoint', async () => {
    // `connect` takes a bare unique key with no tenant filter - the same
    // unscoped access `where` no longer allows, arriving through `data`. The
    // AES-GCM AAD is {table, id}, so a stolen secret still decrypts, and the
    // attacker can then forge signed webhooks into the victim's consumers.
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, {
        secrets: { connect: [{ id: IDS.secretB1 }] },
      } as never),
      'invalid_request',
    );
    expect(db.rows('endpointSecret').get(IDS.secretB1)?.endpointId).toBe(IDS.endpointB1);
  });

  it('refuses every nested writer shape, on create as well', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    for (const relationWrite of [
      { secrets: { connect: [{ id: IDS.secretB1 }] } },
      { secrets: { set: [{ id: IDS.secretB1 }] } },
      { secrets: { disconnect: [{ id: IDS.secretA1 }] } },
      { secrets: { deleteMany: {} } },
      { subscriptions: { deleteMany: {} } },
      { project: { connect: { id: IDS.projectB1 } } },
      { retryPolicy: { connect: { id: IDS.retryPolicyB1 } } },
    ]) {
      await expectCode(
        scope.endpoints.updateById(IDS.endpointA1, relationWrite as never),
        'invalid_request',
      );
      await expectCode(
        scope.endpoints.create({
          id: 'ep_nested',
          name: 'x',
          url: 'https://x.example.com',
          ...relationWrite,
        } as never),
        'invalid_request',
      );
    }
  });

  it('refuses a key that is not a column on the table', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateById(IDS.endpointA1, { isAdmin: true } as never),
      'invalid_request',
    );
  });
});

describe('ScopedRepository - coverage the operator UI needs (FIX 4)', () => {
  it('scopes endpoint health through its endpoint, keyed by endpoint_id', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const health = await scope.endpointHealth.findMany();
    expect(health.map((row) => row.endpointId)).toEqual([IDS.endpointA1]);
    expect(await scope.endpointHealth.findById(IDS.endpointA1)).not.toBeNull();
    await expectCode(scope.endpointHealth.requireById(IDS.endpointB1), 'not_found');
  });

  it('scopes the organization row to the caller’s own organization', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA });
    const organizations = await scope.organization.findMany();
    expect(organizations.map((organization) => organization.id)).toEqual([IDS.orgA]);
    expect(await scope.organization.findById(IDS.orgB)).toBeNull();
  });

  it('fences aggregate and groupBy with the same predicate as where()', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    // Three deliveries in the table; one is this tenant's, one is org B's, one
    // is the corrupt row. The dashboard must count exactly one.
    expect(await scope.deliveries.aggregate({ _count: true })).toEqual({ _count: 1 });
    expect(await scope.deliveries.groupBy({ by: ['status'], _count: true })).toEqual([
      { status: 'pending', _count: 1 },
    ]);
  });
});

describe('ScopedRepository - bounded reads and deliberate bulk writes (FIX 5)', () => {
  function seedEndpoints(db: FakeTenantPrisma, count: number): void {
    for (let index = 0; index < count; index += 1) {
      db.insert('endpoint', {
        id: `ep_bulk_${index}`,
        projectId: IDS.projectA1,
        name: `bulk ${index}`,
        url: 'https://bulk.example.com/hook',
        status: 'active',
      });
    }
  }

  it('clamps take to the page ceiling and defaults it', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    seedEndpoints(db, 300);
    expect(await scope.endpoints.findMany({ take: 1_000_000 })).toHaveLength(MAX_PAGE_SIZE);
    expect(await scope.endpoints.findMany()).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(await scope.endpoints.findMany({ take: 10 })).toHaveLength(10);
  });

  it('refuses an unfiltered bulk delete', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(scope.endpoints.deleteMany(undefined as never), 'internal_error');
    await expectCode(scope.endpoints.deleteMany({}), 'internal_error');
    expect(db.rows('endpoint').has(IDS.endpointA1)).toBe(true);
  });

  it('refuses an unfiltered bulk update', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    await expectCode(
      scope.endpoints.updateMany(undefined as never, { status: 'deleted' }),
      'internal_error',
    );
  });

  it('still allows a bulk write that names what it is doing', async () => {
    const { db, scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    expect(await scope.endpoints.deleteMany({ status: 'active' })).toBe(1);
    expect(db.rows('endpoint').has(IDS.endpointB1)).toBe(true);
  });
});
