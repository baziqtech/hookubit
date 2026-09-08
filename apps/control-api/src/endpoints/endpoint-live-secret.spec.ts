import { IDS } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { AppError } from '../common/errors';
import { Harness, harnessFor } from '../endpoint-secrets/testing/harness';

/**
 * `has_live_secret`, and the one thing it is for: the dashboard offering
 * "Resume deliveries" on an endpoint where `POST /enable` is guaranteed to 409.
 *
 * The failing button was on the COMMON path, not an edge case. `endpoints.write`
 * is a developer permission and `endpoint-secrets.*` is owner/admin, so an
 * endpoint created by a developer is deliberately left paused with
 * `secret_pending` - and enabling it refuses, because `signing.Header` fails
 * closed on zero active secrets and an enabled endpoint with none would go dark.
 * `EndpointDto` said nothing about that, so the operator found out by clicking.
 *
 * So the assertions below are all some form of "the flag and `enable` agree",
 * over each way an endpoint can end up with or without something to sign with.
 */

const ONE_HOUR = 3_600_000;

async function projectScope(userId: string = IDS.ownerA): Promise<Harness> {
  return harnessFor(userId, { orgId: IDS.orgA, projectId: IDS.projectA1 });
}

/**
 * An endpoint row inserted straight into the fake, so a test can put it in a
 * secret state the API deliberately makes hard to reach (no secrets at all, or
 * nothing but an expired one). `backfillTimestamps` has already run by the time
 * a harness exists, so these carry their own.
 */
function seedEndpoint(db: FakeTenantPrisma, id: string): string {
  const now = new Date('2026-01-01T00:00:00.000Z');
  db.insert('endpoint', {
    id,
    projectId: IDS.projectA1,
    name: id,
    url: `https://${id}.example.com/hook`,
    status: 'paused',
    enabled: false,
    timeoutMs: 30_000,
    maxConcurrency: 5,
    rateLimitWindowSeconds: 60,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function seedSecret(
  db: FakeTenantPrisma,
  endpointId: string,
  secret: { id: string; version: number; active: boolean; expiresAt: Date | null },
): void {
  db.insert('endpointSecret', {
    ...secret,
    endpointId,
    secretEncrypted: 'v1.k1.a.b.c',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    rotatedAt: null,
  });
}

describe('EndpointDto.has_live_secret - what it means', () => {
  it('is true for an endpoint with one active, unexpired secret', async () => {
    const { endpoints, context } = await projectScope();
    // ep_a1 comes out of the fixture with an active secret and no expiry.
    await expect(endpoints.get(context, IDS.endpointA1)).resolves.toMatchObject({
      has_live_secret: true,
    });
  });

  it('is true for a secret whose expiry is still in the future', async () => {
    const { endpoints, context, db } = await projectScope();
    const id = seedEndpoint(db, 'ep_a_future');
    seedSecret(db, id, {
      id: 'eps_future',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() + ONE_HOUR),
    });

    await expect(endpoints.get(context, id)).resolves.toMatchObject({ has_live_secret: true });
  });

  /**
   * The whole reason this is not `active`.
   *
   * The control plane flips `active` off LAZILY after a rotation, so between a
   * secret expiring and the sweep running there is a window where the column
   * still says active and the data plane's loader - `active = true AND
   * (expires_at IS NULL OR expires_at > now())` - has already stopped emitting
   * it. Answering from `active` alone would report this endpoint as signable
   * for exactly as long as that window lasts, which is precisely when an
   * operator is looking at it.
   */
  it('is false for a secret that is still flagged active but has expired', async () => {
    const { endpoints, context, db } = await projectScope();
    const id = seedEndpoint(db, 'ep_a_expired');
    seedSecret(db, id, {
      id: 'eps_expired',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() - ONE_HOUR),
    });

    await expect(endpoints.get(context, id)).resolves.toMatchObject({ has_live_secret: false });
  });

  it('is false for an endpoint with no secrets at all', async () => {
    const { endpoints, context, db } = await projectScope();
    const id = seedEndpoint(db, 'ep_a_bare');

    await expect(endpoints.get(context, id)).resolves.toMatchObject({ has_live_secret: false });
  });

  it('is false for a secret that was deactivated but has not expired', async () => {
    const { endpoints, context, db } = await projectScope();
    const id = seedEndpoint(db, 'ep_a_revoked');
    seedSecret(db, id, {
      id: 'eps_revoked',
      version: 1,
      active: false,
      expiresAt: new Date(Date.now() + ONE_HOUR),
    });

    await expect(endpoints.get(context, id)).resolves.toMatchObject({ has_live_secret: false });
  });

  it('is true on a freshly created endpoint, which mints version 1 with it', async () => {
    const { endpoints, context } = await projectScope();

    const created = await endpoints.create(context, {
      name: 'finance',
      url: 'https://finance.example.com/hook',
    });

    expect(created).toMatchObject({ has_live_secret: true, secret_version: 1 });
    await expect(endpoints.get(context, created.id)).resolves.toMatchObject({
      has_live_secret: true,
    });
  });

  /**
   * The developer case, which is the one the dashboard got wrong: paused,
   * `secret_pending`, no plaintext handed over - and still signable, because the
   * secret exists. The button SHOULD be offered here.
   */
  it('is true for the paused endpoint a developer creates, awaiting the key handover', async () => {
    const { endpoints, context } = await harnessFor(IDS.developerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });

    const created = await endpoints.create(context, {
      name: 'finance',
      url: 'https://finance.example.com/hook',
    });

    expect(created).toMatchObject({
      status: 'paused',
      secret_pending: true,
      secret: null,
      has_live_secret: true,
    });
  });

  it('stays true while one of two rotated secrets is revoked, and goes false when the last one is', async () => {
    const { endpoints, secrets, context } = await projectScope();
    const created = await endpoints.create(context, {
      name: 'finance',
      url: 'https://finance.example.com/hook',
    });

    const rotated = await secrets.rotate(context, created.id, 7_200);
    // v1 is inside its overlap window, so revoking v2 leaves something signing.
    await secrets.revoke(context, created.id, rotated.id);
    await expect(endpoints.get(context, created.id)).resolves.toMatchObject({
      has_live_secret: true,
    });

    // Revoking the LAST live secret of a live endpoint is refused - that state
    // is only reachable once the endpoint itself is gone, which is the only
    // path to "every secret revoked" the API offers.
    const live = await secrets.list(context, created.id, {});
    const survivor = live.data.find((secret) => secret.active);
    expect(survivor).toBeDefined();
    await expect(
      secrets.revoke(context, created.id, String(survivor?.id)),
    ).rejects.toBeInstanceOf(AppError);

    await endpoints.remove(context, created.id);
    await secrets.revoke(context, created.id, String(survivor?.id));

    // A soft-deleted endpoint is still readable - the delivery ledger points at
    // it - and now reports that nothing would sign for it.
    await expect(endpoints.get(context, created.id)).resolves.toMatchObject({
      status: 'deleted',
      has_live_secret: false,
    });
  });
});

