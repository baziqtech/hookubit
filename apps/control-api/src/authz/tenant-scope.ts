import { Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { RequestContext } from './tenant-context';

/**
 * How a table is tied back to a tenant.
 *
 * `project` and `projectAndOrganization` fall back to an organization-wide
 * predicate when the route resolved no project, so an organization-level
 * listing (`/v1/organizations/:orgId/endpoints`) is still scoped rather than
 * unscoped. There is no strategy that produces an empty predicate.
 *
 * `delivery` and `viaDelivery` deliberately lead with the ownership CHAIN
 * (`delivery -> endpoint -> project`) and carry the denormalised
 * `organization_id`/`project_id` columns only as an extra AND conjunct. That is
 * the same reading `TenantResolver` takes: those columns are copies, the chain
 * is what owns the row, and a row where the two disagree is a data-integrity
 * bug that must be visible from neither route. Before FIX 3 the repository
 * trusted the columns while the resolver refused to, so `del_corrupt` was
 * refused when addressed by id and served in a listing - two components in one
 * directory disagreeing about who owns a row.
 */
export type TenantScopeKind =
  | 'organization'
  | 'organizationSelf'
  | 'project'
  | 'projectAndOrganization'
  | 'viaEndpoint'
  | 'delivery'
  | 'viaDelivery';

/** A `where` fragment. Deliberately opaque: callers never build one by hand. */
export type TenantPredicate = Readonly<Record<string, unknown>>;

export function tenantPredicate(kind: TenantScopeKind, context: RequestContext): TenantPredicate {
  const organizationId = context.organization.id;
  const projectId = context.project?.id ?? null;

  switch (kind) {
    case 'organization':
      return { organizationId };
    case 'organizationSelf':
      // The organizations table itself: the tenant boundary is the primary key.
      return { id: organizationId };
    case 'project':
      return projectId ? { projectId } : { project: { organizationId } };
    case 'projectAndOrganization':
      // Both columns when we have both. `organizationId` alone is still a
      // complete tenant boundary, so an org-level route is safe.
      return projectId ? { organizationId, projectId } : { organizationId };
    case 'viaEndpoint':
      return projectId
        ? { endpoint: { projectId } }
        : { endpoint: { project: { organizationId } } };
    case 'delivery':
      // Chain first (authoritative), denormalised columns second (selective:
      // they are what `deliveries_project_id_status_created_at_idx` is on).
      return projectId
        ? { endpoint: { projectId }, organizationId, projectId }
        : { endpoint: { project: { organizationId } }, organizationId };
    case 'viaDelivery':
      return { delivery: tenantPredicate('delivery', context) };
  }
}

/**
 * The scalar tenant columns a new row must carry. Null when the strategy
 * reaches the tenant through a relation, because there is no column on this
 * table to set - those rows are created through their parent.
 */
function tenantColumns(
  kind: TenantScopeKind,
  context: RequestContext,
): Readonly<Record<string, string>> | null {
  switch (kind) {
    case 'organization':
      return { organizationId: context.organization.id };
    case 'project':
      return { projectId: context.requireProject().id };
    case 'projectAndOrganization':
    case 'delivery':
      return {
        organizationId: context.organization.id,
        projectId: context.requireProject().id,
      };
    case 'organizationSelf':
    case 'viaEndpoint':
    case 'viaDelivery':
      return null;
  }
}

/**
 * The columns that carry a row's tenancy. A caller may never supply them, on
 * create or on update: the `where` predicate proves you own the row BEFORE the
 * statement, and says nothing about where the row lands after it. Any OTHER
 * tenant-owned foreign key on the table (`endpoint_id`, `event_id`,
 * `retry_policy_id`) stays writable and is proved to be inside the tenant
 * instead - see `foreignKeys`.
 */
const TENANT_COLUMNS: readonly string[] = ['organizationId', 'projectId'];

/**
 * Paging ceiling. `take` is clamped to this and defaults to
 * `DEFAULT_PAGE_SIZE`, because `findMany({ take: 1_000_000 })` on `events` -
 * a table of raw webhook payloads - is a memory and connection-pool exhaustion
 * vector reachable from any list endpoint that forwards a query parameter.
 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The subset of a Prisma model delegate the scoped repository is allowed to
 * use.
 *
 * `findUnique`, `update` and `delete` are absent by design: all three take a
 * bare primary key, which is precisely the unscoped query this class exists to
 * prevent. Everything below routes through `findFirst`/`updateMany`/
 * `deleteMany` with the tenant predicate already in the WHERE clause, so a
 * cross-tenant id matches zero rows in the database rather than being fetched
 * and then checked in application code.
 */
export interface ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord> {
  findMany(args: {
    where?: TWhere;
    orderBy?: TOrderBy;
    take?: number;
    skip?: number;
  }): Promise<TRecord[]>;
  findFirst(args: { where?: TWhere; orderBy?: TOrderBy }): Promise<TRecord | null>;
  count(args: { where?: TWhere }): Promise<number>;
  create(args: { data: TCreate }): Promise<TRecord>;
  updateMany(args: { where?: TWhere; data: TUpdate }): Promise<{ count: number }>;
  deleteMany(args: { where?: TWhere }): Promise<{ count: number }>;
  aggregate(args: AggregateArgs<TWhere>): Promise<Record<string, unknown>>;
  groupBy(args: GroupByArgs<TWhere>): Promise<Array<Record<string, unknown>>>;
}

export interface AggregateArgs<TWhere> {
  where?: TWhere;
  _count?: unknown;
  _sum?: unknown;
  _avg?: unknown;
  _min?: unknown;
  _max?: unknown;
}

export interface GroupByArgs<TWhere> extends AggregateArgs<TWhere> {
  by: readonly string[];
  having?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
  take?: number;
  skip?: number;
}

/** Fields the repository fills in; a caller supplying them is rejected. */
type TenantOwned = 'organizationId' | 'projectId';

/**
 * A caller's create payload: the model's scalars, minus the tenant columns.
 * The factory supplies `*CreateManyInput` as `TCreate`, which is Prisma's
 * scalars-only input, so nested relation writers are not expressible here.
 */
export type ScopedCreateInput<TCreate> = Omit<TCreate, TenantOwned>;

/**
 * A caller's update payload: the model's scalars, minus the tenant columns and
 * the primary key. See `updateById` for why `id` is excluded.
 */
export type ScopedUpdateInput<TUpdate> = Omit<TUpdate, TenantOwned | 'id'>;

/** What the repository needs from a sibling repository to validate an FK. */
export interface OwnedRepository {
  requireById(id: string): Promise<unknown>;
}

/**
 * Resolves a sibling repository by its `TenantScope` accessor name, so a
 * repository can prove a caller-supplied foreign key points inside the same
 * tenant before it is written. Implemented by `TenantScope`.
 */
export interface OwnershipVerifier {
  repositoryFor(name: string): OwnedRepository;
}

/**
 * Runs `run` against a delegate bound to a transaction, so a read-after-write
 * pair is atomic. The factory supplies this; when it is absent the repository
 * degrades to the unwrapped delegate (single-statement calls are unaffected).
 */
export type TransactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord> = <T>(
  run: (delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>) => Promise<T>,
) => Promise<T>;

export interface ScopedRepositoryConfig<TWhere, TOrderBy, TCreate, TUpdate, TRecord> {
  delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;
  kind: TenantScopeKind;
  context: RequestContext;
  /** Used in error messages only: "Endpoint not found." */
  resourceName: string;
  /** Prisma model name, e.g. `Endpoint`. Drives the DMMF write guard. */
  model: string;
  /** Primary key column. `endpoint_health` is keyed by `endpoint_id`. */
  idField?: string;
  /**
   * Tenant-owned foreign keys on this table: column -> the `TenantScope`
   * accessor that owns the referenced table. Every one of these that appears in
   * a create/update payload is proved to be inside the caller's tenant, through
   * that repository, before the write is issued.
   */
  foreignKeys?: Readonly<Record<string, string>>;
  owner?: OwnershipVerifier;
  transaction?: TransactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;
}

interface ModelShape {
  scalars: ReadonlySet<string>;
  relations: ReadonlySet<string>;
}

const SHAPES = new Map<string, ModelShape>();

/**
 * Scalar and relation field names for a model, from the generated DMMF.
 *
 * This is what makes the write guard exhaustive rather than a blocklist: every
 * `*UncheckedCreateInput`/`*UncheckedUpdateInput` also accepts nested relation
 * writers (`connect`, `set`, `disconnect`, `delete`, `deleteMany`, `upsert`),
 * each taking a BARE unique key with no tenant filter - the exact unscoped
 * access this class removes from `where`, re-entering through `data`.
 */
function modelShape(model: string): ModelShape {
  const cached = SHAPES.get(model);
  if (cached) return cached;

  const definition = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === model);
  if (!definition) {
    // Fail closed: without the field list we cannot tell a scalar from a
    // relation, and guessing would be the unsafe direction.
    throw new AppError(
      'internal_error',
      `No Prisma model named '${model}'; the scoped repository cannot validate writes against it.`,
    );
  }
  const shape: ModelShape = {
    scalars: new Set(
      definition.fields.filter((field) => field.kind !== 'object').map((field) => field.name),
    ),
    relations: new Set(
      definition.fields.filter((field) => field.kind === 'object').map((field) => field.name),
    ),
  };
  SHAPES.set(model, shape);
  return shape;
}

