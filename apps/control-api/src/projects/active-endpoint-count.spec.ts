import { IDS } from '../authz/testing/fixtures';
import { CreatedProjectDto, ProjectDto, ProjectListDto } from './dto';
import { Harness, startProjectsApp } from './testing/harness';

/**
 * `ProjectDto.active_endpoint_count` - the number the Usage screen's "Active
 * Endpoints" column shows.
 *
 * Two things are being proved here, and the second is the one that will decay:
 *
 *  1. WHAT "ACTIVE" MEANS. `enabled && status === 'active'`, both halves, which
 *     is the same test `assertReplayable` applies before it lets a replay be
 *     queued (`isDeliverable`). The fixture therefore seeds one endpoint in each
 *     of the ways an endpoint can fail to be deliverable - including the case
 *     the two-half definition exists for: auto-disabled by the circuit breaker
 *     while `enabled` is still true, because the operator never asked for it to
 *     stop.
 *  2. THAT IT IS ONE QUERY. A count per project is an N+1 that nothing in the
 *     response would reveal, and the Usage table already spends two throttled
 *     analytics requests per project. The query counter on the fake is what
 *     stops a later refactor from turning the rollup into a loop.
 *
 * Org B's project keeps endpoints in the same table throughout, so "A's count
 * does not include B's" is a result rather than an empty table.
 */
