import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * In-memory stand-in for the tenant-owned tables, in the spirit of
 * `src/auth/testing/prisma.fake.ts` but with the one behaviour the
 * authorization layer actually depends on: a WHERE evaluator that understands
 * `AND`/`OR`/`NOT` and one-hop relation filters.
 *
 * That matters because the security argument for `ScopedRepository` is "the
 * tenant predicate is in the WHERE clause, so a cross-tenant id matches zero
 * rows". A fake that ignored `where` would let every isolation test pass
 * vacuously. This one really filters, so `requireById` on another tenant's
 * endpoint really returns nothing.
 *
 * No database is reachable in this environment (Docker daemon down), so this is
 * what the suite runs against. It is not a Prisma emulator: it implements the
 * operations `TenantResolver`, `ScopedRepository` and `AuditService` issue, and
 * nothing else. Test files only.
 */

export type Row = Record<string, unknown>;

interface Relation {
  table: string;
  /** Column on THIS table holding the related row's id. */
  fk: string;
}

/** Only to-one relations, which is all the tenant predicates traverse. */
const SCHEMA: Record<string, Record<string, Relation>> = {
  organization: {},
  user: {},
  organizationMember: {
    organization: { table: 'organization', fk: 'organizationId' },
    user: { table: 'user', fk: 'userId' },
  },
  project: { organization: { table: 'organization', fk: 'organizationId' } },
  endpoint: { project: { table: 'project', fk: 'projectId' } },
  endpointSecret: { endpoint: { table: 'endpoint', fk: 'endpointId' } },
  webhookSubscription: {
    project: { table: 'project', fk: 'projectId' },
    endpoint: { table: 'endpoint', fk: 'endpointId' },
  },
  apiKey: { project: { table: 'project', fk: 'projectId' } },
  retryPolicy: { project: { table: 'project', fk: 'projectId' } },
  rateLimitPolicy: { project: { table: 'project', fk: 'projectId' } },
  idempotencyKey: { project: { table: 'project', fk: 'projectId' } },
  event: {
    project: { table: 'project', fk: 'projectId' },
    organization: { table: 'organization', fk: 'organizationId' },
  },
  delivery: {
    endpoint: { table: 'endpoint', fk: 'endpointId' },
    project: { table: 'project', fk: 'projectId' },
    organization: { table: 'organization', fk: 'organizationId' },
  },
  deliveryAttempt: { delivery: { table: 'delivery', fk: 'deliveryId' } },
  auditLog: { organization: { table: 'organization', fk: 'organizationId' } },
  usageRecord: { organization: { table: 'organization', fk: 'organizationId' } },
  billingSubscription: { organization: { table: 'organization', fk: 'organizationId' } },
};

type TableName = keyof typeof SCHEMA;

interface FindArgs {
  where?: Row;
  select?: Row;
  orderBy?: Row;
  take?: number;
  skip?: number;
}

export class FakeTenantPrisma {
  /** table -> id -> row. Public so tests can seed and assert directly. */
  readonly tables = new Map<string, Map<string, Row>>();
  /** Every `where` this fake was asked to evaluate, per table. */
  readonly queries: Array<{ table: string; op: string; where?: Row }> = [];

  constructor() {
    for (const table of Object.keys(SCHEMA)) this.tables.set(table, new Map());
  }

