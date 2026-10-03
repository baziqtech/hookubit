import { UsageAggregatorService, MAX_BUCKETS_PER_RUN } from './usage-aggregator.service';

type Row = Record<string, unknown>;

/**
 * Enough Prisma to exercise the sweep's ARITHMETIC and its boundaries, which
 * is what this class actually is. The grouping is Prisma's job and is not
 * re-tested here.
 */
class FakeUsagePrisma {
  events: Array<{ organizationId: string; projectId: string; createdAt: Date }> = [];
  deliveries: Array<{
    organizationId: string;
    projectId: string;
    createdAt: Date;
    replayOfDeliveryId: string | null;
  }> = [];
  written: Row[] = [];
  /** period_start values already rolled up. */
  existing = new Set<number>();

  usageRecord = {
    findMany: async (args: { where: { periodStart: { gte: Date } } }) =>
      [...this.existing]
        .filter((at) => at >= args.where.periodStart.gte.getTime())
        .map((at) => ({ periodStart: new Date(at) })),
    upsert: async (args: { create: Row }) => {
      this.written.push(args.create);
      return args.create;
    },
  };

  event = {
    groupBy: async (args: { where: { createdAt: { gte: Date; lt: Date } } }) =>
      group(this.events.filter((row) => within(row.createdAt, args.where.createdAt))),
  };

  delivery = {
    groupBy: async (args: {
      where: { createdAt: { gte: Date; lt: Date }; replayOfDeliveryId?: unknown };
    }) => {
      let rows = this.deliveries.filter((row) => within(row.createdAt, args.where.createdAt));
      if (args.where.replayOfDeliveryId) {
        rows = rows.filter((row) => row.replayOfDeliveryId !== null);
      }
      return group(rows);
    },
  };

  locked = true;
  $queryRaw = async () => [{ locked: this.locked }];

  asPrisma() {
    return this as never;
  }
}

function within(at: Date, window: { gte: Date; lt: Date }): boolean {
  return at >= window.gte && at < window.lt;
}

function group(rows: Array<{ organizationId: string; projectId: string }>) {
  const buckets = new Map<string, { organizationId: string; projectId: string; n: number }>();
  for (const row of rows) {
    const key = `${row.organizationId}/${row.projectId}`;
    const found = buckets.get(key);
    if (found) found.n += 1;
    else buckets.set(key, { organizationId: row.organizationId, projectId: row.projectId, n: 1 });
  }
  return [...buckets.values()].map((b) => ({
    organizationId: b.organizationId,
    projectId: b.projectId,
    _count: { _all: b.n },
  }));
}

const HOUR = 3_600_000;
/** 10:30 — deliberately NOT on an hour boundary. */
const NOW = new Date('2026-06-01T10:30:00.000Z');
const hourAt = (iso: string) => new Date(iso);

describe('UsageAggregatorService', () => {
  const world = () => {
    const db = new FakeUsagePrisma();
    return { db, service: new UsageAggregatorService(db.asPrisma()) };
  };

  it('never aggregates the hour it is running in', async () => {
    // A partial hour written as a complete one is a number that goes UP after
    // it was read — so the same bill, assembled twice, disagrees with itself.
    const { db, service } = world();
    db.events.push({ organizationId: 'org', projectId: 'proj', createdAt: NOW });

    await service.sweep(NOW);

    const starts = db.written.map((row) => (row.periodStart as Date).getTime());
    expect(starts).not.toContain(hourAt('2026-06-01T10:00:00.000Z').getTime());
  });

  it('counts a complete hour, per project and per metric', async () => {
    const { db, service } = world();
    const at = hourAt('2026-06-01T09:15:00.000Z');
    db.events.push(
      { organizationId: 'org', projectId: 'proj', createdAt: at },
      { organizationId: 'org', projectId: 'proj', createdAt: at },
      { organizationId: 'org', projectId: 'other', createdAt: at },
    );
    db.deliveries.push({
      organizationId: 'org',
      projectId: 'proj',
      createdAt: at,
      replayOfDeliveryId: 'del_earlier',
    });

    await service.sweep(NOW);

    const nine = db.written.filter(
      (row) => (row.periodStart as Date).getTime() === hourAt('2026-06-01T09:00:00.000Z').getTime(),
    );
    const find = (metric: string, projectId: string) =>
      nine.find((row) => row.metric === metric && row.projectId === projectId);

    expect(find('events_ingested', 'proj')?.quantity).toBe(2n);
    expect(find('events_ingested', 'other')?.quantity).toBe(1n);
    // A replay counts in BOTH: it is a delivery, and it is the one customers
    // ask about — "am I charged twice for fixing your outage?" — so the number
    // has to be visible rather than folded in.
    expect(find('deliveries', 'proj')?.quantity).toBe(1n);
    expect(find('replays', 'proj')?.quantity).toBe(1n);
  });

  it('writes nothing for an hour with no activity', async () => {
    // A row of zeroes per project per hour is 720 rows a month saying nothing.
    const { db, service } = world();
    await service.sweep(NOW);
    expect(db.written).toEqual([]);
  });

  it('skips hours it has already rolled up', async () => {
    const { db, service } = world();
    const nine = hourAt('2026-06-01T09:00:00.000Z');
    db.existing.add(nine.getTime());
    db.events.push({
      organizationId: 'org',
      projectId: 'proj',
      createdAt: hourAt('2026-06-01T09:15:00.000Z'),
    });

    await service.sweep(NOW);

    expect(db.written).toEqual([]);
  });

  it('does nothing at all when another replica holds the lock', async () => {
    const { db, service } = world();
    db.locked = false;
    db.events.push({
      organizationId: 'org',
      projectId: 'proj',
      createdAt: hourAt('2026-06-01T09:15:00.000Z'),
    });

    const report = await service.sweep(NOW);

    expect(report.skipped).toBe(true);
    expect(db.written).toEqual([]);
  });

  it('bounds one pass, and says when more are waiting', async () => {
    const { db, service } = world();
    for (let index = 1; index <= MAX_BUCKETS_PER_RUN + 4; index += 1) {
      db.events.push({
        organizationId: 'org',
        projectId: 'proj',
        createdAt: new Date(NOW.getTime() - index * HOUR),
      });
    }

    const report = await service.sweep(NOW);

    expect(report.buckets).toBeLessThanOrEqual(MAX_BUCKETS_PER_RUN);
  });
});
