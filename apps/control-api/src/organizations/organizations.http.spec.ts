import { CROSS_TENANT_MESSAGE } from '../authz';
import { OrganizationsController } from './organizations.controller';
import { TestHarness, createHarness } from './testing/http';
import { FakeWorld, IDS, seedWorld } from './testing/world';

describe('organizations over HTTP', () => {
  let db: FakeWorld;
  let harness: TestHarness;

  beforeEach(async () => {
    db = seedWorld();
    harness = await createHarness(db, [OrganizationsController]);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const call = (
    method: string,
    path: string,
    options?: { as?: string; body?: unknown },
  ): ReturnType<TestHarness['call']> => harness.call(method, path, options);

  // ---------------------------------------------------------------------------
  // The untenanted collection
  // ---------------------------------------------------------------------------

  it('401s the collection with no session cookie, rather than serving it unscoped', async () => {
    const res = await call('GET', '/v1/organizations');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  it('401s creation with no session cookie', async () => {
    const res = await call('POST', '/v1/organizations', { body: { name: 'Anything' } });
    expect(res.status).toBe(401);
  });

  it('lists only the caller’s own organizations', async () => {
    const res = await call('GET', '/v1/organizations', { as: IDS.ownerA });
    expect(res.status).toBe(200);
    expect((res.body as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual([
      IDS.orgA,
    ]);
  });

  it('gives a member of another organization a completely different list', async () => {
    const res = await call('GET', '/v1/organizations', { as: IDS.ownerB });
    expect((res.body as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual([
      IDS.orgB,
    ]);
  });

  it('rejects an over-large page size instead of silently clamping it', async () => {
    const res = await call('GET', '/v1/organizations?limit=5000', { as: IDS.ownerA });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
  });

  it('creates an organization and makes the caller its owner', async () => {
    const res = await call('POST', '/v1/organizations', {
      as: IDS.outsider,
      body: { name: 'Umbrella', slug: 'umbrella' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: 'umbrella', role: 'owner' });
  });

  it('rejects a body field the DTO does not declare', async () => {
    // `forbidNonWhitelisted` is what stops a future field being smuggled in.
    const res = await call('POST', '/v1/organizations', {
      as: IDS.outsider,
      body: { name: 'Umbrella', status: 'active' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a slug that is not URL-safe', async () => {
    const res = await call('POST', '/v1/organizations', {
      as: IDS.outsider,
      body: { name: 'Umbrella', slug: 'Not A Slug' },
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // FIX 7 - creation is rate limited
  // ---------------------------------------------------------------------------

  it('429s creation past the limit, having 201d the ones under it', async () => {
    // `POST /v1/organizations` is an untenanted write into a GLOBALLY unique
    // slug namespace. Unlimited, one session was enough to squat it.
    const attempt = (n: number): ReturnType<TestHarness['call']> =>
      call('POST', '/v1/organizations', { as: IDS.outsider, body: { name: `Org ${n}` } });

    const statuses: number[] = [];
    for (let n = 0; n < 11; n += 1) statuses.push((await attempt(n)).status);

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });

  it('charges the limit for requests that never reach the handler', async () => {
    // The guard runs before the validation pipe on purpose: a 400 still costs a
    // request, or the limit is trivially avoided by sending malformed bodies.
    for (let n = 0; n < 10; n += 1) {
      const res = await call('POST', '/v1/organizations', { as: IDS.outsider, body: { name: '' } });
      expect(res.status).toBe(400);
    }
    const over = await call('POST', '/v1/organizations', {
      as: IDS.outsider,
      body: { name: 'Perfectly Valid' },
    });
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe('rate_limited');
  });

  it('does not throttle the reads', async () => {
    for (let n = 0; n < 25; n += 1) {
      const res = await call('GET', '/v1/organizations', { as: IDS.ownerA });
      expect(res.status).toBe(200);
    }
  });

  // ---------------------------------------------------------------------------
  // The tenanted routes
  // ---------------------------------------------------------------------------

  it('404s - not 403s - an organization the caller is not a member of', async () => {
    const res = await call('GET', `/v1/organizations/${IDS.orgB}`, { as: IDS.ownerA });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
    // The single message: an id that exists elsewhere must be indistinguishable
    // from one that exists nowhere.
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s an organization id that does not exist, with the same message', async () => {
    const res = await call('GET', '/v1/organizations/org_does_not_exist', { as: IDS.ownerA });
    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s a soft-deleted organization the caller is still a member of', async () => {
    const res = await call('GET', `/v1/organizations/${IDS.orgDeleted}`, { as: IDS.ownerA });
    expect(res.status).toBe(404);
  });

  it('serves the organization to every role, including billing-shaped ones', async () => {
    const res = await call('GET', `/v1/organizations/${IDS.orgA}`, { as: IDS.viewerA });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: IDS.orgA, role: 'viewer' });
  });

  it('403s a rename by a viewer, inside their own organization', async () => {
    const res = await call('PATCH', `/v1/organizations/${IDS.orgA}`, {
      as: IDS.viewerA,
      body: { name: 'Renamed' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
    expect(db.rows('organization').get(IDS.orgA)?.name).toBe('Acme');
  });

  it('lets an admin rename', async () => {
    const res = await call('PATCH', `/v1/organizations/${IDS.orgA}`, {
      as: IDS.adminA,
      body: { name: 'Acme Corporation' },
    });
    expect(res.status).toBe(200);
    expect(db.rows('organization').get(IDS.orgA)?.name).toBe('Acme Corporation');
  });

  it('404s a rename aimed at another tenant, without touching it', async () => {
    const res = await call('PATCH', `/v1/organizations/${IDS.orgB}`, {
      as: IDS.adminA,
      body: { name: 'Owned' },
    });
    expect(res.status).toBe(404);
    expect(db.rows('organization').get(IDS.orgB)?.name).toBe('Globex');
  });

  it('403s deletion by an admin and soft-deletes for an owner', async () => {
    const refused = await call('DELETE', `/v1/organizations/${IDS.orgA}`, { as: IDS.adminA });
    expect(refused.status).toBe(403);
    expect(db.rows('organization').get(IDS.orgA)?.status).toBe('active');

    const allowed = await call('DELETE', `/v1/organizations/${IDS.orgA}`, { as: IDS.ownerA });
    expect(allowed.status).toBe(204);
    expect(db.rows('organization').get(IDS.orgA)?.status).toBe('deleted');
    // Soft: the row and its members are still there.
    expect(db.rows('organization').has(IDS.orgA)).toBe(true);
    expect(db.all('organizationMember').some((row) => row.organizationId === IDS.orgA)).toBe(true);
  });

  it('takes the projects down with the organization, over HTTP', async () => {
    // FIX 2, end to end: the data plane gates ingest on `projects.status`, so
    // this is what actually stops the wk_live_ keys.
    db.insert('project', {
      id: 'prj_http',
      organizationId: IDS.orgA,
      name: 'Ingest',
      slug: 'ingest',
      environment: 'live',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await call('DELETE', `/v1/organizations/${IDS.orgA}`, { as: IDS.ownerA });

    expect(res.status).toBe(204);
    expect(db.rows('project').get('prj_http')?.status).toBe('deleted');
  });
});
