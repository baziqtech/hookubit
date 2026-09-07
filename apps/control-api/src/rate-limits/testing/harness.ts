import {
  AuditService,
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantScopeFactory,
  TenantResolver,
  TenantSpec,
} from '../../authz';
import { IDS, requestWith, seedWorld, sessionUser } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { SerializableTransactionRunner } from '../../endpoint-secrets/testing/harness';
import { TenantTransactionRunner } from '../../organizations/tenant-transaction';
import { API_KEYS, backfillPolicies } from '../../retry-policies/testing/harness';
import { RateLimitsService } from '../rate-limits.service';

/**
 * Test wiring for the rate-limits module. Same shape and same argument as the
 * retry-policies harness: a context resolved through the real `TenantResolver`
 * against the shared two-tenant fixture, and the UNMODIFIED `ScopedRepository`.
 *
 * `backfillPolicies` is shared with the retry-policies harness because it also
 * seeds the API keys — `seedWorld` has none, and an ingest-scoped rate limit
 * names one.
 */
export interface RateLimitHarness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  audit: AuditService;
  transactions: TenantTransactionRunner;
  rateLimits: RateLimitsService;
}

export { API_KEYS };

export async function rateLimitHarness(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  db: FakeTenantPrisma = seedWorld(),
  spec: TenantSpec = DEFAULT_TENANT_SPEC,
): Promise<RateLimitHarness> {
  backfillPolicies(db);
  const resolver = new TenantResolver(db.asPrisma());
  const context = await resolver.resolve(sessionUser(userId), requestWith(params, userId), spec);

  const scopes = new TenantScopeFactory(db.asPrisma());
  const audit = new AuditService(db.asPrisma());
  const transactions = new SerializableTransactionRunner(db, scopes, audit);
  const rateLimits = new RateLimitsService(scopes, transactions);

  return { db, context, scopes, audit, transactions, rateLimits };
}

/**
 * THE PROPERTY the NULLS NOT DISTINCT index exists to hold, read straight off
 * the rows rather than through the service.
 *
 * PostgreSQL indexes are NULLS DISTINCT by default, so before migration
 * `20260906010000` the generated constraint enforced nothing on exactly the row
 * that mattered: `resource_id IS NULL`, the one that means "every resource in
 * this scope". Two of those with different limits give the data plane two
 * answers to one question.
 */
export function assertUniqueScopeResourcePairs(
  db: FakeTenantPrisma,
  projectId: string,
): void {
  const seen = new Map<string, string[]>();
  for (const row of db.all('rateLimitPolicy')) {
    if (row.projectId !== projectId) continue;
    // NULL is a VALUE in this key, not an absence - that is the whole point.
    const key = `${String(row.scope)}::${row.resourceId === null || row.resourceId === undefined ? '<null>' : String(row.resourceId)}`;
    seen.set(key, [...(seen.get(key) ?? []), String(row.id)]);
  }
  const duplicated = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicated.length === 0) return;
  throw new Error(
    `invariant violated: project ${projectId} holds duplicate rate limits for ${duplicated
      .map(([key, ids]) => `${key} (${ids.join(', ')})`)
      .join('; ')}. The data plane has more than one ceiling for one resource and no rule for choosing.`,
  );
}

export function policiesIn(db: FakeTenantPrisma, projectId: string): Record<string, unknown>[] {
  return db.all('rateLimitPolicy').filter((row) => row.projectId === projectId);
}
