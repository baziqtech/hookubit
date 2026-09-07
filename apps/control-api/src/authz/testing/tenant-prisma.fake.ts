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
  endpointHealth: { endpoint: { table: 'endpoint', fk: 'endpointId' } },
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
        // Prisma's NOT over a list is NOT(a AND b), not NOT(a) AND NOT(b). The
        // difference matters here: the wrong reading makes a NOT filter STRICTER
        // than production, so an isolation test could pass against the fake and
        // leak against PostgreSQL.
        const clauses = Array.isArray(value) ? value : [value];
        if (clauses.every((clause) => this.matches(table, row, clause as Row))) return false;
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
        const operator = value as {
          in?: unknown[];
          not?: unknown;
          gt?: unknown;
          gte?: unknown;
          lt?: unknown;
          lte?: unknown;
        };
        if (Array.isArray(operator.in)) {
          if (!operator.in.includes(row[key])) return false;
          continue;
        }
        if ('not' in operator) {
          if (row[key] === operator.not) return false;
          continue;
        }
        // Ordering comparisons, string-compared the way PostgreSQL compares the
        // text primary keys these tables use. `forEachPage` walks a keyset
        // (`WHERE id > <last seen>`), so without these the exhaustive paging
        // tests would be testing nothing.
        const comparisons = ['gt', 'gte', 'lt', 'lte'] as const;
        if (comparisons.some((name) => name in operator)) {
          const actual = row[key];
          if (actual === null || actual === undefined) return false;
          const left = String(actual);
          for (const name of comparisons) {
            if (!(name in operator)) continue;
            const right = String(operator[name]);
            const sign = left < right ? -1 : left > right ? 1 : 0;
            if (name === 'gt' && sign <= 0) return false;
            if (name === 'gte' && sign < 0) return false;
            if (name === 'lt' && sign >= 0) return false;
            if (name === 'lte' && sign > 0) return false;
          }
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

  /** `_count` (true or per-field) and `_sum`; enough for the dashboard queries. */
  private static summarise(rows: Row[], args: { _count?: unknown; _sum?: unknown }): Row {
    const out: Row = {};
    if (args._count === true) {
      out._count = rows.length;
    } else if (args._count && typeof args._count === 'object') {
      const counts: Row = {};
      for (const field of Object.keys(args._count as Row)) {
        counts[field] = rows.filter((row) => row[field] !== null && row[field] !== undefined).length;
      }
      out._count = counts;
    }
    if (args._sum && typeof args._sum === 'object') {
      const sums: Row = {};
      for (const field of Object.keys(args._sum as Row)) {
        sums[field] = rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
      }
      out._sum = sums;
    }
    return out;
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
      aggregate: async (args: {
        where?: Row;
        _count?: unknown;
        _sum?: unknown;
      }): Promise<Row> => {
        this.queries.push({ table, op: 'aggregate', where: args.where });
        const rows = this.find(table, { where: args.where });
        return FakeTenantPrisma.summarise(rows, args);
      },
      groupBy: async (args: {
        by: readonly string[];
        where?: Row;
        _count?: unknown;
        _sum?: unknown;
      }): Promise<Row[]> => {
        this.queries.push({ table, op: 'groupBy', where: args.where });
        const rows = this.find(table, { where: args.where });
        const groups = new Map<string, Row[]>();
        for (const row of rows) {
          const key = JSON.stringify(args.by.map((field) => row[field] ?? null));
          const bucket = groups.get(key);
          if (bucket) bucket.push(row);
          else groups.set(key, [row]);
        }
        return [...groups.values()].map((bucket) => {
          const head: Row = {};
          for (const field of args.by) head[field] = bucket[0][field] ?? null;
          return { ...head, ...FakeTenantPrisma.summarise(bucket, args) };
        });
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
  readonly endpointHealth = this.delegate('endpointHealth');
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
