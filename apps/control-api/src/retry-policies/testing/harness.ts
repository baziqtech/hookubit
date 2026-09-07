import {
  AuditService,
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantResolver,
  TenantScopeFactory,
  TenantSpec,
} from '../../authz';
import { IDS, requestWith, seedWorld, sessionUser } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { SerializableTransactionRunner } from '../../endpoint-secrets/testing/harness';
import { TenantTransactionRunner } from '../../organizations/tenant-transaction';
import { RetryPoliciesService } from '../retry-policies.service';

/**
 * Test wiring for the retry-policies module.
 *
 * The context is built the way production builds it — by resolving a real
 * request through `TenantResolver` against the shared two-tenant fixture — so
 * these suites exercise the whole path rather than a hand-made context that
 * could be wrong in the caller's favour. The repository is the UNMODIFIED
 * `ScopedRepository`: no shim, no patched factory.
 *
 * `SerializableTransactionRunner` (from the endpoint-secrets harness) models
 * SERIALIZABLE as a serial schedule, which is the strongest thing SERIALIZABLE
 * can be equivalent to and therefore a faithful, conservative stand-in. It does
 * NOT model rollback and never aborts an attempt, so the real runner's retry
 * loop is unexercised here — stated so no test leans on it.
 */
export interface RetryPolicyHarness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  audit: AuditService;
  transactions: TenantTransactionRunner;
  policies: RetryPoliciesService;
}

/**
 * `seedWorld` is the authorization layer's fixture: it seeds only the columns
 * that layer's predicates read, so its `retry_policies` rows have no strategy,
 * no timestamps and no `is_default`. That is a shape PostgreSQL cannot produce
 * (every one of those columns is NOT NULL with a default), so it is filled in
 * here rather than by making the response mapper tolerate impossible rows.
 *
 * Each project's seeded policy is marked as ITS OWN default, because "a project
 * with policies has exactly one default" is the invariant under test and a
 * fixture that starts in violation of it would make every assertion ambiguous.
 */
export function backfillPolicies(db: FakeTenantPrisma): FakeTenantPrisma {
  const now = new Date('2026-01-01T00:00:00.000Z');
  for (const row of db.all('retryPolicy')) {
    db.rows('retryPolicy').set(String(row.id), {
      isDefault: true,
      strategy: 'exponential',
      maxAttempts: 8,
      initialDelayMs: 5_000,
      maxDelayMs: 3_600_000,
      multiplier: 2,
      jitterRatio: 0.2,
      maxRetryDurationMs: 86_400_000,
      createdAt: now,
      updatedAt: now,
      ...row,
    });
  }
  for (const table of ['endpoint', 'rateLimitPolicy'] as const) {
    for (const row of db.all(table)) {
      db.rows(table).set(String(row.id), { createdAt: now, updatedAt: now, ...row });
    }
  }
  // `seedWorld` has no API keys, and ingest-scoped rate limits name one.
  if (db.all('apiKey').length === 0) {
    db.insert('apiKey', { id: API_KEYS.a1, projectId: IDS.projectA1, name: 'a1', status: 'active' });
    db.insert('apiKey', { id: API_KEYS.b1, projectId: IDS.projectB1, name: 'b1', status: 'active' });
  }
  return db;
}

export const API_KEYS = { a1: 'key_a1', b1: 'key_b1' } as const;

export async function retryHarness(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  db: FakeTenantPrisma = seedWorld(),
  spec: TenantSpec = DEFAULT_TENANT_SPEC,
): Promise<RetryPolicyHarness> {
  backfillPolicies(db);
  const resolver = new TenantResolver(db.asPrisma());
  const context = await resolver.resolve(sessionUser(userId), requestWith(params, userId), spec);

  const scopes = new TenantScopeFactory(db.asPrisma());
  const audit = new AuditService(db.asPrisma());
  const transactions = new SerializableTransactionRunner(db, scopes, audit);
  const policies = new RetryPoliciesService(scopes, transactions);

  return { db, context, scopes, audit, transactions, policies };
}

/**
 * THE PROPERTY, restated where the tests can call it, and read straight off the
 * fake's rows rather than through the service.
 *
 * The bug class being guarded is a service that believes the invariant holds
 * while the table says otherwise, so a check that asks the service is a check
 * that would have passed the whole time.
 */
export function assertExactlyOneDefault(db: FakeTenantPrisma, projectId: string): void {
  const policies = db.all('retryPolicy').filter((row) => row.projectId === projectId);
  if (policies.length === 0) return;
  const defaults = policies.filter((row) => row.isDefault === true);
  if (defaults.length === 1) return;
  throw new Error(
    `invariant violated: project ${projectId} has ${policies.length} retry policies and ` +
      `${defaults.length} of them are the default (${defaults
        .map((row) => String(row.id))
        .join(', ')}). The delivery workers have ${
        defaults.length === 0 ? 'no' : 'more than one'
      } answer to "which backoff applies here".`,
  );
}

export function defaultIdsIn(db: FakeTenantPrisma, projectId: string): string[] {
  return db
    .all('retryPolicy')
    .filter((row) => row.projectId === projectId && row.isDefault === true)
    .map((row) => String(row.id));
}
