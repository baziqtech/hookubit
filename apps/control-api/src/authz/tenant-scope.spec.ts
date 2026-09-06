import { AppError, ErrorCode } from '../common/errors';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { TenantScope, TenantScopeFactory } from './tenant-scope.factory';
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
    const count = await scope.endpoints.updateMany(undefined, { status: 'paused' });
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
  it('scopes deliveries by organization and project together', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const deliveries = await scope.deliveries.findMany();
    // del_corrupt claims org A and project A on its own columns, so a
    // column-only predicate returns it here. That is exactly why the ANCHOR
    // path walks the endpoint chain: addressing it by id is refused.
    expect(deliveries.map((delivery) => delivery.id).sort()).toEqual(
      [IDS.deliveryA1, IDS.deliveryCorrupt].sort(),
    );
    expect(await scope.deliveries.findById(IDS.deliveryB1)).toBeNull();
  });

  it('scopes events', async () => {
    const { scope } = await scopeFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    expect((await scope.events.findMany()).map((event) => event.id)).toEqual([IDS.eventA1]);
    await expectCode(scope.events.requireById(IDS.eventB1), 'not_found');
  });
});
