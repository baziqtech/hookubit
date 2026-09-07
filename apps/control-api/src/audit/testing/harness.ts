import {
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantResolver,
  TenantScopeFactory,
} from '../../authz';
import { IDS, requestWith, seedWorld, sessionUser } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { AuditLogsService } from '../audit-logs.service';

/**
 * Test wiring for the audit module.
 *
 * The context is resolved through the REAL `TenantResolver` against the shared
 * two-tenant fixture, exactly as production resolves it, so a test that says
 * "org A's owner cannot see org B's rows" is exercising the whole path rather
 * than a hand-built context that could be wrong in the caller's favour.
 *
 * `created_at` is seeded as an ISO STRING rather than a `Date`. That is a
 * concession to `FakeTenantPrisma`, which compares `gt`/`gte`/`lt`/`lte`
 * operands with `String(value)`: ISO strings compare correctly that way and
 * `Date.prototype.toString()` ("Mon Sep 07 2026 ...") does not. It is also why
 * the date-range assertions in this suite check the WHERE that reaches the
 * delegate, not just the rows that come back - see the note there.
 * `toAuditLogDto` normalises through `new Date(...)`, so both shapes render the
 * same ISO-8601 string on the wire.
 */
export interface AuditHarness {
  db: FakeTenantPrisma;
  scopes: TenantScopeFactory;
  service: AuditLogsService;
  contextA: RequestContext;
  contextB: RequestContext;
}

export interface SeededRow {
  id: string;
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export function seedAuditRow(db: FakeTenantPrisma, row: SeededRow): void {
  db.insert('auditLog', {
    apiKeyId: null,
    userId: null,
    resourceId: null,
    metadata: null,
    ipAddress: '203.0.113.9',
    userAgent: 'jest',
    ...row,
  });
}

/**
 * A trail with the shape a real one has: two tenants, several actors, several
 * resource types, and a row in org B for every isolation assertion to fail
 * against if the predicate is ever dropped.
 */
export function seedTrail(db: FakeTenantPrisma): void {
  seedAuditRow(db, {
    id: 'aud_a1',
    organizationId: IDS.orgA,
    userId: IDS.ownerA,
    action: 'endpoint.created',
    resourceType: 'endpoint',
    resourceId: IDS.endpointA1,
    metadata: { name: 'finance', signing_secret: '[redacted]' },
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  seedAuditRow(db, {
    id: 'aud_a2',
    organizationId: IDS.orgA,
    userId: IDS.adminA,
    action: 'endpoint.disabled',
    resourceType: 'endpoint',
    resourceId: IDS.endpointA1,
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  seedAuditRow(db, {
    id: 'aud_a3',
    organizationId: IDS.orgA,
    userId: IDS.adminA,
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: 'ak_a1',
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  seedAuditRow(db, {
    id: 'aud_a4',
    organizationId: IDS.orgA,
    userId: IDS.ownerA,
    action: 'member.role_changed',
    resourceType: 'member',
    resourceId: `mem_${IDS.viewerA}_${IDS.orgA}`,
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  // The row every isolation test in this suite exists to NOT return.
  seedAuditRow(db, {
    id: 'aud_b1',
    organizationId: IDS.orgB,
    userId: IDS.ownerB,
    action: 'endpoint.created',
    resourceType: 'endpoint',
    resourceId: IDS.endpointB1,
    createdAt: '2026-09-05T00:00:00.000Z',
  });
}

export async function auditHarness(): Promise<AuditHarness> {
  const db = seedWorld();
  seedTrail(db);
  const resolver = new TenantResolver(db.asPrisma());
  const contextA = await resolver.resolve(
    sessionUser(IDS.ownerA),
    requestWith({ orgId: IDS.orgA }, IDS.ownerA),
    DEFAULT_TENANT_SPEC,
  );
  const contextB = await resolver.resolve(
    sessionUser(IDS.ownerB),
    requestWith({ orgId: IDS.orgB }, IDS.ownerB),
    DEFAULT_TENANT_SPEC,
  );
  const scopes = new TenantScopeFactory(db.asPrisma());
  return { db, scopes, service: new AuditLogsService(scopes), contextA, contextB };
}

/**
 * The clauses of the last WHERE the fake evaluated against `audit_logs`.
 *
 * `ScopedRepository.where()` emits `{ AND: [<tenant predicate>, <caller filter>] }`,
 * so `[0]` is the fence and `[1]` - when present - is what the service built
 * from the query string. Asserting on this is how the date range is proved to
 * reach SQL: `FakeTenantPrisma` compares range operands as strings and cannot
 * be trusted to evaluate a `Date` bound the way PostgreSQL would, so a test
 * that only counted returned rows could pass while the predicate was wrong.
 */
export function lastAuditWhere(db: FakeTenantPrisma): {
  tenant: Record<string, unknown>;
  filter: Record<string, unknown>;
} {
  const found = [...db.queries].reverse().find((query) => query.table === 'auditLog');
  if (!found?.where) throw new Error('no audit_logs query was issued');
  const clauses = (found.where as { AND?: unknown[] }).AND;
  if (!Array.isArray(clauses)) throw new Error('audit_logs was queried without a tenant fence');
  return {
    tenant: clauses[0] as Record<string, unknown>,
    filter: (clauses[1] ?? {}) as Record<string, unknown>,
  };
}

/** Every mutating operation the fake saw on `audit_logs`. Must always be empty. */
export function auditMutations(db: FakeTenantPrisma): string[] {
  return db.queries
    .filter((query) => query.table === 'auditLog' && query.op !== 'find')
    .map((query) => query.op);
}
