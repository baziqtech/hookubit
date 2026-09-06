import { CROSS_TENANT_MESSAGE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import {
  API_KEY_MIN_LENGTH,
  API_KEY_PREFIX_LENGTH,
  apiKeyPrefix,
  hashApiKey,
  isValidApiKeyShape,
} from '../common/api-key';
import { ApiKeyDto, CreatedApiKeyDto } from './dto';
import { Harness, KEY_IDS, startApiKeysApp } from './testing/harness';

describe('api keys over HTTP', () => {
  let h: Harness;

  const keysOf = (projectId: string): string => `/v1/projects/${projectId}/api-keys`;

  beforeEach(async () => {
    h = await startApiKeysApp();
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('lists only the keys of the project in the path', async () => {
    const res = await h.call<ApiKeyDto[]>('GET', keysOf(IDS.projectA1), { as: IDS.ownerA });

    expect(res.status).toBe(200);
    const ids = (res.body as unknown as ApiKeyDto[]).map((key) => key.id).sort();
    expect(ids).toEqual([KEY_IDS.activeA, KEY_IDS.expiredA, KEY_IDS.revokedA].sort());
    expect(ids).not.toContain(KEY_IDS.foreignB);
  });

  it('404s a member of org A asking for org B\'s project keys', async () => {
    const res = await h.call('GET', keysOf(IDS.projectB1), { as: IDS.ownerA });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('404s - and mints nothing - when org A tries to issue a key in org B\'s project', async () => {
    const before = h.db.all('apiKey').length;

    const res = await h.call('POST', keysOf(IDS.projectB1), {
      as: IDS.ownerA,
      body: { name: 'Trojan' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
    expect(h.db.all('apiKey')).toHaveLength(before);
  });

  it('404s another project\'s key id presented under a project the caller does own', async () => {
    // The nastier shape of the same attack: the path is legitimate, only the
    // resource id is foreign. The tenant predicate is in the WHERE clause, so
    // it matches zero rows rather than being fetched and then checked.
    const res = await h.call('POST', `${keysOf(IDS.projectA1)}/${KEY_IDS.foreignB}/revoke`, {
      as: IDS.ownerA,
    });

    expect(res.status).toBe(404);
    expect(h.db.rows('apiKey').get(KEY_IDS.foreignB)?.revokedAt).toBeNull();
  });

  it('404s a project that no longer exists and one that was soft-deleted, identically', async () => {
    const deleted = await h.call('GET', keysOf(IDS.projectADeleted), { as: IDS.ownerA });
    const absent = await h.call('GET', keysOf('proj_nope'), { as: IDS.ownerA });

    expect(deleted.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(deleted.body.error?.message).toBe(absent.body.error?.message);
  });

  it('401s with no session', async () => {
    const res = await h.call('GET', keysOf(IDS.projectA1));
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  it('403s a viewer, who may not even see the credential inventory', async () => {
    const res = await h.call('GET', keysOf(IDS.projectA1), { as: IDS.viewerA });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });

  it('lets a developer issue keys - that is the integration work', async () => {
    const res = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.developerA,
      body: { name: 'CI ingest' },
    });
    expect(res.status).toBe(201);
  });

  it('403s a write against a suspended project while still allowing the read', async () => {
    const read = await h.call('GET', keysOf(IDS.projectASuspended), { as: IDS.ownerA });
    const write = await h.call('POST', keysOf(IDS.projectASuspended), {
      as: IDS.ownerA,
      body: { name: 'nope' },
    });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // The contract with services/data-plane/internal/ingest/apikey.go
  // -------------------------------------------------------------------------

  it('stores exactly what the Go ingest path looks up, and nothing more', async () => {
    const res = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'Payments ingest' },
    });

    expect(res.status).toBe(201);
    const plaintext = res.body.key;
    const row = h.db.rows('apiKey').get(res.body.id);
    expect(row).toBeDefined();

    // The round trip: apikey.go authenticates by SHA-256 of the FULL plaintext,
    // lowercase hex. If these two ever disagree the symptom is "the customer's
    // key does not work", which reads as a credential problem rather than a bug.
    expect(row?.keyHash).toBe(hashApiKey(plaintext));
    expect(String(row?.keyHash)).toMatch(/^[0-9a-f]{64}$/);

    // The prefix is stored separately, is the first 12 characters, and is what
    // comes back in every subsequent read.
    expect(row?.keyPrefix).toBe(apiKeyPrefix(plaintext));
    expect(String(row?.keyPrefix)).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(res.body.key_prefix).toBe(apiKeyPrefix(plaintext));
    expect(plaintext.startsWith(String(row?.keyPrefix))).toBe(true);

    // Shape and minimum length, both checked by ValidateKeyShape before the Go
    // side will even hash a credential.
    expect(isValidApiKeyShape(plaintext)).toBe(true);
    expect(plaintext.length).toBeGreaterThanOrEqual(API_KEY_MIN_LENGTH);

    // The plaintext itself is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(plaintext);
  });

  it('mints wk_test_ under a test project and wk_live_ under a live one', async () => {
    const test = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'test key' },
    });
    // projectA2 is switched to `live` by the harness.
    const live = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA2), {
      as: IDS.ownerA,
      body: { name: 'live key' },
    });

    expect(test.body.key.startsWith('wk_test_')).toBe(true);
    expect(test.body.environment).toBe('test');
    expect(live.body.key.startsWith('wk_live_')).toBe(true);
    expect(live.body.environment).toBe('live');

    // The ingest path refuses any key whose environment disagrees with its
    // project's (handler.go:169), so this pair must never diverge.
    for (const created of [test, live]) {
      const row = h.db.rows('apiKey').get(created.body.id);
      const project = h.db.rows('project').get(String(row?.projectId));
      expect(row?.environment).toBe(project?.environment);
    }
  });

  it('refuses to let the caller choose the environment', async () => {
    const res = await h.call('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'sneaky', environment: 'live' },
    });

    expect(res.status).toBe(400);
    expect(h.db.all('apiKey').some((row) => row.name === 'sneaky')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Show once, never again
  // -------------------------------------------------------------------------

  it('returns the plaintext exactly once and never again, in any response', async () => {
    const created = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'Payments ingest' },
    });
    const plaintext = created.body.key;
    expect(plaintext).toBeTruthy();

    const list = await h.call<ApiKeyDto[]>('GET', keysOf(IDS.projectA1), { as: IDS.ownerA });
    const listed = (list.body as unknown as ApiKeyDto[]).find((k) => k.id === created.body.id);

    expect(listed).toBeDefined();
    expect(listed?.key_prefix).toBe(created.body.key_prefix);
    // Not the whole key, not the hash, not under any other name.
    expect(JSON.stringify(list.body)).not.toContain(plaintext);
    expect(JSON.stringify(list.body)).not.toContain(hashApiKey(plaintext));
    expect(listed).not.toHaveProperty('key');
    expect(listed).not.toHaveProperty('key_hash');

    // Revocation is the other response that returns a key resource.
    const revoked = await h.call<ApiKeyDto>(
      'POST',
      `${keysOf(IDS.projectA1)}/${created.body.id}/revoke`,
      { as: IDS.ownerA },
    );
    expect(JSON.stringify(revoked.body)).not.toContain(plaintext);
    expect(revoked.body).not.toHaveProperty('key');
  });

  it('never writes a complete key into the audit log', async () => {
    const created = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'Payments ingest' },
    });

    const entry = h.db.all('auditLog')[0];
    expect(entry).toMatchObject({
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: created.body.id,
      organizationId: IDS.orgA,
      userId: IDS.ownerA,
    });
    expect(JSON.stringify(entry)).not.toContain(created.body.key);
    expect(JSON.stringify(entry)).not.toContain(hashApiKey(created.body.key));
    // The prefix IS recorded: it is how an operator ties a log line to a key.
    expect(JSON.stringify(entry)).toContain(created.body.key_prefix);
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  it('accepts a future expiry and reports it', async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const res = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'short lived', expires_at: expires },
    });

    expect(res.status).toBe(201);
    expect(res.body.expires_at).toBe(expires);
    expect(res.body.status).toBe('active');
  });

  it('refuses an expiry in the past rather than minting a key that is born dead', async () => {
    const res = await h.call('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'already dead', expires_at: '2020-01-01T00:00:00.000Z' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
    expect(h.db.all('apiKey').some((row) => row.name === 'already dead')).toBe(false);
  });

  it('labels an expired key without exposing anything about it', async () => {
    const res = await h.call<ApiKeyDto[]>('GET', keysOf(IDS.projectA1), { as: IDS.ownerA });
    const expired = (res.body as unknown as ApiKeyDto[]).find((k) => k.id === KEY_IDS.expiredA);

    expect(expired?.status).toBe('expired');
    expect(expired?.expires_at).toBe('2026-02-01T00:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  it('revokes a key, stamps revoked_at, and audits it', async () => {
    const res = await h.call<ApiKeyDto>(
      'POST',
      `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}/revoke`,
      { as: IDS.adminA },
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(res.body.revoked_at).not.toBeNull();
    expect(h.db.rows('apiKey').get(KEY_IDS.activeA)?.revokedAt).toBeInstanceOf(Date);

    expect(h.db.all('auditLog')).toHaveLength(1);
    expect(h.db.all('auditLog')[0]).toMatchObject({
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: KEY_IDS.activeA,
      userId: IDS.adminA,
    });
  });

  it('keeps a revoked key visible and distinguishable, with the secret still hidden', async () => {
    await h.call('POST', `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}/revoke`, {
      as: IDS.ownerA,
    });

    const list = await h.call<ApiKeyDto[]>('GET', keysOf(IDS.projectA1), { as: IDS.ownerA });
    const keys = list.body as unknown as ApiKeyDto[];
    const revoked = keys.find((k) => k.id === KEY_IDS.activeA);

    // Still listed - a revoked credential that disappears is a credential
    // nobody can audit - but no longer indistinguishable from a live one.
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.key_prefix).toBe('wk_test_seed');
    expect(revoked).not.toHaveProperty('key');
    expect(keys.filter((k) => k.status === 'active')).toHaveLength(0);
  });

  it('is idempotent: a second revoke changes nothing and files no second audit row', async () => {
    const first = await h.call<ApiKeyDto>(
      'POST',
      `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}/revoke`,
      { as: IDS.ownerA },
    );
    const second = await h.call<ApiKeyDto>(
      'POST',
      `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}/revoke`,
      { as: IDS.ownerA },
    );

    expect(second.status).toBe(200);
    expect(second.body.revoked_at).toBe(first.body.revoked_at);
    expect(h.db.all('auditLog')).toHaveLength(1);
  });

  it('reports an already-revoked seeded key as revoked, not active', async () => {
    const res = await h.call<ApiKeyDto>(
      'POST',
      `${keysOf(IDS.projectA1)}/${KEY_IDS.revokedA}/revoke`,
      { as: IDS.ownerA },
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(res.body.revoked_at).toBe('2026-02-01T00:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------

  it('stores validated scopes', async () => {
    const res = await h.call<CreatedApiKeyDto>('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'scoped', scopes: ['events.read', 'deliveries.read'] },
    });

    expect(res.status).toBe(201);
    expect(res.body.scopes).toEqual(['events.read', 'deliveries.read']);
  });

  it('rejects a scope that is not a permission', async () => {
    const res = await h.call('POST', keysOf(IDS.projectA1), {
      as: IDS.ownerA,
      body: { name: 'bogus', scopes: ['events.*'] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
  });

  it('will not let a developer mint a key more powerful than the developer', async () => {
    // api-keys.write is granted to developer on purpose; without this check it
    // would also be a way to manufacture members.write for someone else.
    const res = await h.call('POST', keysOf(IDS.projectA1), {
      as: IDS.developerA,
      body: { name: 'escalation', scopes: ['members.write'] },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
    expect(h.db.all('apiKey').some((row) => row.name === 'escalation')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Surface
  // -------------------------------------------------------------------------

  it('exposes no update route - a credential is revoked and re-issued, not edited', async () => {
    const patch = await h.call('PATCH', `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}`, {
      as: IDS.ownerA,
      body: { name: 'renamed' },
    });
    const put = await h.call('PUT', `${keysOf(IDS.projectA1)}/${KEY_IDS.activeA}`, {
      as: IDS.ownerA,
      body: { name: 'renamed' },
    });

    expect(patch.status).toBe(404);
    expect(put.status).toBe(404);
    expect(h.db.rows('apiKey').get(KEY_IDS.activeA)?.name).toBe('seeded active');
  });

  it('refuses a page size above the repository ceiling', async () => {
    const res = await h.call('GET', `${keysOf(IDS.projectA1)}?limit=5000`, { as: IDS.ownerA });
    expect(res.status).toBe(400);
  });
});
