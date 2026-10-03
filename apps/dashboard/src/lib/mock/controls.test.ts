import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiKey,
  Endpoint,
  EndpointSecret,
  Member,
  OffsetPage,
  RotatedSecret,
} from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';
import { rejectMemberChange } from './writes';

/**
 * The four controls that existed on the control API and had no button: revoke
 * an API key, delete an endpoint, manage an endpoint's signing secrets, and
 * change or remove a member.
 *
 * The mock IS the contract until the transport flips, so the REFUSALS are the
 * point of this file: the last-active-secret 409, the last-owner 409, the
 * lattice's 403s, a revoked key's status. Each is a branch the dashboard
 * renders, and a mock that only implemented the 200s would leave every one of
 * them first exercised in production.
 */
const ORG = 'org_01JQSHAQ';
/** The demo user is an ADMIN here, and `mem_07` is an owner they cannot touch. */
const OTHER_ORG = 'org_01JQKWIK';
const PROJECT = 'proj_01JQPAYPROD';
/** Two active secrets: v2 signing, v1 still inside its overlap window. */
const TWO_SECRETS = 'ep_01JQFINANCE';
/** One active secret, so revoking it is the last-active 409. */
const ONE_SECRET = 'ep_01JQLEDGER';
/** Created by a developer: no secret at all, `has_live_secret: false`. */
const NO_SECRET = 'ep_01JQPENDING';
const DELETED = 'ep_01JQREMOVED';

beforeEach(() => resetMockState());

async function failure(request: Promise<unknown>): Promise<MockHttpError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof MockHttpError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

const endpointOf = (id: string) => db.endpoints.find((endpoint) => endpoint.id === id)!;

describe('POST /v1/projects/:projectId/api-keys/:apiKeyId/revoke', () => {
  it('revokes immediately, persists, and the list reads the key back as revoked', async () => {
    const revoked = await mockRequest<ApiKey>(
      'POST',
      `/v1/projects/${PROJECT}/api-keys/key_01JQLIVE/revoke`,
    );
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_at).toBeTypeOf('string');

    const page = await mockRequest<OffsetPage<ApiKey>>('GET', `/v1/projects/${PROJECT}/api-keys`);
    expect(page.data.find((key) => key.id === 'key_01JQLIVE')?.status).toBe('revoked');
  });

  it('is idempotent and keeps the ORIGINAL revoked_at on a second call', async () => {
    const first = await mockRequest<ApiKey>(
      'POST',
      `/v1/projects/${PROJECT}/api-keys/key_01JQLIVE/revoke`,
    );
    const second = await mockRequest<ApiKey>(
      'POST',
      `/v1/projects/${PROJECT}/api-keys/key_01JQLIVE/revoke`,
    );
    // The forensically interesting timestamp is the first one.
    expect(second.revoked_at).toBe(first.revoked_at);
    expect(second.status).toBe('revoked');
  });

  it('revoked outranks expired, exactly as the ingest path derives it', async () => {
    const revoked = await mockRequest<ApiKey>(
      'POST',
      `/v1/projects/${PROJECT}/api-keys/key_01JQEXPIRED/revoke`,
    );
    expect(revoked.status).toBe('revoked');
  });

  it('answers 404 for a key in another project — one answer for absent and not-yours', async () => {
    const other = db.projects.find((project) => project.id !== PROJECT)!;
    const error = await failure(
      mockRequest('POST', `/v1/projects/${other.id}/api-keys/key_01JQLIVE/revoke`),
    );
    expect(error.status).toBe(404);
    expect(error.body.error.code).toBe('not_found');
  });
});