describe('active endpoint count', () => {
  let h: Harness;

  const projectsOf = (organizationId: string): string =>
    `/v1/organizations/${organizationId}/projects`;

  /** A minimal endpoint row. Both flags are always stated; see `isDeliverable`. */
  const endpoint = (
    id: string,
    projectId: string,
    status: string,
    enabled: boolean,
    extra: Record<string, unknown> = {},
  ): void => {
    h.db.insert('endpoint', {
      id,
      projectId,
      name: id,
      url: `https://${id}.example.com/hook`,
      status,
      enabled,
      ...extra,
    });
  };

  const projectFromList = async (id: string, organizationId = IDS.orgA): Promise<ProjectDto> => {
    const res = await h.call<ProjectListDto>('GET', projectsOf(organizationId), {
      as: IDS.ownerA,
    });
    expect(res.status).toBe(200);
    const project = res.body.data.find((row) => row.id === id);
    if (!project) throw new Error(`${id} was not in the list`);
    return project;
  };

  beforeEach(async () => {
    h = await startProjectsApp();
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // What "active" means
  // -------------------------------------------------------------------------

  it('counts only the endpoints that are both enabled and active', async () => {
    // `ep_a1` is already in the fixture: active and enabled, so it counts.
    endpoint('ep_second_live', IDS.projectA1, 'active', true);
    // Operator intent withdrawn, two ways round.
    endpoint('ep_paused', IDS.projectA1, 'paused', false);
    endpoint('ep_flag_off', IDS.projectA1, 'active', false);
    // The breaker's verdict, with operator intent untouched.
    endpoint('ep_breaker', IDS.projectA1, 'disabled', true, {
      disabledReason: 'auto-disabled after 5 consecutive failures',
      disabledAt: new Date(),
    });
    // Soft-deleted: the row lives forever for the ledger's sake.
    endpoint('ep_deleted', IDS.projectA1, 'deleted', false);

    const project = await projectFromList(IDS.projectA1);

    expect(project.active_endpoint_count).toBe(2);
  });

  /**
   * The case the pair of conditions exists for, asserted on its own so that
   * dropping `enabled` from the predicate cannot be mistaken for a tidy-up: the
   * count would still be "right" for every other row in the test above.
   */
  it('does not count an endpoint the circuit breaker disabled, though `enabled` is still true', async () => {
    h.db.rows('endpoint').clear();
    endpoint('ep_breaker_only', IDS.projectA1, 'disabled', true, {
      disabledReason: 'auto-disabled after 5 consecutive failures',
      disabledAt: new Date(),
    });

    const project = await projectFromList(IDS.projectA1);

    expect(project.active_endpoint_count).toBe(0);
  });

  /** The mirror: `status` alone is not enough either. */
  it('does not count an active endpoint an operator has switched off', async () => {
    h.db.rows('endpoint').clear();
    endpoint('ep_intent_off', IDS.projectA1, 'active', false);

    const project = await projectFromList(IDS.projectA1);

    expect(project.active_endpoint_count).toBe(0);
  });

  it('reports 0 - present on the wire, never absent - for a project with no endpoints', async () => {
    // proj_a2 has none in the fixture.
    const project = await projectFromList(IDS.projectA2);

    expect(project.active_endpoint_count).toBe(0);
    // A field that is sometimes absent is a field a client reads as undefined
    // and renders as blank. `0` is an answer; missing is not.
    expect(Object.keys(project)).toContain('active_endpoint_count');
  });

  it('agrees between the list and the single-project route', async () => {
    endpoint('ep_second_live', IDS.projectA1, 'active', true);
    endpoint('ep_breaker', IDS.projectA1, 'disabled', true);

    const listed = await projectFromList(IDS.projectA1);
    const fetched = await h.call<ProjectDto>(
      'GET',
      `${projectsOf(IDS.orgA)}/${IDS.projectA1}`,
      { as: IDS.ownerA },
    );

    expect(fetched.status).toBe(200);
    expect(fetched.body.active_endpoint_count).toBe(2);
    expect(listed.active_endpoint_count).toBe(fetched.body.active_endpoint_count);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it("never counts another organization's endpoints", async () => {
    // Org B, in the same table, with more live endpoints than A has.
    endpoint('ep_b2', IDS.projectB1, 'active', true);
    endpoint('ep_b3', IDS.projectB1, 'active', true);

    const project = await projectFromList(IDS.projectA1);

    // Org A's own single live endpoint, and nothing of B's.
    expect(project.active_endpoint_count).toBe(1);
  });

  it("does not spill one project's endpoints into a sibling project in the same organization", async () => {
    endpoint('ep_a2_live_1', IDS.projectA2, 'active', true);
    endpoint('ep_a2_live_2', IDS.projectA2, 'active', true);

    const res = await h.call<ProjectListDto>('GET', projectsOf(IDS.orgA), { as: IDS.ownerA });
    const counts = new Map(
      res.body.data.map((project) => [project.id, project.active_endpoint_count]),
    );

    expect(counts.get(IDS.projectA1)).toBe(1);
    expect(counts.get(IDS.projectA2)).toBe(2);
    // Same organization, no endpoints of its own.
    expect(counts.get(IDS.projectASuspended)).toBe(0);
  });

  it('is scoped by the repository, not by the id list: B1 is invisible even asked for by name', async () => {
    endpoint('ep_b2', IDS.projectB1, 'active', true);

    const res = await h.call('GET', `${projectsOf(IDS.orgA)}/${IDS.projectB1}`, {
      as: IDS.ownerA,
    });

    // The 404 comes first; no count is taken for a project in another tenant.
    expect(res.status).toBe(404);
    expect(h.db.queries.filter((query) => query.table === 'endpoint')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Cost
  // -------------------------------------------------------------------------

  it('takes ONE endpoint query for a whole page of projects, not one per project', async () => {
    endpoint('ep_a2_live', IDS.projectA2, 'active', true);
    endpoint('ep_susp_live', IDS.projectASuspended, 'active', true);

    const res = await h.call<ProjectListDto>('GET', projectsOf(IDS.orgA), { as: IDS.ownerA });

    expect(res.status).toBe(200);
    // Three projects on the page, each with its own count.
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.map((project) => project.active_endpoint_count).sort()).toEqual([
      1, 1, 1,
    ]);

    /*
     * The fake evaluates every statement's WHERE through one internal `find`,
     * so counting those counts STATEMENTS - which is the thing that must not
     * grow with the page. A `count` per project would be three.
     */
    const statements = h.db.queries.filter(
      (query) => query.table === 'endpoint' && query.op === 'find',
    );
    expect(statements).toHaveLength(1);
    // And it is the grouped one: `groupBy` also records itself by name.
    expect(
      h.db.queries.filter((query) => query.table === 'endpoint' && query.op === 'groupBy'),
    ).toHaveLength(1);
  });

  it('issues no endpoint query at all when the page is empty', async () => {
    const res = await h.call<ProjectListDto>('GET', `${projectsOf(IDS.orgA)}?offset=50`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // An `IN ()` over no ids is a round trip that can only answer nothing.
    expect(h.db.queries.filter((query) => query.table === 'endpoint')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The write routes carry it too, so the shape is one shape
  // -------------------------------------------------------------------------

  it('is 0 on a freshly created project', async () => {
    const res = await h.call<CreatedProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Ledger', slug: 'ledger' },
    });

    expect(res.status).toBe(201);
    expect(res.body.active_endpoint_count).toBe(0);
  });

  /**
   * A copy lands every endpoint PAUSED and secretless on purpose, so a create
   * that copied endpoints still reports `active_endpoint_count: 0` - which is
   * the honest pair, and what lets the dashboard say "copied, nothing is
   * delivering yet".
   *
   * `copied` and `copy_error` are deliberately NOT asserted here. On this route
   * the copy currently fails outright - `ProjectsService.create` hands
   * `ProjectTemplateService.copy` the request context, which on `POST /projects`
   * has resolved no project, so every write through the target scope raises "this
   * route resolved no project" and is reported as `copy_error`. That is a
   * pre-existing defect in the copy feature, not in this count, and it is not
   * fixed here; the assertion below is the one that holds either way, because a
   * successful copy produces paused endpoints and an unsuccessful one produces
   * none.
   */
  it('is 0 on a create that asked for a copy, whether or not endpoints landed', async () => {
    const res = await h.call<CreatedProjectDto>('POST', projectsOf(IDS.orgA), {
      as: IDS.ownerA,
      body: { name: 'Ledger copy', slug: 'ledger-copy', copy_from_project_id: IDS.projectA1 },
    });

    expect(res.status).toBe(201);
    expect(res.body.active_endpoint_count).toBe(0);
    // Whatever landed, none of it is deliverable.
    const copied = h.db
      .all('endpoint')
      .filter((row) => row.projectId === res.body.id);
    expect(copied.every((row) => row.status === 'paused' && row.enabled === false)).toBe(true);
  });

  it('survives a rename', async () => {
    const res = await h.call<ProjectDto>('PATCH', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
      body: { name: 'Renamed' },
    });

    expect(res.status).toBe(200);
    expect(res.body.active_endpoint_count).toBe(1);
  });

  /**
   * Deleting a project does not touch its endpoints - that is what makes an
   * accidental delete recoverable - so the count stays real and `status` is what
   * says nothing is being delivered. A zero here would report a state no row is
   * in.
   */
  it('still reports the real count on a soft-deleted project, alongside status=deleted', async () => {
    const res = await h.call<ProjectDto>('DELETE', `${projectsOf(IDS.orgA)}/${IDS.projectA1}`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
    expect(res.body.active_endpoint_count).toBe(1);
  });
});
