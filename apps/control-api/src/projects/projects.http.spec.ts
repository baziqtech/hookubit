import { IDS } from '../authz/testing/fixtures';
import { CROSS_TENANT_MESSAGE } from '../authz';
import { ProjectDto, ProjectListDto } from './dto';
import { PROJECT_CREATE_THROTTLE } from './project-limits';
import { Harness, startProjectsApp } from './testing/harness';

/**
 * The security-relevant behaviour of the projects module, asserted on the wire.
 *
 * The isolation cases are the point of the fixture: org B's project sits in the
 * same table throughout, so "A only sees A's projects" is a real result rather
 * than an empty database.
 */
describe('projects over HTTP', () => {
  let h: Harness;

  const projectsOf = (organizationId: string): string =>
    `/v1/organizations/${organizationId}/projects`;

  beforeEach(async () => {
    h = await startProjectsApp();
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('lists only the projects of the caller\'s own organization, hiding deleted ones', async () => {
    const res = await h.call<ProjectListDto>('GET', projectsOf(IDS.orgA), { as: IDS.viewerA });

    expect(res.status).toBe(200);
    const ids = res.body.data.map((project) => project.id).sort();
    expect(ids).toEqual([IDS.projectA1, IDS.projectA2, IDS.projectASuspended].sort());
    expect(ids).not.toContain(IDS.projectB1);
    expect(ids).not.toContain(IDS.projectADeleted);
  });

  it('404s a member of org A listing org B, with the shared cross-tenant message', async () => {
    const res = await h.call('GET', projectsOf(IDS.orgB), { as: IDS.ownerA });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
    // One constant for every absent-or-foreign outcome. A per-resource string
    // here would be an existence oracle over other customers' ids.
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s - and writes nothing - when org A tries to create a project in org B', async () => {
    const before = h.db.all('project').length;

    const res = await h.call('POST', projectsOf(IDS.orgB), {
      as: IDS.ownerA,
      body: { name: 'Trojan', slug: 'trojan' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    expect(h.db.all('project')).toHaveLength(before);
    expect(h.db.all('project').some((row) => row.slug === 'trojan')).toBe(false);
  });

  it('404s org B\'s project id presented under org A\'s path (the classic IDOR)', async () => {
    const res = await h.call('GET', `${projectsOf(IDS.orgA)}/${IDS.projectB1}`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s an update aimed at another tenant\'s project and leaves it untouched', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectB1}`, {
      as: IDS.ownerA,
      body: { name: 'Owned' },
    });

    expect(res.status).toBe(404);
    expect(h.db.rows('project').get(IDS.projectB1)?.name).toBe(IDS.projectB1);
  });

  it('404s a soft delete aimed at another tenant\'s project', async () => {
    const res = await h.call('DELETE', `${projectsOf(IDS.orgA)}/${IDS.projectB1}`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(404);
    expect(h.db.rows('project').get(IDS.projectB1)?.status).toBe('active');
  });

  it('401s with no session at all', async () => {
    const res = await h.call('GET', projectsOf(IDS.orgA));
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  it('403s a member of the tenant whose role lacks projects.write', async () => {
    // 403, not 404: membership is proven, so hiding the reason discloses
    // nothing and only makes the error unactionable.
    const res = await h.call('POST', projectsOf(IDS.orgA), {
      as: IDS.developerA,
      body: { name: 'Payments' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });

  it('lets a viewer read the list it cannot write to', async () => {
    const res = await h.call('GET', projectsOf(IDS.orgA), { as: IDS.viewerA });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it('creates in the resolved organization, defaults to the test environment, and audits it', async () => {
    const res = await h.call<ProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.adminA,
      body: { name: 'Payments' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      organization_id: IDS.orgA,
      name: 'Payments',
      slug: 'payments',
      environment: 'test',
      status: 'active',
    });
    expect(res.body.id).toMatch(/^proj_/);

    expect(h.db.all('auditLog')).toHaveLength(1);
    expect(h.db.all('auditLog')[0]).toMatchObject({
      organizationId: IDS.orgA,
      userId: IDS.adminA,
      action: 'project.created',
      resourceType: 'project',
      resourceId: res.body.id,
    });
  });

  it('accepts an explicit live environment at creation', async () => {
    const res = await h.call<ProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments', slug: 'payments-live', environment: 'live' },
    });

    expect(res.status).toBe(201);
    expect(res.body.environment).toBe('live');
  });

  it('rejects a name that yields no usable slug rather than writing an empty one', async () => {
    const res = await h.call('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: '!!!' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
    expect(h.db.all('project').some((row) => row.slug === '')).toBe(false);
  });

  it('rejects a malformed slug at the DTO boundary', async () => {
    const res = await h.call('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments', slug: 'Payments Prod' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
  });

  // -------------------------------------------------------------------------
  // Slug uniqueness - the P2002 that must not be laundered
  // -------------------------------------------------------------------------

  it('answers a slug collision with a conflict that actually names the slug', async () => {
    const first = await h.call<ProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments', slug: 'payments' },
    });
    expect(first.status).toBe(201);

    const second = await h.call('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments again', slug: 'payments' },
    });

    // 409 conflict on the SLUG - not a 500, and not the auth module's bug where
    // every P2002 was reported as a duplicate email.
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('conflict');
    expect(second.body.error?.message).toContain('payments');
    expect(second.body.error?.details).toMatchObject({ field: 'slug', value: 'payments' });
  });

  it('lets two organizations hold the same slug - uniqueness is per organization', async () => {
    const a = await h.call<ProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments', slug: 'payments' },
    });
    const b = await h.call<ProjectDto>('POST', projectsOf(IDS.orgB), {
      as: IDS.ownerB,
      body: { name: 'Payments', slug: 'payments' },
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.organization_id).toBe(IDS.orgA);
    expect(b.body.organization_id).toBe(IDS.orgB);
  });

  it('answers a conflict when an update moves a project onto a taken slug', async () => {
    await h.call('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Payments', slug: 'payments' },
    });

    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { slug: 'payments' },
    });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('conflict');
    expect(h.db.rows('project').get(IDS.projectA1)?.slug).toBe(IDS.projectA1);
  });

  // -------------------------------------------------------------------------
  // Environment immutability
  // -------------------------------------------------------------------------

  it('refuses an update carrying environment, and does not change it', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { name: 'Renamed', environment: 'live' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
    const row = h.db.rows('project').get(IDS.projectA1);
    expect(row?.environment).toBe('test');
    // The whole request is refused, so the name it also carried is not applied.
    expect(row?.name).toBe(IDS.projectA1);
  });

  it('refuses environment even when it is the only field', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { environment: 'live' },
    });

    expect(res.status).toBe(400);
    expect(h.db.rows('project').get(IDS.projectA1)?.environment).toBe('test');
  });

  it('refuses a status change smuggled through PATCH', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { status: 'deleted' },
    });

    expect(res.status).toBe(400);
    expect(h.db.rows('project').get(IDS.projectA1)?.status).toBe('active');
  });

  it('refuses an attempt to re-parent a project into another organization', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { name: 'Renamed', organizationId: IDS.orgB },
    });

    expect(res.status).toBe(400);
    expect(h.db.rows('project').get(IDS.projectA1)?.organizationId).toBe(IDS.orgA);
  });

  // -------------------------------------------------------------------------
  // Update / soft delete
  // -------------------------------------------------------------------------

  it('renames a project and audits the change', async () => {
    const res = await h.call<ProjectDto>('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.adminA,
      body: { name: '  Renamed  ' },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(h.db.all('auditLog')[0]).toMatchObject({
      action: 'project.updated',
      resourceId: IDS.projectA1,
    });
  });

  it('rejects an empty update rather than filing a no-op audit entry', async () => {
    const res = await h.call('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: {},
    });

    expect(res.status).toBe(400);
    expect(h.db.all('auditLog')).toHaveLength(0);
  });

  it('soft-deletes: the row survives, the status changes, and it leaves the listing', async () => {
    const res = await h.call<ProjectDto>('DELETE', `${projectsOf(IDS.orgA)}/${IDS.projectA2}`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
    // Still there - the delivery ledger underneath it must not be cascaded away.
    expect(h.db.rows('project').get(IDS.projectA2)).toBeDefined();
    expect(h.db.rows('project').get(IDS.projectA2)?.status).toBe('deleted');

    const list = await h.call<ProjectListDto>('GET', projectsOf(IDS.orgA), { as: IDS.ownerA });
    expect(list.body.data.map((p) => p.id)).not.toContain(IDS.projectA2);

    expect(h.db.all('auditLog')[0]).toMatchObject({
      action: 'project.deleted',
      resourceId: IDS.projectA2,
    });
  });

  it('makes a soft-deleted project unreachable by id, with the same message as absent', async () => {
    await h.call('DELETE', `${projectsOf(IDS.orgA)}/${IDS.projectA2}`, { as: IDS.ownerA });

    const deleted = await h.call('GET', `${projectsOf(IDS.orgA)}/${IDS.projectA2}`, {
      as: IDS.ownerA,
    });
    const absent = await h.call('GET', `${projectsOf(IDS.orgA)}/proj_does_not_exist`, {
      as: IDS.ownerA,
    });

    expect(deleted.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(deleted.body.error?.message).toBe(absent.body.error?.message);
  });

  it('lists deleted projects only when asked, so a 409 on their slug is explainable', async () => {
    const res = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?status=deleted`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.id)).toEqual([IDS.projectADeleted]);
  });

  // -------------------------------------------------------------------------
  // Suspension
  // -------------------------------------------------------------------------

  it('lets a suspended project be read but not written', async () => {
    const path = `${projectsOf(IDS.orgA)}/${IDS.projectASuspended}`;

    const read = await h.call('GET', path, { as: IDS.ownerA });
    const write = await h.call('PATCH', path, { as: IDS.ownerA, body: { name: 'Nope' } });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect(h.db.rows('project').get(IDS.projectASuspended)?.name).toBe(IDS.projectASuspended);
  });

  // -------------------------------------------------------------------------
  // Paging
  // -------------------------------------------------------------------------

  it('refuses a page size above the repository ceiling instead of silently clamping', async () => {
    const res = await h.call('GET', `${projectsOf(IDS.orgA)}?limit=5000`, { as: IDS.ownerA });
    expect(res.status).toBe(400);
  });

  it('pages, and says so: has_more plus an offset that fetches the rest', async () => {
    // Three live projects in org A (A1, A2, A-suspended); the deleted one is
    // hidden. A page of one is therefore the first of three.
    const first = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?limit=1`, {
      as: IDS.ownerA,
    });

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.has_more).toBe(true);
    expect(first.body.next_offset).toBe(1);

    const second = await h.call<ProjectListDto>(
      'GET',
      `${projectsOf(IDS.orgA)}?limit=1&offset=${first.body.next_offset}`,
      { as: IDS.ownerA },
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.has_more).toBe(true);
  });

  it('is honest at exactly the page boundary: a full page that is also the last one', async () => {
    // THE case a bare array could not express. Three live projects, limit=3: the
    // page is completely full, and there is nothing after it. A client that
    // inferred "data.length === limit means there is more" would loop forever; one
    // that inferred the opposite from a short page would be right by luck.
    const exact = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?limit=3`, {
      as: IDS.ownerA,
    });

    expect(exact.status).toBe(200);
    expect(exact.body.data).toHaveLength(3);
    expect(exact.body.has_more).toBe(false);
    expect(exact.body.next_offset).toBeNull();

    // One below the boundary is the other half of the pair: same data, opposite
    // answer, so the assertion above cannot pass by always returning false.
    const under = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?limit=2`, {
      as: IDS.ownerA,
    });
    expect(under.body.data).toHaveLength(2);
    expect(under.body.has_more).toBe(true);
    expect(under.body.next_offset).toBe(2);
  });

  it('reports has_more false on the last page reached through next_offset', async () => {
    const page = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?limit=2&offset=2`, {
      as: IDS.ownerA,
    });

    expect(page.body.data).toHaveLength(1);
    expect(page.body.has_more).toBe(false);
    expect(page.body.next_offset).toBeNull();
  });

  // -------------------------------------------------------------------------
  // FIX 1 - the per-organization ceiling
  // -------------------------------------------------------------------------

  describe('the project ceiling', () => {
    it('refuses a create once the organization is at its limit, and writes nothing', async () => {
      // Org A is seeded with three live projects; a ceiling of three is already
      // reached, so the very next create must be refused.
      const capped = await startProjectsApp({ maxProjects: 3 });
      try {
        const res = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'One too many', slug: 'one-too-many' },
        });

        expect(res.status).toBe(409);
        expect(res.body.error?.code).toBe('limit_exceeded');
        expect(res.body.error?.details).toEqual({ limit: 3, current: 3, resource: 'projects' });
        expect(capped.db.all('project').some((row) => row.slug === 'one-too-many')).toBe(false);
        // Refused before the write, so nothing was audited either.
        expect(capped.db.all('auditLog')).toHaveLength(0);
      } finally {
        await capped.close();
      }
    });

    it('tells a ceiling and a duplicate apart by CODE, on the same route, same status', async () => {
      // The pair, side by side, because this is the distinction the dashboard
      // was previously reduced to making by matching on message text. Both are
      // 409; only `error.code` separates them, and only `limit_exceeded` carries
      // structured `details`.
      // Org A is seeded with three live projects; a ceiling of five leaves room
      // for the collision to be a collision rather than a ceiling.
      const capped = await startProjectsApp({ maxProjects: 5 });
      try {
        const first = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Clash', slug: 'clash' },
        });
        expect(first.status).toBe(201);

        const duplicate = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Clash again', slug: 'clash' },
        });
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.error?.code).toBe('conflict');

        // Now fill the last slot, so the next create is a CEILING rather than a
        // collision - a different answer to the same verb on the same route.
        const filled = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Fifth', slug: 'fifth' },
        });
        expect(filled.status).toBe(201);

        const ceiling = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Sixth', slug: 'sixth' },
        });
        expect(ceiling.status).toBe(409);
        expect(ceiling.body.error?.code).toBe('limit_exceeded');
        expect(ceiling.body.error?.details).toEqual({
          limit: 5,
          current: 5,
          resource: 'projects',
        });
        // The uniqueness conflict names the offending field instead. It carries
        // no `limit`/`current`/`resource`: a client keying off `details.limit`
        // must never find one where there is no ceiling.
        expect(duplicate.body.error?.details).toEqual({ field: 'slug', value: 'clash' });
      } finally {
        await capped.close();
      }
    });

    it('lets a create through while below the ceiling, and refuses the one that reaches it', async () => {
      const capped = await startProjectsApp({ maxProjects: 4 });
      try {
        const allowed = await capped.call<ProjectDto>('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Fourth', slug: 'fourth' },
        });
        const refused = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Fifth', slug: 'fifth' },
        });

        expect(allowed.status).toBe(201);
        expect(refused.status).toBe(409);
        expect(refused.body.error?.details).toMatchObject({ limit: 4, current: 4 });
      } finally {
        await capped.close();
      }
    });

    it('does not count soft-deleted projects, so DELETE frees a slot', async () => {
      // The ratchet this guards against: a deleted project keeps its slug and
      // its ledger forever, so if deletions counted there would be no operation
      // available to a tenant that frees a slot.
      const capped = await startProjectsApp({ maxProjects: 3 });
      try {
        const blocked = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Blocked', slug: 'blocked' },
        });
        expect(blocked.status).toBe(409);

        await capped.call('DELETE', `${projectsOf(IDS.orgA)}/${IDS.projectA2}`, {
          as: IDS.ownerA,
        });

        const allowed = await capped.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Allowed', slug: 'allowed' },
        });
        expect(allowed.status).toBe(201);
      } finally {
        await capped.close();
      }
    });

    it('clamps a nonsensical configured ceiling rather than locking the tenant out', async () => {
      // MAX_PROJECTS_PER_ORGANIZATION=0 is one typo away in a values file, and
      // an unclamped 0 would mean "this organization may never create a
      // project" - a configuration mistake that reads as a product outage.
      const zero = await startProjectsApp({ maxProjects: 0 });
      try {
        const res = await zero.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: 'Clamped', slug: 'clamped' },
        });
        // Clamped up to the floor of 1, which org A is already past - so this is
        // a 409 about the ceiling, NOT a 500 and not a silently disabled limit.
        expect(res.status).toBe(409);
        expect(res.body.error?.details).toMatchObject({ limit: 1 });
      } finally {
        await zero.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // FIX 1 - the create throttle
  // -------------------------------------------------------------------------

  describe('the create throttle', () => {
    it('429s once the create limit is exceeded, with Retry-After', async () => {
      const { limit } = PROJECT_CREATE_THROTTLE;
      let last = await h.call('POST', projectsOf(IDS.orgA), {
        as: IDS.ownerA,
        body: { name: 'seed', slug: 'seed-0' },
      });
      for (let i = 1; i <= limit; i += 1) {
        last = await h.call('POST', projectsOf(IDS.orgA), {
          as: IDS.ownerA,
          body: { name: `burst ${i}`, slug: `burst-${i}` },
        });
      }

      expect(last.status).toBe(429);
      expect(last.body.error?.code).toBe('rate_limited');
      expect(last.body.error?.details?.retry_after_seconds).toBeGreaterThan(0);
      // The refused request wrote nothing.
      expect(h.db.all('project').some((row) => row.slug === `burst-${limit}`)).toBe(false);
    });

    it('does not throttle the reads', async () => {
      for (let i = 0; i < PROJECT_CREATE_THROTTLE.limit + 5; i += 1) {
        const res = await h.call('GET', projectsOf(IDS.orgA), { as: IDS.ownerA });
        expect(res.status).toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  // FIX 4 - one 404 vocabulary
  // -------------------------------------------------------------------------

  describe('404 message alignment', () => {
    it('answers every not-found with CROSS_TENANT_MESSAGE, never a per-resource string', async () => {
      const cases = [
        await h.call('GET', `${projectsOf(IDS.orgA)}/proj_nope`, { as: IDS.ownerA }),
        await h.call('PATCH', `${projectsOf(IDS.orgA)}/proj_nope`, {
          as: IDS.ownerA,
          body: { name: 'x' },
        }),
        await h.call('DELETE', `${projectsOf(IDS.orgA)}/proj_nope`, { as: IDS.ownerA }),
        // Another tenant's real id, and the cross-tenant resolver's own answer.
        await h.call('GET', `${projectsOf(IDS.orgA)}/${IDS.projectB1}`, { as: IDS.ownerA }),
        await h.call('GET', projectsOf(IDS.orgB), { as: IDS.ownerA }),
      ];

      for (const res of cases) {
        expect(res.status).toBe(404);
        expect(res.body.error?.code).toBe('not_found');
        expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
        // The old repository vocabulary, gone.
        expect(res.body.error?.message).not.toBe('Project not found.');
      }
    });
  });
});