describe('EndpointDto.has_live_secret - the flag and `enable` are the same answer', () => {
  it('refuses to enable exactly the endpoints the flag calls false', async () => {
    const { endpoints, context, db } = await projectScope();
    const bare = seedEndpoint(db, 'ep_a_bare2');
    const expired = seedEndpoint(db, 'ep_a_expired2');
    seedSecret(db, expired, {
      id: 'eps_expired2',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() - ONE_HOUR),
    });
    const signable = seedEndpoint(db, 'ep_a_signable');
    seedSecret(db, signable, {
      id: 'eps_signable',
      version: 1,
      active: true,
      expiresAt: null,
    });

    for (const id of [bare, expired]) {
      expect((await endpoints.get(context, id)).has_live_secret).toBe(false);
      await expect(endpoints.enable(context, id)).rejects.toMatchObject({ code: 'conflict' });
    }

    expect((await endpoints.get(context, signable)).has_live_secret).toBe(true);
    await expect(endpoints.enable(context, signable)).resolves.toMatchObject({
      status: 'active',
      has_live_secret: true,
    });
  });

  it('reports it on every write path, not just the read ones', async () => {
    const { endpoints, context, db } = await projectScope();
    const expired = seedEndpoint(db, 'ep_a_expired3');
    seedSecret(db, expired, {
      id: 'eps_expired3',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() - ONE_HOUR),
    });

    // update - including the no-op update, which returns the row unchanged.
    await expect(endpoints.update(context, expired, {})).resolves.toMatchObject({
      has_live_secret: false,
    });
    await expect(
      endpoints.update(context, expired, { description: 'renamed' }),
    ).resolves.toMatchObject({ has_live_secret: false });

    // disable leaves the secrets alone, and its response is what the dashboard
    // renders the "Resume deliveries" button from.
    await expect(endpoints.disable(context, IDS.endpointA1, 'noisy')).resolves.toMatchObject({
      status: 'paused',
      has_live_secret: true,
    });
  });
});