  rows(table: TableName): Map<string, Row> {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`Unknown table ${table}`);
    return rows;
  }

  insert(table: TableName, row: Row): Row {
    const id = String(row.id ?? `${table}_${this.rows(table).size + 1}`);
    const stored: Row = { ...row, id };
    this.rows(table).set(id, stored);
    return stored;
  }

  all(table: TableName): Row[] {
    return [...this.rows(table).values()];
  }

  // -------------------------------------------------------------------------
  // WHERE evaluation
  // -------------------------------------------------------------------------

  private matches(table: TableName, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;

      if (key === 'AND') {
        const clauses = Array.isArray(value) ? value : [value];
        if (!clauses.every((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }
      if (key === 'OR') {
        const clauses = Array.isArray(value) ? value : [value];
        if (!clauses.some((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }
      if (key === 'NOT') {
        const clauses = Array.isArray(value) ? value : [value];
        if (clauses.some((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }

      const relation = SCHEMA[table][key];
      if (relation) {
        const relatedId = row[relation.fk];
        if (typeof relatedId !== 'string') return false;
        const related = this.rows(relation.table as TableName).get(relatedId);
        if (!related) return false;
        if (!this.matches(relation.table as TableName, related, value as Row)) return false;
        continue;
      }

      if (value !== null && typeof value === 'object') {
        const operator = value as { in?: unknown[]; not?: unknown };
        if (Array.isArray(operator.in)) {
          if (!operator.in.includes(row[key])) return false;
          continue;
        }
        if ('not' in operator) {
          if (row[key] === operator.not) return false;
          continue;
        }
        throw new Error(`FakeTenantPrisma: unsupported filter on ${table}.${key}`);
      }

      if (row[key] !== value) return false;
    }
    return true;
  }

  /** Projects a row through Prisma's `select`, recursing into relations. */
  private projectRow(table: TableName, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === false || value === undefined) continue;
      const relation = SCHEMA[table][key];
      if (relation) {
        const relatedId = row[relation.fk];
        const related =
          typeof relatedId === 'string'
            ? this.rows(relation.table as TableName).get(relatedId)
            : undefined;
        out[key] = related
          ? this.projectRow(
              relation.table as TableName,
              related,
              (value as { select?: Row }).select,
            )
          : null;
        continue;
      }
      out[key] = row[key] ?? null;
    }
    return out;
  }

  /** Expands Prisma's compound-unique shape, e.g. `organizationId_userId`. */
  private static flattenUnique(where: Row | undefined): Row | undefined {
    if (!where) return where;
    const flat: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (key.includes('_') && value !== null && typeof value === 'object') {
        Object.assign(flat, value as Row);
      } else {
        flat[key] = value;
      }
    }
    return flat;
  }

  private find(table: TableName, args: FindArgs): Row[] {
    const where = FakeTenantPrisma.flattenUnique(args.where);
    this.queries.push({ table, op: 'find', where: args.where });
    let found = this.all(table).filter((row) => this.matches(table, row, where));
    if (args.orderBy) {
      const [[field, direction]] = Object.entries(args.orderBy);
      found = [...found].sort((a, b) => {
        const left = String(a[field] ?? '');
        const right = String(b[field] ?? '');
        return direction === 'desc' ? right.localeCompare(left) : left.localeCompare(right);
      });
    }
    if (args.skip) found = found.slice(args.skip);
    if (args.take !== undefined) found = found.slice(0, args.take);
    return found.map((row) => this.projectRow(table, row, args.select));
  }

  // -------------------------------------------------------------------------
  // Delegates
  // -------------------------------------------------------------------------

  private delegate(table: TableName) {
    return {
      findUnique: async (args: FindArgs): Promise<Row | null> =>
        this.find(table, args)[0] ?? null,
      findFirst: async (args: FindArgs): Promise<Row | null> => this.find(table, args)[0] ?? null,
      findMany: async (args: FindArgs = {}): Promise<Row[]> => this.find(table, args),
      count: async (args: FindArgs = {}): Promise<number> => this.find(table, args).length,
      create: async (args: { data: Row }): Promise<Row> => {
        this.queries.push({ table, op: 'create' });
        if (args.data.id === undefined) throw new Error(`${table}.create requires an id`);
        return { ...this.insert(table, args.data) };
      },
      updateMany: async (args: { where?: Row; data: Row }): Promise<{ count: number }> => {
        const targets = this.find(table, { where: args.where });
        this.queries.push({ table, op: 'updateMany', where: args.where });
        for (const target of targets) {
          const id = String(target.id);
          const current = this.rows(table).get(id);
          if (current) this.rows(table).set(id, { ...current, ...args.data });
        }
        return { count: targets.length };
      },
      deleteMany: async (args: { where?: Row } = {}): Promise<{ count: number }> => {
        const targets = this.find(table, { where: args.where });
        this.queries.push({ table, op: 'deleteMany', where: args.where });
        for (const target of targets) this.rows(table).delete(String(target.id));
        return { count: targets.length };
      },
    };
  }

  readonly organization = this.delegate('organization');
  readonly user = this.delegate('user');
  readonly organizationMember = this.delegate('organizationMember');
  readonly project = this.delegate('project');
  readonly endpoint = this.delegate('endpoint');
  readonly endpointSecret = this.delegate('endpointSecret');
  readonly webhookSubscription = this.delegate('webhookSubscription');
  readonly apiKey = this.delegate('apiKey');
  readonly retryPolicy = this.delegate('retryPolicy');
  readonly rateLimitPolicy = this.delegate('rateLimitPolicy');
  readonly idempotencyKey = this.delegate('idempotencyKey');
  readonly event = this.delegate('event');
  readonly delivery = this.delegate('delivery');
  readonly deliveryAttempt = this.delegate('deliveryAttempt');
  readonly auditLog = this.delegate('auditLog');
  readonly usageRecord = this.delegate('usageRecord');
  readonly billingSubscription = this.delegate('billingSubscription');

  async $transaction<T>(fn: (tx: FakeTenantPrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
