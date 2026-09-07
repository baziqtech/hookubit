import { FakeTenantPrisma, Row } from '../../authz/testing/tenant-prisma.fake';

/**
 * Richer delegates for `events`, `deliveries` and `delivery_attempts`, over the
 * SAME storage the shared fake uses.
 *
 * `FakeTenantPrisma` was built for `src/authz`, where every predicate is a
 * tenant predicate over text primary keys, so it compares with `String(a) <
 * String(b)` and knows nothing about `contains`. That is correct for what it
 * was built for and wrong for this module, in three ways that would each make a
 * test pass vacuously or fail spuriously:
 *
 *  1. **Dates.** `String(new Date(...))` is `'Mon Jan 01 2026 ...'`. Comparing
 *     those lexicographically puts April before January, so a date-range test
 *     would assert nothing. Every filter in `ListEventsQueryDto` and
 *     `ListDeliveriesQueryDto` is a date range or is paired with one.
 *  2. **Numbers.** `String(10) < String(9)`, so an attempt history ordered by
 *     `attempt_number` would come back 1, 10, 11, 2 - and "attempts are
 *     complete and ordered" is one of the properties this suite exists to
 *     prove.
 *  3. **`contains` and the `deliveries -> events` relation.** The free-text
 *     idempotency-key search and the `event_type` filter on deliveries are not
 *     expressible against the shared fake at all; it throws.
 *
 * Rather than weaken the production queries to fit the fake, the fake's
 * comparison is fixed here for the three tables this module reads. Storage is
 * shared (`db.rows(...)`), so `TenantResolver` and `AuditService` keep using
 * their own delegates against the same rows and nothing diverges.
 *
 * It also does two things the real database does and the shared fake does not:
 *
 *  - enforces `deliveries_event_endpoint_original_key`, the PARTIAL unique
 *    index on `(event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL`.
 *    Without it the concurrency suite's pre-fix demonstration - an insert that
 *    forgets `replay_of_delivery_id` - would pass, and the property check would
 *    be proving nothing.
 *  - records every operation in `db.queries`, so a test can assert that a
 *    replay issued no UPDATE and no DELETE against `deliveries` or
 *    `delivery_attempts`. That is the append-only invariant, checked at the
 *    statement level rather than only by comparing rows afterwards.
 *
 * Test files only.
 */

type RichTable = 'event' | 'delivery' | 'deliveryAttempt';

interface Relation {
  table: string;
  fk: string;
}

/**
 * To-one relations, for both the rich tables and everything they reach. A
 * superset of the shared fake's map: `delivery.event` is missing there, which
 * is exactly the join `?event_type=` needs.
 */
const RELATIONS: Record<string, Record<string, Relation>> = {
  organization: {},
  project: { organization: { table: 'organization', fk: 'organizationId' } },
  endpoint: { project: { table: 'project', fk: 'projectId' } },
  webhookSubscription: {
    project: { table: 'project', fk: 'projectId' },
    endpoint: { table: 'endpoint', fk: 'endpointId' },
  },
  event: {
    project: { table: 'project', fk: 'projectId' },
    organization: { table: 'organization', fk: 'organizationId' },
  },
  delivery: {
    event: { table: 'event', fk: 'eventId' },
    endpoint: { table: 'endpoint', fk: 'endpointId' },
    project: { table: 'project', fk: 'projectId' },
    organization: { table: 'organization', fk: 'organizationId' },
  },
  deliveryAttempt: { delivery: { table: 'delivery', fk: 'deliveryId' } },
};

/** SQL NULL and "column absent from this fixture row" are the same value. */
function value(row: Row, key: string): unknown {
  const found = row[key];
  return found === undefined ? null : found;
}

/**
 * Three-way compare that knows what it is looking at.
 *
 * Dates by instant, numbers by magnitude, everything else lexicographically -
 * which is what PostgreSQL does for `text`, and what the shared fake does for
 * everything.
 */