describe('EndpointDto.has_live_secret - the listing', () => {
  it('gives the same answer as the single-endpoint route, endpoint for endpoint', async () => {
    const { endpoints, context, db } = await projectScope();
    const bare = seedEndpoint(db, 'ep_a_bare3');
    const expired = seedEndpoint(db, 'ep_a_expired4');
    seedSecret(db, expired, {
      id: 'eps_expired4',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() - ONE_HOUR),
    });
    const future = seedEndpoint(db, 'ep_a_future2');
    seedSecret(db, future, {
      id: 'eps_future2',
      version: 1,
      active: true,
      expiresAt: new Date(Date.now() + ONE_HOUR),
    });

    const listed = await endpoints.list(context, {});
    expect(listed.data.map((endpoint) => endpoint.id).sort()).toEqual(
      [IDS.endpointA1, bare, expired, future].sort(),
    );

    for (const row of listed.data) {
      const single = await endpoints.get(context, row.id);
      expect(row.has_live_secret).toBe(single.has_live_secret);
    }
    expect(
      Object.fromEntries(listed.data.map((row) => [row.id, row.has_live_secret])),
    ).toEqual({
      [IDS.endpointA1]: true,
      [bare]: false,
      [expired]: false,
      [future]: true,
    });
  });

  /**
   * The N+1 this field could so easily have been.
   *
   * `has_live_secret` is on every row of the busiest read in the operator UI.
   * Answered per endpoint, a full page becomes MAX_PAGE_SIZE extra round trips
   * against `endpoint_secrets`; answered once, grouped by `endpoint_id`, it is
   * a single statement whatever the page size. So the assertion is not "few
   * queries" but "the SAME number of queries for one endpoint as for many" -
   * a count that does not move when the page grows is the only shape that
   * cannot degrade back into a loop.
   */
  it('does not issue a secrets query per endpoint', async () => {
    const { endpoints, context, db } = await projectScope();
    for (let i = 0; i < 24; i += 1) {
      const id = seedEndpoint(db, `ep_a_bulk_${String(i).padStart(2, '0')}`);
      seedSecret(db, id, { id: `eps_bulk_${i}`, version: 1, active: true, expiresAt: null });
    }

    const secretQueries = (): number =>
      db.queries.filter((query) => query.table === 'endpointSecret').length;

    db.queries.length = 0;
    const one = await endpoints.list(context, { limit: 1 });
    const forOnePage = secretQueries();

    db.queries.length = 0;
    const many = await endpoints.list(context, { limit: 25 });
    const forManyPage = secretQueries();

    expect(one.data).toHaveLength(1);
    expect(many.data).toHaveLength(25);
    expect(many.data.every((row) => row.has_live_secret)).toBe(true);
    // Constant, not proportional.
    expect(forManyPage).toBe(forOnePage);
  });

  it('asks nothing of endpoint_secrets when the page is empty', async () => {
    const { endpoints, context, db } = await projectScope();
    db.queries.length = 0;

    const listed = await endpoints.list(context, { status: 'disabled' });

    expect(listed.data).toHaveLength(0);
    expect(db.queries.filter((query) => query.table === 'endpointSecret')).toHaveLength(0);
  });
});

describe('EndpointDto.has_live_secret - what it does not say', () => {
  /**
   * `endpoints.read` includes `viewer`; `endpoint-secrets.read` is owner and
   * admin. So this field may carry the BOOLEAN and nothing else - an id, a
   * version, a prefix or an expiry would hand a viewer a fact the permission
   * matrix says they may not have, through a route nobody would think to audit.
   */
  it('is a bare boolean, and is the ONLY key the secrets table contributed', async () => {
    const { endpoints, context } = await projectScope();
    const endpoint = await endpoints.get(context, IDS.endpointA1);

    expect(typeof endpoint.has_live_secret).toBe('boolean');
    // The whole wire shape, named. A future field derived from a secret - a
    // version, an expiry, a key prefix - fails here rather than shipping to
    // every `viewer` in the tenant unnoticed.
    expect(Object.keys(endpoint).sort()).toEqual(
      [
        'created_at',
        'custom_headers',
        'description',
        'disabled_at',
        'disabled_reason',
        'enabled',
        'has_live_secret',
        'id',
        'max_concurrency',
        'name',
        'project_id',
        'rate_limit',
        'rate_limit_window_seconds',
        'retry_policy_id',
        'status',
        'timeout_ms',
        'updated_at',
        'url',
      ].sort(),
    );
  });

  it('answers false, never an error, for an endpoint in another tenant', async () => {
    const { endpoints, secrets, context } = await projectScope();
    // The endpoint itself is a 404 through this scope; the secret lookup that
    // backs the flag is fenced by the same predicate, so it finds nothing
    // rather than reporting on org B's secret.
    await expect(endpoints.get(context, IDS.endpointB1)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(secrets.hasLiveSecret(context, IDS.endpointB1)).resolves.toBe(false);
  });

  it('is visible to a viewer, who may read endpoints and no secrets at all', async () => {
    const { endpoints, context } = await harnessFor(IDS.viewerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });

    const listed = await endpoints.list(context, {});
    expect(listed.data[0]).toMatchObject({ has_live_secret: true });
    expect(context.has('endpoint-secrets.read')).toBe(false);
  });
});
