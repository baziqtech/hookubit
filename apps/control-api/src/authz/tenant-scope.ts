import { AppError } from '../common/errors';
import { RequestContext } from './tenant-context';

/**
 * How a table is tied back to a tenant.
 *
 * `project` and `projectAndOrganization` fall back to an organization-wide
 * predicate when the route resolved no project, so an organization-level
 * listing (`/v1/organizations/:orgId/endpoints`) is still scoped rather than
 * unscoped. There is no strategy that produces an empty predicate.
 */
export type TenantScopeKind =
  | 'organization'
  | 'project'
  | 'projectAndOrganization'
  | 'viaEndpoint'
  | 'viaDelivery';

/** A `where` fragment. Deliberately opaque: callers never build one by hand. */
export type TenantPredicate = Readonly<Record<string, unknown>>;

export function tenantPredicate(kind: TenantScopeKind, context: RequestContext): TenantPredicate {
  const organizationId = context.organization.id;
  const projectId = context.project?.id ?? null;

  switch (kind) {
    case 'organization':
      return { organizationId };
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
    case 'viaDelivery':
      return projectId
        ? { delivery: { organizationId, projectId } }
        : { delivery: { organizationId } };
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
      return {
        organizationId: context.organization.id,
        projectId: context.requireProject().id,
      };
    case 'viaEndpoint':
    case 'viaDelivery':
      return null;
  }
}

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
}

/** Fields the repository fills in; a caller supplying them would be ignored. */
type TenantOwned = 'organizationId' | 'projectId';

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
 * Not-found policy: `requireById` raises `not_found`, never `forbidden`, for a
 * row in another tenant. See the CROSS_TENANT docblock in
 * `tenant-resolver.service.ts`.
 */
export class ScopedRepository<
  TWhere,
  TOrderBy,
  TCreate extends object,
  TUpdate,
  TRecord extends { id: string },
> {
  constructor(
    private readonly delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>,
    private readonly kind: TenantScopeKind,
    private readonly context: RequestContext,
    /** Used in error messages only: "Endpoint not found." */
    private readonly resourceName: string,
  ) {}

  /**
   * The tenant predicate ANDed with `extra`.
   *
   * Exposed for the rare query that needs a delegate method this class does not
   * wrap (an aggregate, a groupBy). Pass this as the `where`; do not rebuild it.
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
      take: args?.take,
      skip: args?.skip,
    });
  }

  async findFirst(args?: { where?: TWhere; orderBy?: TOrderBy }): Promise<TRecord | null> {
    return this.delegate.findFirst({ where: this.where(args?.where), orderBy: args?.orderBy });
  }

  async count(where?: TWhere): Promise<number> {
    return this.delegate.count({ where: this.where(where) });
  }

  /** Null for "not in this tenant" as well as "does not exist" - same answer. */
  async findById(id: string): Promise<TRecord | null> {
    return this.delegate.findFirst({ where: this.where({ id } as TWhere) });
  }

  /** 404 for both. The caller does not get to learn which. */
  async requireById(id: string): Promise<TRecord> {
    const record = await this.findById(id);
    if (!record) throw this.notFound();
    return record;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.count({ id } as TWhere)) > 0;
  }

  /**
   * Insert into THIS tenant. The tenant columns are supplied by the repository
   * and are not part of the caller's input type, so a row cannot be created in
   * another organization or project even by a caller who wanted to.
   *
   * `id` is still the caller's job - use `newId('endpoint')` and friends.
   */
  async create(data: Omit<TCreate, TenantOwned>): Promise<TRecord> {
    const columns = tenantColumns(this.kind, this.context);
    if (!columns) {
      throw new AppError(
        'internal_error',
        `${this.resourceName} rows are scoped through a parent and cannot be created by a scoped repository; create them alongside their parent inside a transaction.`,
      );
    }
    return this.delegate.create({ data: { ...data, ...columns } as TCreate });
  }

  /**
   * Update one row in this tenant.
   *
   * `updateMany` + a row count, not `update({ where: { id } })`: the latter
   * would issue a primary-key UPDATE and could only check ownership after the
   * fact. A count of zero means the id is absent or belongs to someone else,
   * which is one outcome (404). The row is re-read so callers get the state
   * that was actually persisted.
   */
  async updateById(id: string, data: TUpdate): Promise<TRecord> {
    const result = await this.delegate.updateMany({ where: this.where({ id } as TWhere), data });
    if (result.count === 0) throw this.notFound();
    return this.requireById(id);
  }

  /** Bulk update, still fenced by the tenant predicate. */
  async updateMany(where: TWhere | undefined, data: TUpdate): Promise<number> {
    const result = await this.delegate.updateMany({ where: this.where(where), data });
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
    const result = await this.delegate.deleteMany({ where: this.where({ id } as TWhere) });
    if (result.count === 0) throw this.notFound();
  }

  async deleteMany(where?: TWhere): Promise<number> {
    const result = await this.delegate.deleteMany({ where: this.where(where) });
    return result.count;
  }

  private notFound(): AppError {
    return new AppError('not_found', `${this.resourceName} not found.`);
  }
}
