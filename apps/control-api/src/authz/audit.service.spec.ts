import { Prisma } from '@prisma/client';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { AuditService, REDACTED, isCredentialKey } from './audit.service';
import { TenantResolver } from './tenant-resolver.service';
import { IDS, requestWith, seedWorld, sessionUser } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

async function build(
  userId = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
): Promise<{ db: FakeTenantPrisma; audit: AuditService; context: RequestContext }> {
  const db = seedWorld();
  const context = await new TenantResolver(db.asPrisma()).resolve(
    sessionUser(userId),
    requestWith(params, userId),
    DEFAULT_TENANT_SPEC,
  );
  return { db, audit: new AuditService(db.asPrisma()), context };
}

const metadataOf = (db: FakeTenantPrisma): Record<string, unknown> =>
  db.all('auditLog')[0].metadata as Record<string, unknown>;

describe('AuditService', () => {
  it('writes an entry with a prefixed id, the actor and the resource', async () => {
    const { db, audit, context } = await build();
    const id = await audit.recordFor(context, {
      action: 'endpoint.created',
      resourceType: 'endpoint',
      resourceId: IDS.endpointA1,
    });

    expect(id).toMatch(/^aud_/);
    const [row] = db.all('auditLog');
    expect(row).toMatchObject({
      id,
      organizationId: IDS.orgA,
      userId: IDS.ownerA,
      apiKeyId: null,
      action: 'endpoint.created',
      resourceType: 'endpoint',
      resourceId: IDS.endpointA1,
      ipAddress: '203.0.113.9',
      userAgent: 'jest',
    });
  });

  /**
   * The write itself took a free-form organizationId and a free-form actor, and
   * was exported: any caller could file a row against any organization, in
   * anyone's name. `recordFor` takes all three off the resolved context and is
   * the only door a REQUEST goes through.
   *
   * `recordSystem` is the second and last door, added for periodic sweeps that
   * act on a customer's resource with no request behind them (currently only
   * the endpoint auto-disable in `src/maintenance`). It reopens exactly one of
   * the two holes - a caller-supplied organizationId - and closes the other by
   * construction: it takes no actor at all, so nothing can be filed in a
   * person's name. The `write`-shaped hazard the original hole represented is
   * pinned by the two tests below rather than left to the docblock.
   *
   * This list stays EXHAUSTIVE on purpose. It is not a formality to update
   * alongside a new method; it is the thing that forces the next person adding
   * one to argue for it in review.
   */
  it('exposes no way to name the actor, and only one deliberate way to name the organization', () => {
    const audit = new AuditService({} as never);
    expect((audit as unknown as Record<string, unknown>).record).toBeUndefined();
    expect(Object.getOwnPropertyNames(AuditService.prototype).sort()).toEqual(
      ['constructor', 'recordFor', 'recordSystem', 'write'].sort(),
    );
  });

  it('files a system entry with no actor of any kind', async () => {
    const { db, audit } = await build();
    const id = await audit.recordSystem(IDS.orgA, {
      action: 'endpoint.auto_disabled',
      resourceType: 'endpoint',
      resourceId: IDS.endpointA1,
      metadata: { consecutive_failures: 5 },
    });

    expect(id).toMatch(/^aud_/);
    expect(db.all('auditLog')[0]).toMatchObject({
      id,
      organizationId: IDS.orgA,
      // NULL, not a 'system' sentinel: `user_id` is a foreign key to `users`,
      // and a sentinel would need a row somebody could authenticate as.
      userId: null,
      apiKeyId: null,
      ipAddress: null,
      userAgent: null,
      action: 'endpoint.auto_disabled',
    });
  });

  it('redacts a system entry the same way it redacts a request-driven one', async () => {
    const { db, audit } = await build();
    await audit.recordSystem(IDS.orgA, {
      action: 'endpoint.auto_disabled',
      resourceType: 'endpoint',
      metadata: { signing_secret: 'shhh', last_success_at: '2026-09-06T04:00:00.000Z' },
    });

    const metadata = metadataOf(db);
    expect(metadata.signing_secret).toBe(REDACTED);
    expect(metadata.last_success_at).toBe('2026-09-06T04:00:00.000Z');
  });

  it('fills actor, organization and request metadata from the tenant context', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, { action: 'api_key.revoked', resourceType: 'api_key' });

    expect(db.all('auditLog')[0]).toMatchObject({
      organizationId: IDS.orgA,
      userId: IDS.ownerA,
      ipAddress: '203.0.113.9',
      userAgent: 'jest',
      metadata: { project_id: IDS.projectA1 },
    });
  });

  it('records the project an action happened in, since audit_logs has no project column', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint.updated',
      resourceType: 'endpoint',
      metadata: { url: 'https://new.example.com' },
    });

    expect(metadataOf(db)).toEqual({
      project_id: IDS.projectA1,
      url: 'https://new.example.com',
    });
  });

  /**
   * The resolved id used to be spread FIRST, so caller metadata won: a
   * `project_id` key anywhere in a spread DTO rewrote the fact the row exists
   * to record, and nothing downstream could tell.
   */
  it('cannot be told which project an action happened in', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint.deleted',
      resourceType: 'endpoint',
      metadata: { project_id: IDS.projectB1, note: 'forged' },
    });

    expect(metadataOf(db).project_id).toBe(IDS.projectA1);
  });

  it('omits the project key on an organization-level action', async () => {
    const { db, audit, context } = await build(IDS.ownerA, { orgId: IDS.orgA });
    await audit.recordFor(context, { action: 'member.invited', resourceType: 'member' });
    // DbNull, i.e. the column is left SQL NULL rather than holding `{}`.
    expect(db.all('auditLog')[0].metadata).toBe(Prisma.DbNull);
  });

  it('redacts credential-shaped metadata keys but keeps references', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint.secret_rotated',
      resourceType: 'endpoint',
      metadata: {
        api_key_id: 'key_123',
        signing_secret: 'shhh',
        password: 'hunter2',
        reset_token: 'abc',
        version: 2,
      },
    });

    expect(metadataOf(db)).toEqual({
      project_id: IDS.projectA1,
      api_key_id: 'key_123',
      signing_secret: '[redacted]',
      password: '[redacted]',
      reset_token: '[redacted]',
      version: 2,
    });
  });

  /**
   * THE RULE, both directions, on the keys that actually bit.
   *
   * The old filter was a bare substring match, so every key CONTAINING one of
   * the credential words was redacted: `previous_secrets_expire_at` - a
   * timestamp, and the only fact the `endpoint_secret.rotated` row is opened to
   * answer - came back `[redacted]`, and the workaround was to rename the key.
   * The same trap then caught the next key that module added. These two tables
   * are the fix: a rule about the key's terminal word, not a list of names
   * somebody remembered to exempt.
   */
  describe('the credential-key rule', () => {
    it.each([
      'secret',
      'secrets',
      'api_key',
      'apiKey',
      'x-api-key',
      'key',
      'authorization',
      'signing_secret',
      'signingSecret',
      'password',
      'reset_token',
      'rawToken',
      'client_credentials',
      'private_key',
      'key_hash',
      'signature',
      // Ambiguous on purpose: a false negative writes a live secret into a
      // table every `audit.read` holder can query, so these still go.
      'secret_value',
      'signature_algorithm',
    ])('redacts %s', (key) => {
      expect(isCredentialKey(key)).toBe(true);
    });

    it.each([
      // The one that bit first: a timestamp, not a secret.
      'previous_secrets_expire_at',
      // ...and the one that bit the same author immediately afterwards.
      'awaiting_key_handover',
      'secret_version',
      'key_prefix',
      'endpoint_secret_id',
      'api_key_id',
      'apiKeyId',
      'endpoint_ids',
      'token_count',
      'created_by_user_id',
      'name',
      'url',
    ])('keeps %s', (key) => {
      expect(isCredentialKey(key)).toBe(false);
    });
  });

  it('keeps the credential-shaped metadata the audit log is read for', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint_secret.rotated',
      resourceType: 'endpoint_secret',
      metadata: {
        // Every one of these was destroyed by the old substring rule, or was
        // one rename away from being destroyed by it.
        previous_secrets_expire_at: '2026-03-01T00:00:00.000Z',
        secret_version: 4,
        key_prefix: 'wk_test_seed',
        awaiting_key_handover: false,
        endpoint_secret_id: 'eps_1',
        // ...and the things that must still go.
        signing_secret: 'whsec_live_plaintext',
        api_key: 'wk_live_plaintext',
        authorization: 'Bearer abc',
      },
    });

    expect(metadataOf(db)).toEqual({
      project_id: IDS.projectA1,
      previous_secrets_expire_at: '2026-03-01T00:00:00.000Z',
      secret_version: 4,
      key_prefix: 'wk_test_seed',
      awaiting_key_handover: false,
      endpoint_secret_id: 'eps_1',
      signing_secret: REDACTED,
      api_key: REDACTED,
      authorization: REDACTED,
    });
  });

  /**
   * The whole reason the redaction exists: someone spreads a DTO. A top-level
   * walk copied the nested object by reference and wrote the plaintext HMAC
   * secret into a table every `audit.read` holder can query.
   */
  it('redacts NESTED credentials, including inside arrays', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint.updated',
      resourceType: 'endpoint',
      metadata: {
        endpoint: {
          id: IDS.endpointA1,
          url: 'https://a.example.com/hook',
          secret: 'whsec_live_plaintext',
          auth: { authorization: 'Bearer abc', headers: { 'x-api-key': 'k' } },
        },
        secrets: [
          { version: 1, signing_secret: 'one' },
          { version: 2, signing_secret: 'two' },
        ],
      },
    });

    expect(metadataOf(db)).toEqual({
      project_id: IDS.projectA1,
      endpoint: {
        id: IDS.endpointA1,
        url: 'https://a.example.com/hook',
        secret: '[redacted]',
        auth: { authorization: '[redacted]', headers: { 'x-api-key': '[redacted]' } },
      },
      // The key name `secrets` is itself credential-shaped, so the array never
      // gets walked - it is replaced wholesale.
      secrets: '[redacted]',
    });
    expect(JSON.stringify(metadataOf(db))).not.toContain('whsec_live_plaintext');
  });

  it('walks a class instance spread into metadata like the object it serialises to', async () => {
    class EndpointDto {
      constructor(
        readonly name: string,
        readonly signingSecret: string,
      ) {}
    }
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'endpoint.created',
      resourceType: 'endpoint',
      metadata: { dto: new EndpointDto('a1', 'whsec_live') },
    });

    expect(metadataOf(db).dto).toEqual({ name: 'a1', signingSecret: '[redacted]' });
  });

  it('truncates past a depth cap rather than recursing forever on a cycle', async () => {
    const cyclic: Record<string, unknown> = { level: 0 };
    cyclic.self = cyclic;
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'project.updated',
      resourceType: 'project',
      metadata: { root: cyclic },
    });

    expect(JSON.stringify(metadataOf(db))).toContain('[truncated]');
  });

  it('keeps scalars, dates and nulls readable', async () => {
    const { db, audit, context } = await build();
    await audit.recordFor(context, {
      action: 'project.updated',
      resourceType: 'project',
      metadata: { at: new Date('2026-01-02T03:04:05.000Z'), count: 3, on: true, gone: null },
    });

    expect(metadataOf(db)).toMatchObject({
      at: '2026-01-02T03:04:05.000Z',
      count: 3,
      on: true,
      gone: null,
    });
  });

  it('writes through a supplied transaction client, so the row commits with the change', async () => {
    const { db, audit, context } = await build();
    await db.asPrisma().$transaction(async (tx) => {
      await audit.recordFor(context, { action: 'project.deleted', resourceType: 'project' }, tx);
    });
    expect(db.all('auditLog')).toHaveLength(1);
  });
});