/**
 * Tenant-scoped access to one table.
 *
 * The tenant predicate is ANDed into every query and cannot be removed by the
 * caller: a caller-supplied `{ projectId: someoneElse }` becomes
 * `AND [{ projectId: mine }, { projectId: someoneElse }]`, which matches
 * nothing. That is the structural answer to "can a user in org A reach org B's
 * project, endpoint, event or delivery?" - the predicate is not a check that
 * can be forgotten at one call site, it is part of every statement issued.
 *
 * The same argument has to hold for `data`, and before FIX 1/FIX 2 it did not.
 * Three things closed that:
 *
 *  1. The tenant columns are neither expressible (`ScopedCreateInput` /
 *     `ScopedUpdateInput`) nor accepted (they are deleted from the payload at
 *     runtime, because the types are erased and JS callers exist). A row cannot
 *     be moved OUT of the tenant it was proved to be in.
 *  2. Nested relation writers are rejected. `TCreate`/`TUpdate` are Prisma's
 *     scalars-only inputs so `{ secrets: { connect: [...] } }` is a compile
 *     error, and the DMMF guard rejects it at runtime as well.
 *  3. Declared tenant-owned foreign keys are resolved through the sibling
 *     scoped repository before the write, so `{ endpointId: <another tenant's
 *     endpoint> }` is a 404 rather than a cross-tenant binding.
 *
 * Not-found policy: `requireById` raises `not_found`, never `forbidden`, for a
 * row in another tenant. See the CROSS_TENANT docblock in
 * `tenant-resolver.service.ts`.
 */