describe('DELETE /v1/projects/:projectId/endpoints/:endpointId', () => {
  it('soft-deletes: the row stays with status deleted, hidden from the default list', async () => {
    const result = await mockRequest<void>(
      'DELETE',
      `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`,
    );
    expect(result).toBeUndefined();

    const row = endpointOf(TWO_SECRETS);
    expect(row.status).toBe('deleted');
    expect(row.enabled).toBe(false);
    expect(row.has_live_secret).toBe(false);

    const hidden = await mockRequest<OffsetPage<Endpoint>>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints?limit=200`,
    );
    expect(hidden.data.some((endpoint) => endpoint.id === TWO_SECRETS)).toBe(false);

    // Kept for the ledger: still readable by id and with include_deleted.
    const byId = await mockRequest<Endpoint>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`,
    );
    expect(byId.status).toBe('deleted');
  });

  it('is idempotent', async () => {
    await mockRequest('DELETE', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`);
    await expect(
      mockRequest('DELETE', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`),
    ).resolves.toBeUndefined();
    await expect(
      mockRequest('DELETE', `/v1/projects/${PROJECT}/endpoints/${DELETED}`),
    ).resolves.toBeUndefined();
  });

  it('every later write answers 409', async () => {
    await mockRequest('DELETE', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`);
    for (const request of [
      mockRequest('PATCH', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}`, { timeout_ms: 5_000 }),
      mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}/enable`),
      mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${TWO_SECRETS}/disable`, {}),
      mockRequest('POST', `/v1/endpoints/${TWO_SECRETS}/secrets/rotate`, {}),
    ]) {
      const error = await failure(request);
      expect(error.status).toBe(409);
      expect(error.body.error.code).toBe('conflict');
    }
  });

  it('answers 404 for an endpoint in another project', async () => {
    const other = db.projects.find((project) => project.id !== PROJECT)!;
    const error = await failure(
      mockRequest('DELETE', `/v1/projects/${other.id}/endpoints/${TWO_SECRETS}`),
    );
    expect(error.status).toBe(404);
  });
});