function compare(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;

  if (left instanceof Date || right instanceof Date) {
    const a = new Date(left as string | Date).getTime();
    const b = new Date(right as string | Date).getTime();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesOperators(actual: unknown, operators: Record<string, unknown>): boolean {
  const insensitive = operators.mode === 'insensitive';
  const text = (input: unknown): string =>
    insensitive ? String(input).toLowerCase() : String(input);

  for (const [name, operand] of Object.entries(operators)) {
    if (name === 'mode') continue;
    switch (name) {
      case 'equals':
        if (compare(actual, operand) !== 0) return false;
        break;
      case 'not':
        // `{ not: null }` is "IS NOT NULL"; `{ not: x }` is "<> x". A nested
        // operator object is handled by recursing and negating.
        if (operand !== null && typeof operand === 'object' && !(operand instanceof Date)) {
          if (matchesOperators(actual, operand as Record<string, unknown>)) return false;
          break;
        }
        if (compare(actual, operand) === 0) return false;
        break;
      case 'in':
        if (!(operand as unknown[]).some((candidate) => compare(actual, candidate) === 0)) {
          return false;
        }
        break;
      case 'notIn':
        if ((operand as unknown[]).some((candidate) => compare(actual, candidate) === 0)) {
          return false;
        }
        break;
      case 'gt':
        if (compare(actual, operand) <= 0) return false;
        break;
      case 'gte':
        if (compare(actual, operand) < 0) return false;
        break;
      case 'lt':
        if (compare(actual, operand) >= 0) return false;
        break;
      case 'lte':
        if (compare(actual, operand) > 0) return false;
        break;
      case 'contains':
        if (actual === null) return false;
        if (!text(actual).includes(text(operand))) return false;
        break;
      case 'startsWith':
        if (actual === null || !text(actual).startsWith(text(operand))) return false;
        break;
      case 'endsWith':
        if (actual === null || !text(actual).endsWith(text(operand))) return false;
        break;
      default:
        throw new Error(`rich-fake: unsupported operator '${name}'`);
    }
  }
  return true;
}

export class RichQuery {
  constructor(private readonly db: FakeTenantPrisma) {}

  matches(table: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, operand] of Object.entries(where)) {
      if (operand === undefined) continue;

      if (key === 'AND') {
        const clauses = Array.isArray(operand) ? operand : [operand];
        if (!clauses.every((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }
      if (key === 'OR') {
        const clauses = Array.isArray(operand) ? operand : [operand];
        if (!clauses.some((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }
      if (key === 'NOT') {
        // Prisma reads NOT over a list as NOT(a AND b) - the same reading the
        // shared fake takes, and for the same reason: the other reading is
        // STRICTER than production, so an isolation test could pass here and
        // leak against PostgreSQL.
        const clauses = Array.isArray(operand) ? operand : [operand];
        if (clauses.every((clause) => this.matches(table, row, clause as Row))) return false;
        continue;
      }

      const relation = RELATIONS[table]?.[key];
      if (relation) {
        const relatedId = row[relation.fk];
        if (typeof relatedId !== 'string') return false;
        const related = this.rows(relation.table).get(relatedId);
        if (!related) return false;
        if (!this.matches(relation.table, related, operand as Row)) return false;
        continue;
      }

      const actual = value(row, key);
      if (operand !== null && typeof operand === 'object' && !(operand instanceof Date)) {
        if (!matchesOperators(actual, operand as Record<string, unknown>)) return false;
        continue;
      }
      if (compare(actual, operand) !== 0) return false;
    }
    return true;
  }

  private rows(table: string): Map<string, Row> {
    return this.db.rows(table as Parameters<FakeTenantPrisma['rows']>[0]);
  }

  find(
    table: string,
    args: { where?: Row; orderBy?: Row | Row[]; take?: number; skip?: number },
  ): Row[] {
    let found = [...this.rows(table).values()].filter((row) =>
      this.matches(table, row, args.where),
    );

    const orders = args.orderBy
      ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).flatMap((clause) =>
          Object.entries(clause),
        )
      : [];
    if (orders.length > 0) {
      found = [...found].sort((left, right) => {
        for (const [field, direction] of orders) {
          const sign = compare(value(left, field), value(right, field));
          if (sign !== 0) return direction === 'desc' ? -sign : sign;
        }
        return 0;
      });
    }

    if (args.skip) found = found.slice(args.skip);
    if (args.take !== undefined) found = found.slice(0, args.take);
    return found.map((row) => ({ ...row }));
  }
}

/**
 * The unique index Prisma cannot express and the shared fake does not have.
 *
 * `CREATE UNIQUE INDEX deliveries_event_endpoint_original_key ON deliveries
 * (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL` - so originals
 * are deduped and replays are exempt. Modelled here because the pre-fix shape
 * this suite has to demonstrate (a replay inserted WITHOUT
 * `replay_of_delivery_id`) is caught by nothing else.
 */
export class OriginalDeliveryConflict extends Error {
  readonly code = 'P2002';
  readonly meta = { target: 'deliveries_event_endpoint_original_key' };

  constructor(eventId: string, endpointId: string) {
    super(
      `Unique constraint failed on the fields: (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL - an ORIGINAL delivery already exists for event ${eventId} and endpoint ${endpointId}.`,
    );
  }
}

/**
 * Replace the `event`, `delivery` and `deliveryAttempt` delegates on a fake with
 * ones that filter, order and constrain the way PostgreSQL does for this
 * module's queries. Returns the same instance.
 */
export function installRichTables(db: FakeTenantPrisma): FakeTenantPrisma {
  const query = new RichQuery(db);
  const mutable = db as unknown as Record<string, unknown>;

  for (const table of ['event', 'delivery', 'deliveryAttempt'] as RichTable[]) {
    const rows = db.rows(table);

    mutable[table] = {
      findFirst: async (args: { where?: Row; orderBy?: Row } = {}): Promise<Row | null> => {
        db.queries.push({ table, op: 'find', where: args.where });
        return query.find(table, args)[0] ?? null;
      },
      findUnique: async (args: { where?: Row } = {}): Promise<Row | null> => {
        db.queries.push({ table, op: 'find', where: args.where });
        return query.find(table, args)[0] ?? null;
      },
      findMany: async (
        args: { where?: Row; orderBy?: Row; take?: number; skip?: number } = {},
      ): Promise<Row[]> => {
        db.queries.push({ table, op: 'find', where: args.where });
        return query.find(table, args);
      },
      count: async (args: { where?: Row } = {}): Promise<number> => {
        db.queries.push({ table, op: 'count', where: args.where });
        return query.find(table, args).length;
      },
      create: async (args: { data: Row }): Promise<Row> => {
        db.queries.push({ table, op: 'create' });
        const data = args.data;
        if (data.id === undefined) throw new Error(`${table}.create requires an id`);
        if (table === 'delivery' && (data.replayOfDeliveryId ?? null) === null) {
          const clash = [...rows.values()].find(
            (row) =>
              row.eventId === data.eventId &&
              row.endpointId === data.endpointId &&
              (row.replayOfDeliveryId ?? null) === null,
          );
          if (clash) {
            throw new OriginalDeliveryConflict(String(data.eventId), String(data.endpointId));
          }
        }
        const stored: Row = { ...data, id: String(data.id) };
        rows.set(String(data.id), stored);
        return { ...stored };
      },
      updateMany: async (args: { where?: Row; data: Row }): Promise<{ count: number }> => {
        db.queries.push({ table, op: 'updateMany', where: args.where });
        const targets = query.find(table, { where: args.where });
        for (const target of targets) {
          const current = rows.get(String(target.id));
          if (current) rows.set(String(target.id), { ...current, ...args.data });
        }
        return { count: targets.length };
      },
      deleteMany: async (args: { where?: Row } = {}): Promise<{ count: number }> => {
        db.queries.push({ table, op: 'deleteMany', where: args.where });
        const targets = query.find(table, { where: args.where });
        for (const target of targets) rows.delete(String(target.id));
        return { count: targets.length };
      },
      aggregate: async (args: { where?: Row; _count?: unknown }): Promise<Row> => {
        db.queries.push({ table, op: 'aggregate', where: args.where });
        return { _count: query.find(table, { where: args.where }).length };
      },
      groupBy: async (args: { by: readonly string[]; where?: Row }): Promise<Row[]> => {
        db.queries.push({ table, op: 'groupBy', where: args.where });
        const buckets = new Map<string, Row[]>();
        for (const row of query.find(table, { where: args.where })) {
          const key = JSON.stringify(args.by.map((field) => value(row, field)));
          const bucket = buckets.get(key);
          if (bucket) bucket.push(row);
          else buckets.set(key, [row]);
        }
        return [...buckets.values()].map((bucket) => {
          const head: Row = {};
          for (const field of args.by) head[field] = value(bucket[0], field);
          return { ...head, _count: bucket.length };
        });
      },
    };
  }

  return db;
}

/**
 * Every statement that could have rewritten history.
 *
 * `delivery_attempts` is append-only and an original delivery is immutable, so
 * for anything this module does the answer must be an empty array. Asserted at
 * the statement level as well as by comparing rows: a row comparison can be
 * satisfied by an UPDATE that happened to write the same values back, and
 * "nothing was rewritten" should not depend on the values being lucky.
 */
export function historyWrites(db: FakeTenantPrisma): Array<{ table: string; op: string }> {
  return db.queries.filter(
    (entry) =>
      (entry.table === 'delivery' || entry.table === 'deliveryAttempt') &&
      (entry.op === 'updateMany' || entry.op === 'deleteMany'),
  );
}