export class ScopedRepository<
  TWhere,
  TOrderBy,
  TCreate extends object,
  TUpdate extends object,
  TRecord extends object,
> {
  private readonly delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;
  private readonly kind: TenantScopeKind;
  private readonly context: RequestContext;
  private readonly resourceName: string;
  private readonly model: string;
  private readonly idField: string;
  private readonly foreignKeys: Readonly<Record<string, string>>;
  private readonly owner?: OwnershipVerifier;
  private readonly transaction?: TransactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;

  constructor(config: ScopedRepositoryConfig<TWhere, TOrderBy, TCreate, TUpdate, TRecord>) {
    this.delegate = config.delegate;
    this.kind = config.kind;
    this.context = config.context;
    this.resourceName = config.resourceName;
    this.model = config.model;
    this.idField = config.idField ?? 'id';
    this.foreignKeys = config.foreignKeys ?? {};
    this.owner = config.owner;
    this.transaction = config.transaction;
  }

  /**
   * The tenant predicate ANDed with `extra`.
   *
   * Exposed for the rare query that needs a delegate method this class does not
   * wrap. Pass this as the `where`; do not rebuild it. `aggregate` and
   * `groupBy` are wrapped below, so a dashboard does not need this.
   */
  where(extra?: TWhere): TWhere {
    const clauses: unknown[] = [tenantPredicate(this.kind, this.context)];
    if (extra !== undefined && extra !== null) clauses.push(extra);
    // The single cast in this class. Prisma's `*WhereInput` types all accept an
    // `AND` array of themselves, and the tenant predicate is a valid fragment of
    // each; expressing that generically costs more than it proves.
    return { AND: clauses } as TWhere;
  }

  async findMany(args?: {
    where?: TWhere;
    orderBy?: TOrderBy;
    take?: number;
    skip?: number;
  }): Promise<TRecord[]> {
    return this.delegate.findMany({
      where: this.where(args?.where),
      orderBy: args?.orderBy,
      take: ScopedRepository.pageSize(args?.take),
      skip: ScopedRepository.offset(args?.skip),
    });
  }

  async findFirst(args?: { where?: TWhere; orderBy?: TOrderBy }): Promise<TRecord | null> {
    return this.delegate.findFirst({ where: this.where(args?.where), orderBy: args?.orderBy });
  }

  async count(where?: TWhere): Promise<number> {
    return this.delegate.count({ where: this.where(where) });
  }

  /** `aggregate`, fenced by the same predicate `where()` builds. */
  async aggregate(args: AggregateArgs<TWhere>): Promise<Record<string, unknown>> {
    return this.delegate.aggregate({ ...args, where: this.where(args.where) });
  }

  /** `groupBy`, fenced by the same predicate, with the same paging ceiling. */
  async groupBy(args: GroupByArgs<TWhere>): Promise<Array<Record<string, unknown>>> {
    return this.delegate.groupBy({
      ...args,
      where: this.where(args.where),
      take: args.take === undefined ? undefined : ScopedRepository.pageSize(args.take),
      skip: ScopedRepository.offset(args.skip),
    });
  }

  /** Null for "not in this tenant" as well as "does not exist" - same answer. */
  async findById(id: string): Promise<TRecord | null> {
    return this.delegate.findFirst({ where: this.where(this.byId(id)) });
  }

  /** 404 for both. The caller does not get to learn which. */
  async requireById(id: string): Promise<TRecord> {
    const record = await this.findById(id);
    if (!record) throw this.notFound();
    return record;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.count(this.byId(id))) > 0;
  }

  /**
   * Prove a foreign key points at a row inside this tenant, and return it.
   *
   * `field` must be one of this repository's declared `foreignKeys`. Use this
   * when an id arrives from the caller and is used for something other than a
   * column on this table (a lookup, an authorization decision, a job payload);
   * ids that ARE written as columns are checked automatically by
   * `create`/`updateById`/`updateMany`.
   */
  async requireOwned(field: string, id: string): Promise<unknown> {
    const repository = this.foreignKeys[field];
    if (!repository) {
      throw new AppError(
        'internal_error',
        `'${field}' is not a declared tenant-owned foreign key of ${this.resourceName}; add it to the repository's foreignKeys map in tenant-scope.factory.ts.`,
      );
    }
    if (!this.owner) {
      throw new AppError(
        'internal_error',
        `${this.resourceName} has no ownership verifier; build it through TenantScopeFactory.`,
      );
    }
    return this.owner.repositoryFor(repository).requireById(id);
  }

  /** `requireOwned` without the row. Throws `not_found` for a foreign id. */
  async assertOwned(field: string, id: string): Promise<void> {
    await this.requireOwned(field, id);
  }

  /**
   * Insert into THIS tenant. The tenant columns are supplied by the repository
   * and are not part of the caller's input type, so a row cannot be created in
   * another organization or project even by a caller who wanted to.
   *
   * Sibling foreign keys (`endpointId`, `eventId`, `retryPolicyId`, ...) are
   * resolved through their own scoped repository first: stamping the caller's
   * `project_id` onto a row that points at another tenant's endpoint would be a
   * cross-tenant binding created through the "safe" API.
   *
   * `id` is still the caller's job - use `newId('endpoint')` and friends.
   */
  async create(data: ScopedCreateInput<TCreate>): Promise<TRecord> {
    const columns = tenantColumns(this.kind, this.context);
    if (!columns) {
      throw new AppError(
        'internal_error',
        `${this.resourceName} rows are scoped through a parent and cannot be created by a scoped repository; create them alongside their parent inside a transaction.`,
      );
    }
    const payload = this.sanitize(data, 'create');
    await this.assertForeignKeysOwned(payload);
    return this.delegate.create({ data: { ...payload, ...columns } as TCreate });
  }

  /**
   * Update one row in this tenant.
   *
   * `updateMany` + a row count, not `update({ where: { id } })`: the latter
   * would issue a primary-key UPDATE and could only check ownership after the
   * fact. A count of zero means the id is absent or belongs to someone else,
   * which is one outcome (404).
   *
   * The update and the read-back run in one transaction. They did not before,
   * and the gap was worse than a stale read: a `data` that changed the tenant
   * columns committed the move and then missed on the re-read, so the caller
   * was told 404 about a write that had happened. The tenant columns and `id`
   * can no longer be written at all, and the transaction makes the returned row
   * the row this statement produced.
   */
  async updateById(id: string, data: ScopedUpdateInput<TUpdate>): Promise<TRecord> {
    const payload = this.sanitize(data, 'update');
    await this.assertForeignKeysOwned(payload);
    return this.inTransaction(async (delegate) => {
      const where = this.where(this.byId(id));
      const result = await delegate.updateMany({ where, data: payload as TUpdate });
      if (result.count === 0) throw this.notFound();
      const record = await delegate.findFirst({ where });
      if (!record) throw this.notFound();
      return record;
    });
  }

  /**
   * Bulk update, still fenced by the tenant predicate.
   *
   * `where` is required and must select something. `updateMany(undefined, ...)`
   * read as innocuous and rewrote every row in the organization; if that is
   * genuinely what you want, say so in the predicate (`{ status: { not:
   * 'deleted' } }`).
   */
  async updateMany(where: TWhere, data: ScopedUpdateInput<TUpdate>): Promise<number> {
    this.requirePredicate(where, 'updateMany');
    const payload = this.sanitize(data, 'update');
    await this.assertForeignKeysOwned(payload);
    const result = await this.delegate.updateMany({
      where: this.where(where),
      data: payload as TUpdate,
    });
    return result.count;
  }

  /**
   * Hard delete of one row in this tenant.
   *
   * Most resources here are soft-deleted (`status = 'deleted'`) because the
   * delivery ledger must survive them - see HANDOFF, "Delivery ledger is no
   * longer cascade-deletable". Use `updateById(id, { status: 'deleted' })`
   * unless you are certain the row has no delivery history.
   */
  async deleteById(id: string): Promise<void> {
    const result = await this.delegate.deleteMany({ where: this.where(this.byId(id)) });
    if (result.count === 0) throw this.notFound();
  }

  /** Bulk delete. `where` is required - see `updateMany`. */
  async deleteMany(where: TWhere): Promise<number> {
    this.requirePredicate(where, 'deleteMany');
    const result = await this.delegate.deleteMany({ where: this.where(where) });
    return result.count;
  }

  // -------------------------------------------------------------------------
  // Write guards
  // -------------------------------------------------------------------------

  /**
   * Everything a `data` payload has to survive before it reaches the database.
   *
   * Types are erased at runtime and this layer is called from JavaScript
   * (compiled controllers, tests, the CLI), so each rule below is enforced
   * here as well as in the type.
   */
  private sanitize(data: object, operation: 'create' | 'update'): Record<string, unknown> {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new AppError('invalid_request', `${this.resourceName}: 'data' must be an object.`);
    }
    const shape = modelShape(this.model);
    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value === undefined) continue;

      if (shape.relations.has(key)) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${key}' is a relation and cannot be written through a scoped repository. Nested writes (connect/set/disconnect/delete/upsert) take a bare unique key with no tenant filter, which is exactly the unscoped access this layer removes. Resolve the related row through its own scoped repository and pass the scalar id.`,
        );
      }
      if (!shape.scalars.has(key)) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${key}' is not a column on this table.`,
        );
      }
      // The tenant columns are the repository's, on create and on update. The
      // `where` predicate proves you own the row BEFORE the statement; it says
      // nothing about where the row lands after it.
      if (TENANT_COLUMNS.includes(key)) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${key}' is set by the tenant scope and cannot be supplied. A row cannot be moved between tenants.`,
        );
      }
      if (operation === 'update' && key === this.idField) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${key}' is the primary key and cannot be updated.`,
        );
      }
      clean[key] = value;
    }
    return clean;
  }

  /** Every declared FK present in the payload must resolve inside the tenant. */
  private async assertForeignKeysOwned(payload: Record<string, unknown>): Promise<void> {
    for (const column of Object.keys(this.foreignKeys)) {
      if (!(column in payload)) continue;
      const raw = payload[column];
      if (raw === null) continue;

      // Prisma accepts `{ set: value }` as a scalar update wrapper; unwrap it so
      // `{ endpointId: { set: <other tenant> } }` cannot walk past this check.
      const value =
        raw !== null && typeof raw === 'object' && 'set' in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>).set
          : raw;

      if (typeof value !== 'string' || value.length === 0) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${column}' must be an id string.`,
        );
      }
      // Throws this sibling's own `not_found` for an id in another tenant, so
      // the caller learns nothing about whether it exists elsewhere.
      await this.requireOwned(column, value);
    }
  }

  private requirePredicate(where: TWhere | undefined, method: string): void {
    const empty =
      where === undefined ||
      where === null ||
      (typeof where === 'object' && Object.keys(where as object).length === 0);
    if (empty) {
      throw new AppError(
        'internal_error',
        `${this.resourceName}.${method} requires an explicit where clause; an unfiltered bulk write would affect every row in the tenant.`,
      );
    }
  }

  private byId(id: string): TWhere {
    return { [this.idField]: id } as TWhere;
  }

  private async inTransaction<T>(
    run: (delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>) => Promise<T>,
  ): Promise<T> {
    if (this.transaction) return this.transaction(run);
    return run(this.delegate);
  }

  private static pageSize(take?: number): number {
    if (take === undefined || !Number.isFinite(take)) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.max(1, Math.floor(take)), MAX_PAGE_SIZE);
  }

  private static offset(skip?: number): number | undefined {
    if (skip === undefined || !Number.isFinite(skip)) return undefined;
    return Math.max(0, Math.floor(skip));
  }

  private notFound(): AppError {
    return new AppError('not_found', `${this.resourceName} not found.`);
  }
}
