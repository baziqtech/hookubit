import { IDS } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { TenantResolver, TenantScopeFactory, DEFAULT_TENANT_SPEC } from '../authz';
import { requestWith, seedWorld, sessionUser } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { ProjectTemplateService } from './project-template.service';

const SOURCE = IDS.projectA1;
const TARGET = 'proj_a_copy';

async function world() {
  const db = seedWorld();
  backfill(db);

  const resolver = new TenantResolver(db.asPrisma());
  const context = await resolver.resolve(
    sessionUser(IDS.ownerA),
    requestWith({ orgId: IDS.orgA, projectId: TARGET }, IDS.ownerA),
    DEFAULT_TENANT_SPEC,
  );

  return { db, context, service: new ProjectTemplateService(new TenantScopeFactory(db.asPrisma())) };
}

/** The empty project the copy lands in, plus timestamps `seedWorld` omits. */
function backfill(db: FakeTenantPrisma): void {
  const now = new Date('2026-01-01T00:00:00.000Z');
  db.insert('project', {
    id: TARGET,
    organizationId: IDS.orgA,
    name: 'Copy',
    slug: 'copy',
    environment: 'live',
    status: 'active',
    allowedIps: [],
    createdAt: now,
    updatedAt: now,
  });
  for (const table of ['project', 'endpoint'] as const) {
    for (const row of db.all(table)) {
      if (!row.createdAt) db.rows(table).set(String(row.id), { ...row, createdAt: now, updatedAt: now });
    }
  }
}

function endpoint(db: FakeTenantPrisma, id: string, projectId: string, extra: Record<string, unknown> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  db.insert('endpoint', {
    id,
    projectId,
    name: id,
    url: `https://${id}.example.test/hook`,
    description: null,
    status: 'active',
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    timeoutMs: 12_000,
    maxConcurrency: 4,
    rateLimit: 500,
    rateLimitWindowSeconds: 60,
    retryPolicyId: null,
    customHeaders: { 'X-Tenant': 'acme' },
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

/**
 * Copying a project.
 *
 * Every test here is about one of the two rules that make this safe to offer:
 * a copied endpoint cannot send, and a secret is never copied.
 */
describe('ProjectTemplateService', () => {
  it('copies endpoints PAUSED, with no secret and a reason saying why', async () => {
    // The URL points at the SOURCE project's server, very often the test one.
    // An endpoint that arrived live would start delivering real traffic to a
    // staging box the moment the first event was published.
    const { db, context, service } = await world();
    endpoint(db, 'ep_src', SOURCE);

    const result = await service.copy(context, SOURCE, TARGET);

    expect(result.endpoints).toBeGreaterThan(0);
    expect(result.signing_secrets).toBe(0);

    const copied = db.all('endpoint').filter((row) => row.projectId === TARGET);
    expect(copied.length).toBe(result.endpoints);
    for (const row of copied) {
      expect(row.status).toBe('paused');
      expect(row.enabled).toBe(false);
      expect(String(row.disabledReason)).toContain('signing secret');
    }
  });

  it('carries the delivery settings across, because those are the work', async () => {
    const { db, context, service } = await world();
    endpoint(db, 'ep_src', SOURCE);

    await service.copy(context, SOURCE, TARGET);

    const copied = db.all('endpoint').find((row) => row.projectId === TARGET && row.name === 'ep_src');
    expect(copied).toMatchObject({
      timeoutMs: 12_000,
      maxConcurrency: 4,
      rateLimit: 500,
      rateLimitWindowSeconds: 60,
      customHeaders: { 'X-Tenant': 'acme' },
    });
  });

  it('copies NO signing secrets at all', async () => {
    // The rule that makes the whole feature safe: a leak in one project stays
    // in one project. A copied secret means two projects one stolen value can
    // forge requests for, and the customer does not know the second exists.
    const { db, context, service } = await world();
    endpoint(db, 'ep_src', SOURCE);
    db.insert('endpointSecret', {
      id: 'sec_src',
      endpointId: 'ep_src',
      secretEncrypted: 'enc',
      version: 1,
      active: true,
      createdAt: new Date(),
      expiresAt: null,
      rotatedAt: null,
    });

    await service.copy(context, SOURCE, TARGET);

    const copiedEndpointIds = new Set(
      db.all('endpoint').filter((row) => row.projectId === TARGET).map((row) => row.id),
    );
    const leaked = db
      .all('endpointSecret')
      .filter((row) => copiedEndpointIds.has(row.endpointId as string));
    expect(leaked).toEqual([]);
  });

  it('refuses a source in another organization', async () => {
    const { context, service } = await world();
    await expect(service.copy(context, IDS.projectB1, TARGET)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to copy a project into itself', async () => {
    const { context, service } = await world();
    await expect(service.copy(context, TARGET, TARGET)).rejects.toBeInstanceOf(AppError);
  });
});