describe('signing secrets', () => {
  const list = (endpointId: string) =>
    mockRequest<OffsetPage<EndpointSecret>>('GET', `/v1/endpoints/${endpointId}/secrets`);

  it('rotation persists: the new version leads the list and the old ones get an expiry', async () => {
    const before = await list(TWO_SECRETS);
    const rotated = await mockRequest<RotatedSecret>(
      'POST',
      `/v1/endpoints/${TWO_SECRETS}/secrets/rotate`,
      { overlap_seconds: 3600 },
    );

    expect(rotated.version).toBe(3);
    expect(rotated.secret).toMatch(/^whsec_/);
    // v2 (no expiry) and v1 (inside its own overlap window) both still sign,
    // newest first — a consumer rolling off this list must know about both.
    expect(rotated.overlapping_versions).toEqual([2, 1]);
    expect(rotated.previous_secrets_expire_at).not.toBeNull();

    const after = await list(TWO_SECRETS);
    expect(after.data).toHaveLength(before.data.length + 1);
    expect(after.data[0].version).toBe(3);
    expect(after.data[0]).not.toHaveProperty('secret');
    const v2 = after.data.find((secret) => secret.version === 2)!;
    expect(v2.active).toBe(true);
    expect(v2.expires_at).toBeTypeOf('string');
    expect(v2.rotated_at).toBeTypeOf('string');
  });

  it('never shortens an overlap window a consumer was already promised', async () => {
    const v1Before = (await list(TWO_SECRETS)).data.find((secret) => secret.version === 1)!;
    // v1 expires in ~4 hours; a 30-day rotation must not move it, and a
    // 1-second one must not either — the deadline only ever moves EARLIER for
    // a secret that had none.
    await mockRequest('POST', `/v1/endpoints/${TWO_SECRETS}/secrets/rotate`, {
      overlap_seconds: 2_592_000,
    });
    const v1After = (await list(TWO_SECRETS)).data.find((secret) => secret.version === 1)!;
    expect(v1After.expires_at).toBe(v1Before.expires_at);
  });

  it('overlap_seconds: 0 retires the old secrets on the spot — the leak case', async () => {
    const rotated = await mockRequest<RotatedSecret>(
      'POST',
      `/v1/endpoints/${ONE_SECRET}/secrets/rotate`,
      { overlap_seconds: 0 },
    );
    expect(rotated.overlapping_versions).toEqual([]);
    expect(rotated.previous_secrets_expire_at).toBeNull();

    const after = await list(ONE_SECRET);
    expect(after.data.filter((secret) => secret.active).map((secret) => secret.version)).toEqual([2]);
  });

  it('rotating an endpoint with no secret is what makes it resumable', async () => {
    expect(endpointOf(NO_SECRET).has_live_secret).toBe(false);
    const refused = await failure(
      mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${NO_SECRET}/enable`),
    );
    expect(refused.status).toBe(409);

    const rotated = await mockRequest<RotatedSecret>(
      'POST',
      `/v1/endpoints/${NO_SECRET}/secrets/rotate`,
      {},
    );
    expect(rotated.version).toBe(1);
    expect(rotated.overlapping_versions).toEqual([]);
    expect(endpointOf(NO_SECRET).has_live_secret).toBe(true);

    const resumed = await mockRequest<Endpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints/${NO_SECRET}/enable`,
    );
    expect(resumed.status).toBe('active');
  });

  it('validates overlap_seconds in the ValidationPipe’s shape', async () => {
    for (const overlap_seconds of [-1, 2_592_001, 1.5, 'soon']) {
      const error = await failure(
        mockRequest('POST', `/v1/endpoints/${TWO_SECRETS}/secrets/rotate`, { overlap_seconds }),
      );
      expect(error.status).toBe(400);
      const messages = error.body.error.message as string[];
      expect(Array.isArray(messages)).toBe(true);
      expect(messages[0]).toContain('overlap_seconds: ');
    }
  });

  it('refuses to rotate a deleted endpoint', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/endpoints/${DELETED}/secrets/rotate`, {}),
    );
    expect(error.status).toBe(409);
    expect(String(error.body.error.message)).toContain('deleted');
  });

  it('revokes one of two active secrets, and the endpoint keeps signing', async () => {
    const v1 = (await list(TWO_SECRETS)).data.find((secret) => secret.version === 1)!;
    const revoked = await mockRequest<EndpointSecret>(
      'DELETE',
      `/v1/endpoints/${TWO_SECRETS}/secrets/${v1.id}`,
    );
    expect(revoked.active).toBe(false);
    expect(revoked).not.toHaveProperty('secret');
    expect(endpointOf(TWO_SECRETS).has_live_secret).toBe(true);
  });

  it('refuses to revoke the LAST active secret of a live endpoint with a 409 naming the remedy', async () => {
    const [only] = (await list(ONE_SECRET)).data;
    const error = await failure(
      mockRequest('DELETE', `/v1/endpoints/${ONE_SECRET}/secrets/${only.id}`),
    );
    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
    expect(String(error.body.error.message)).toContain('only secret currently signing');
    expect(String(error.body.error.message)).toContain('overlap of 0');
    // Nothing changed.
    expect((await list(ONE_SECRET)).data[0].active).toBe(true);
  });

  it('answers the cross-tenant 404 for an unknown secret id', async () => {
    const error = await failure(
      mockRequest('DELETE', `/v1/endpoints/${ONE_SECRET}/secrets/sec_nope`),
    );
    expect(error.status).toBe(404);
  });
});

describe('members — PATCH and DELETE /v1/organizations/:orgId/members/:memberId', () => {
  const change = (orgId: string, memberId: string, role: unknown) =>
    mockRequest<Member>('PATCH', `/v1/organizations/${orgId}/members/${memberId}`, { role });
  const remove = (orgId: string, memberId: string) =>
    mockRequest<void>('DELETE', `/v1/organizations/${orgId}/members/${memberId}`);

  it('changes a role and the list reads it back', async () => {
    const changed = await change(ORG, 'mem_03', 'developer');
    expect(changed.role).toBe('developer');
    const page = await mockRequest<OffsetPage<Member>>('GET', `/v1/organizations/${ORG}/members`);
    expect(page.data.find((member) => member.id === 'mem_03')?.role).toBe('developer');
  });

  it('never lets you change your own role, or remove yourself', async () => {
    const promote = await failure(change(ORG, 'mem_01', 'owner'));
    expect(promote.status).toBe(403);
    expect(String(promote.body.error.message)).toBe(
      'You cannot change your own role. Ask another owner or admin to do it.',
    );
    const leave = await failure(remove(ORG, 'mem_01'));
    expect(leave.status).toBe(403);
    expect(String(leave.body.error.message)).toBe(
      'You cannot remove your own membership. Ask another owner or admin to do it.',
    );
  });

  it('refuses a role above your rank, and a member who outranks you', async () => {
    // An admin (the demo user in Kwik Logistics) cannot mint an owner…
    const mint = await failure(change(OTHER_ORG, 'mem_07', 'admin'));
    expect(mint.status).toBe(403);
    expect(String(mint.body.error.message)).toBe('You may not change the role of an owner.');
    // …nor remove one.
    const evict = await failure(remove(OTHER_ORG, 'mem_07'));
    expect(String(evict.body.error.message)).toBe('You may not remove an owner.');
  });

  it('refuses to assign a role above your own even to someone below you', async () => {
    // Add a developer to the admin's organization, then try to make them owner.
    db.members[OTHER_ORG].push({ ...db.members[ORG][3], id: 'mem_tmp', user_id: 'usr_tmp' });
    const error = await failure(change(OTHER_ORG, 'mem_tmp', 'owner'));
    expect(error.status).toBe(403);
    expect(String(error.body.error.message)).toBe('You may not assign the role "owner".');
  });

  it('removes a member — a hard delete of the membership row', async () => {
    await expect(remove(ORG, 'mem_04')).resolves.toBeUndefined();
    const page = await mockRequest<OffsetPage<Member>>('GET', `/v1/organizations/${ORG}/members`);
    expect(page.data.some((member) => member.id === 'mem_04')).toBe(false);
  });

  it('refuses an unknown role as a 400 naming the field', async () => {
    const error = await failure(change(ORG, 'mem_03', 'superuser'));
    expect(error.status).toBe(400);
    expect((error.body.error.message as string[])[0]).toContain('role: ');
  });

  it('answers 404 for a membership that is not in this organization', async () => {
    expect((await failure(change(ORG, 'mem_07', 'viewer'))).status).toBe(404);
    expect((await failure(remove(OTHER_ORG, 'mem_03'))).status).toBe(404);
  });
});

describe('the last-owner rule', () => {
  /**
   * Through a single request it is a race guard — an actor with
   * `members.write` who may touch an owner IS an owner, so the count is at
   * least two — which is why it is pinned on the pure rule rather than driven
   * through the router. The sentence and the status are the contract.
   */
  it('is a 409 conflict, not a 403, with the server’s sentence', () => {
    const refusal = rejectMemberChange({
      actorRole: 'owner',
      actorMembershipId: 'mem_a',
      targetMembershipId: 'mem_b',
      currentRole: 'owner',
      nextRole: 'admin',
      ownerCount: 1,
    });
    expect(refusal).toEqual({
      status: 409,
      code: 'conflict',
      message: 'An organization must always have at least one owner. Promote another member first.',
    });
    expect(
      rejectMemberChange({
        actorRole: 'owner',
        actorMembershipId: 'mem_a',
        targetMembershipId: 'mem_b',
        currentRole: 'owner',
        nextRole: null,
        ownerCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it('lets an owner be demoted when another survives', () => {
    expect(
      rejectMemberChange({
        actorRole: 'owner',
        actorMembershipId: 'mem_a',
        targetMembershipId: 'mem_b',
        currentRole: 'owner',
        nextRole: 'admin',
        ownerCount: 2,
      }),
    ).toBeNull();
  });
});
