import { Prisma } from '@prisma/client';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { AuditService } from './audit.service';
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

describe('AuditService', () => {
  it('writes an entry with a prefixed id, the actor and the resource', async () => {
    const { db, audit } = await build();
    const id = await audit.record(
      IDS.orgA,
      { userId: IDS.ownerA, ipAddress: '198.51.100.4', userAgent: 'curl/8' },
      { action: 'endpoint.created', resourceType: 'endpoint', resourceId: IDS.endpointA1 },
    );

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
      ipAddress: '198.51.100.4',
      userAgent: 'curl/8',
    });
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

    expect(db.all('auditLog')[0].metadata).toEqual({
      project_id: IDS.projectA1,
      url: 'https://new.example.com',
    });
  });

  it('omits the project key on an organization-level action', async () => {
    const { db, audit, context } = await build(IDS.ownerA, { orgId: IDS.orgA });
    await audit.recordFor(context, { action: 'member.invited', resourceType: 'member' });
    // DbNull, i.e. the column is left SQL NULL rather than holding `{}`.
    expect(db.all('auditLog')[0].metadata).toBe(Prisma.DbNull);
  });

  it('redacts credential-shaped metadata keys but keeps references', async () => {
    const { db, audit } = await build();
    await audit.record(
      IDS.orgA,
      { userId: IDS.ownerA },
      {
        action: 'endpoint.secret_rotated',
        resourceType: 'endpoint',
        metadata: {
          api_key_id: 'key_123',
          signing_secret: 'shhh',
          password: 'hunter2',
          reset_token: 'abc',
          version: 2,
        },
      },
    );

    expect(db.all('auditLog')[0].metadata).toEqual({
      api_key_id: 'key_123',
      signing_secret: '[redacted]',
      password: '[redacted]',
      reset_token: '[redacted]',
      version: 2,
    });
  });

  it('writes through a supplied transaction client, so the row commits with the change', async () => {
    const { db, audit, context } = await build();
    await db.asPrisma().$transaction(async (tx) => {
      await audit.recordFor(context, { action: 'project.deleted', resourceType: 'project' }, tx);
    });
    expect(db.all('auditLog')).toHaveLength(1);
  });

  it('records an API key actor with no user', async () => {
    const { db, audit } = await build();
    await audit.record(
      IDS.orgA,
      { apiKeyId: 'key_1' },
      { action: 'event.ingested', resourceType: 'event', resourceId: IDS.eventA1 },
    );
    expect(db.all('auditLog')[0]).toMatchObject({ userId: null, apiKeyId: 'key_1' });
  });
});
