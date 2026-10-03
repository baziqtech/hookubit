import { FakeTenantPrisma, Row } from '../../authz/testing/tenant-prisma.fake';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * `FakeTenantPrisma`, with the two `groupBy` behaviours this module depends on.
 *
 * The shared fake groups and counts correctly but IGNORES `orderBy` and `take`
 * on `groupBy` - nothing before this module passed either. `AnalyticsService`
 * ranks endpoints and event types by `ORDER BY count DESC LIMIT n` **in
 * PostgreSQL**, which is the whole reason the ranking is bounded. Against a
 * fake that ignores both, "the worst endpoint is first" would pass because the
 * fixture happened to be inserted worst-first, and the day someone moved the
 * ranking into application code the test would still pass.
 *
 * So this narrows the gap rather than papering over it: it applies exactly the
 * two argument shapes `AnalyticsService` sends - `orderBy: { _count: { field:
 * 'desc' | 'asc' } }` and `take`/`skip` - and throws on anything else, so a
 * query this fake cannot faithfully model fails the suite instead of being
 * quietly mis-answered.
 *
 * It is a Proxy rather than a subclass because the fake builds its delegates as
 * instance fields in its constructor; there is no method to override.
 */
export function withRankedGroupBy(db: FakeTenantPrisma): PrismaService {
  const cache = new Map<string, unknown>();

  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string') return value;
      if (!isDelegate(value)) return typeof value === 'function' ? value.bind(target) : value;

      const cached = cache.get(property);
      if (cached) return cached;
      const wrapped = { ...value, groupBy: rankedGroupBy(value.groupBy) };
      cache.set(property, wrapped);
      return wrapped;
    },
  }) as unknown as PrismaService;
}

interface GroupByArgs {
  by: readonly string[];
  where?: Row;
  _count?: unknown;
  orderBy?: unknown;
  take?: number;
  skip?: number;
}

type GroupByFn = (args: GroupByArgs) => Promise<Row[]>;

function isDelegate(value: unknown): value is { groupBy: GroupByFn } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { groupBy?: unknown }).groupBy === 'function'
  );
}

function rankedGroupBy(inner: GroupByFn): GroupByFn {
  return async (args: GroupByArgs): Promise<Row[]> => {
    const groups = await inner(args);
    const ordered = sort(groups, args.orderBy);
    const skip = args.skip ?? 0;
    return args.take === undefined ? ordered.slice(skip) : ordered.slice(skip, skip + args.take);
  };
}

/**
 * The `orderBy` shapes this module actually sends, and nothing else.
 *
 * `ScopedRepository.groupBy` defaults `orderBy` to the grouped columns
 * ascending when the caller gives none, so the array form turns up here for
 * every query that did not rank explicitly.
 */
function sort(groups: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return groups;

  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  const rows = [...groups];
  // Applied last-to-first so the first clause is the primary key of the sort.
  for (const clause of [...clauses].reverse()) {
    if (typeof clause !== 'object' || clause === null) {
      throw new Error(`analytics fake: unsupported groupBy orderBy ${JSON.stringify(orderBy)}`);
    }
    const entries = Object.entries(clause as Record<string, unknown>);
    if (entries.length !== 1) {
      throw new Error(`analytics fake: unsupported groupBy orderBy ${JSON.stringify(orderBy)}`);
    }
    const [key, value] = entries[0];

    if (key === '_count') {
      if (typeof value !== 'object' || value === null) {
        throw new Error('analytics fake: _count orderBy must name a field');
      }
      const [[field, direction]] = Object.entries(value as Record<string, unknown>);
      rows.sort((left, right) => {
        const delta = countOf(left, field) - countOf(right, field);
        return direction === 'desc' ? -delta : delta;
      });
      continue;
    }

    if (typeof value !== 'string') {
      throw new Error(`analytics fake: unsupported groupBy orderBy ${JSON.stringify(orderBy)}`);
    }
    rows.sort((left, right) => {
      const a = String(left[key] ?? '');
      const b = String(right[key] ?? '');
      const delta = a < b ? -1 : a > b ? 1 : 0;
      return value === 'desc' ? -delta : delta;
    });
  }
  return rows;
}

function countOf(group: Row, field: string): number {
  const raw = group._count;
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number') return value;
  }
  return 0;
}
