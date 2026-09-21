import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  AuditService,
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantResolver,
  TenantScope,
  TenantScopeFactory,
  TenantSpec,
} from '../../authz';
import { requestWith, seedWorld, sessionUser } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { CryptoService } from '../../common/crypto.service';
import { EndpointHealthService } from '../../endpoints/endpoint-health.service';
import { EndpointsService } from '../../endpoints/endpoints.service';
import {
  TenantAudit,
  TenantTransactionRunner,
} from '../../organizations/tenant-transaction';
import { EndpointSecretsService } from '../endpoint-secrets.service';

/**
 * Test wiring for the endpoints and endpoint-secrets modules.
 *
 * The context is built the way production builds it - by resolving a real
 * request through `TenantResolver` against the shared two-tenant fixture - so
 * these suites exercise the whole path, not a hand-made context that could be
 * wrong in the caller's favour.
 *
 * There is no longer a scope shim here. `withCreatableSecrets` stood in for the
 * `PARENT_KEY` change in `src/authz/tenant-scope.ts`; that change has landed, so
 * `scope.endpointSecrets.create` resolves the parent endpoint through its own
 * scoped repository on its own and these suites run against the UNMODIFIED
 * repository. The "sanity" block at the end of the secrets suite is what keeps
 * that honest: it asserts the real repository still refuses a create under
 * another tenant's endpoint.
 */

/**
 * `TenantTransactionRunner` over the fake, with the one property PostgreSQL
 * gives the real one and an in-memory map does not: SERIALIZABLE.
 *
 * The real runner opens every transaction at
 * `Prisma.TransactionIsolationLevel.Serializable` and replays it when SSI
 * aborts it. That is what makes two concurrent revokes - each checking a SET of
 * rows and writing a DIFFERENT row in it - come out as if they had run one
 * after the other. `FakeTenantPrisma.$transaction` just calls the callback
 * against shared state, so without this the concurrency test would be
 * exercising the interleaving and not the fix.
 *
 * A serial schedule is the strongest thing SERIALIZABLE can be equivalent to,
 * so running one transaction at a time is a faithful (conservative) stand-in:
 * a callback that reads, checks and writes entirely inside `run` comes out
 * correct here exactly as it does in production, and one that reads its
 * snapshot OUTSIDE the transaction - the shape being fixed - still races.
 *
 * Two things it does NOT model, stated so no test leans on them: there is no
 * rollback (the fake has no undo, so a callback that throws after a write
 * leaves the write), and no attempt is ever aborted, so the runner's retry loop
 * is not exercised here.
 */
export class SerializableTransactionRunner extends TenantTransactionRunner {
  /** The tail of the serial schedule. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fake: FakeTenantPrisma,
    private readonly factory: TenantScopeFactory,
    private readonly auditor: AuditService,
  ) {
    super(fake.asPrisma(), factory, auditor);
  }

  override async run<T>(
    context: RequestContext,
    fn: (scope: TenantScope, audit: TenantAudit) => Promise<T>,
  ): Promise<T> {
    // Whatever is already running finishes first, however it ends.
    const attempt = this.queue.then(
      () => this.commit(context, fn),
      () => this.commit(context, fn),
    );
    // The queue only ever tracks completion; a rejection is the caller's, and
    // swallowing it here keeps it from surfacing as an unhandled one.
    this.queue = attempt.catch(() => undefined);
    return attempt;
  }

  private async commit<T>(
    context: RequestContext,
    fn: (scope: TenantScope, audit: TenantAudit) => Promise<T>,
  ): Promise<T> {
    const tx = this.fake.asPrisma();
    const audit: TenantAudit = {
      record: async (entry): Promise<void> => {
        await this.auditor.recordFor(context, entry, tx);
      },
    };
    return fn(this.factory.for(context, tx), audit);
  }
}

/** For the HTTP suite, which needs the factory as a Nest provider value. */
export function testScopeFactory(db: FakeTenantPrisma): TenantScopeFactory {
  return new TenantScopeFactory(db.asPrisma());
}

/** The transaction runner the HTTP suite must provide alongside it. */
export function testTransactions(
  db: FakeTenantPrisma,
  scopes: TenantScopeFactory,
  audit: AuditService,
): TenantTransactionRunner {
  return new SerializableTransactionRunner(db, scopes, audit);
}

export interface Harness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  crypto: CryptoService;
  audit: AuditService;
  transactions: TenantTransactionRunner;
  secrets: EndpointSecretsService;
  endpoints: EndpointsService;
}

export { backfillTimestamps };

export const TEST_ENCRYPTION_KEY = randomBytes(32).toString('base64');

export function buildCrypto(key: string = TEST_ENCRYPTION_KEY): CryptoService {
  const values: Record<string, string> = { ENCRYPTION_KEY: key };
  return new CryptoService({
    getOrThrow: (name: string): string => {
      const value = values[name];
      if (value === undefined) throw new Error(`missing ${name}`);
      return value;
    },
    get: (name: string): string | undefined => values[name],
  } as unknown as ConfigService);
}

/**
 * @param params route parameters, e.g. `{ projectId }` for the endpoints
 *               controller or `{ endpointId }` with an endpoint anchor.
 */
export async function harnessFor(
  userId: string,
  params: Record<string, string>,
  spec: TenantSpec = DEFAULT_TENANT_SPEC,
  db: FakeTenantPrisma = seedWorld(),
): Promise<Harness> {
  backfillTimestamps(db);
  const resolver = new TenantResolver(db.asPrisma());
  const context = await resolver.resolve(sessionUser(userId), requestWith(params, userId), spec);

  const scopes = new TenantScopeFactory(db.asPrisma());
  const crypto = buildCrypto();
  const audit = new AuditService(db.asPrisma());
  const transactions = new SerializableTransactionRunner(db, scopes, audit);
  const secrets = new EndpointSecretsService(scopes, crypto, audit, transactions);
  const endpoints = new EndpointsService(scopes, audit, secrets, new EndpointHealthService(scopes));

  return { db, context, scopes, crypto, audit, transactions, secrets, endpoints };
}

/**
 * `seedWorld` is the authorization layer's fixture and seeds only the columns
 * that layer's predicates read - it has no `created_at`, because nothing in
 * `src/authz` renders a row. These modules do render rows, and the columns are
 * `NOT NULL DEFAULT now()` in the schema, so a seeded row without them is a
 * shape the database cannot produce. Filling them here keeps that a fixture
 * limitation rather than a reason to make the response mapper tolerate
 * impossible input.
 */
function backfillTimestamps(db: FakeTenantPrisma): FakeTenantPrisma {
  const now = new Date('2026-01-01T00:00:00.000Z');
  for (const table of ['endpoint', 'endpointSecret'] as const) {
    for (const row of db.all(table)) {
      db.rows(table).set(String(row.id), {
        createdAt: now,
        updatedAt: now,
        ...(table === 'endpointSecret' ? { active: true, expiresAt: null } : {}),
        ...row,
      });
    }
  }
  return db;
}

/** The endpoint anchor used by `/v1/endpoints/:endpointId/secrets`. */
export const ENDPOINT_ANCHOR: TenantSpec = {
  from: 'anchor',
  kind: 'endpoint',
  param: 'endpointId',
};
