import { ConfigService } from '@nestjs/config';
import { EndpointSecret } from '@prisma/client';
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
import { AppError } from '../../common/errors';
import { EndpointsService } from '../../endpoints/endpoints.service';
import { EndpointSecretsService } from '../endpoint-secrets.service';

/**
 * Test wiring for the endpoints and endpoint-secrets modules.
 *
 * The context is built the way production builds it - by resolving a real
 * request through `TenantResolver` against the shared two-tenant fixture - so
 * these suites exercise the whole path, not a hand-made context that could be
 * wrong in the caller's favour.
 *
 * ---------------------------------------------------------------------------
 * ## `withCreatableSecrets` - READ THIS, IT IS TEMPORARY
 *
 * `ScopedRepository.create` refuses every `viaEndpoint` table, because those
 * rows have no tenant column to stamp:
 *
 *     Endpoint secret rows are scoped through a parent and cannot be created by
 *     a scoped repository; create them alongside their parent inside a
 *     transaction.
 *
 * Rotation is exactly that write - a new `endpoint_secrets` row for an existing
 * endpoint - and `PrismaService` is banned in these modules, correctly. The
 * accepted fix is a small change in `src/authz/tenant-scope.ts`, spelled out
 * verbatim in `apps/control-api/HANDOFF.md`; it is not applied here because
 * `src/authz` belongs to another owner.
 *
 * So this shim stands in for that change, and it implements EXACTLY what the
 * change does and nothing more:
 *
 *   1. require a `endpointId` in the payload, and
 *   2. resolve it through `scope.endpoints` - the sibling scoped repository -
 *      so a parent in another tenant is a 404 before any insert happens,
 *   3. then insert.
 *
 * That means the isolation tests below are not vacuous: creating a secret under
 * another tenant's endpoint fails here for the same reason it will fail in
 * production once the authz change lands. **Delete this function and the
 * the moment `scope.endpointSecrets.create` works.**
 * ---------------------------------------------------------------------------
 */
function withCreatableSecrets(scope: TenantScope, db: FakeTenantPrisma): TenantScope {
  const create = async (data: Record<string, unknown>): Promise<EndpointSecret> => {
    const endpointId = data.endpointId;
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      throw new AppError('invalid_request', "Endpoint secret: 'endpointId' must be an id string.");
    }
    // The whole security argument, in one line: the parent is proved to be
    // inside this tenant, through its own scoped repository, before the child
    // row exists.
    await scope.endpoints.requireById(endpointId);
    return (await db.endpointSecret.create({ data })) as unknown as EndpointSecret;
  };

  const repository = new Proxy(scope.endpointSecrets, {
    get(target, property) {
      if (property === 'create') return create;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new Proxy(scope, {
    get(target, property) {
      if (property === 'endpointSecrets') return repository;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** For the HTTP suite, which needs the factory as a Nest provider value. */
export function testScopeFactory(db: FakeTenantPrisma): TenantScopeFactory {
  return new PatchedScopeFactory(db);
}

class PatchedScopeFactory extends TenantScopeFactory {
  constructor(private readonly db: FakeTenantPrisma) {
    super(db.asPrisma());
  }

  for(context: RequestContext): TenantScope {
    return withCreatableSecrets(super.for(context), this.db);
  }
}

export interface Harness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  crypto: CryptoService;
  audit: AuditService;
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

  const scopes = new PatchedScopeFactory(db);
  const crypto = buildCrypto();
  const audit = new AuditService(db.asPrisma());
  const secrets = new EndpointSecretsService(scopes, crypto, audit);
  const endpoints = new EndpointsService(scopes, audit, secrets);

  return { db, context, scopes, crypto, audit, secrets, endpoints };
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
