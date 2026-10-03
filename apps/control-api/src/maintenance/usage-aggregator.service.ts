import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newId } from '../common/ids';
// The unscoped client, deliberately. This sweep has no request, no user and no
// tenant; `src/maintenance/**` is allowlisted for exactly that.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * Metrics rolled into `usage_records`. Adding one here is all it takes; the
 * aggregation is generic over the list.
 */
export const USAGE_METRICS = ['events_ingested', 'deliveries', 'replays'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** How many hourly buckets one pass will fill. */
export const MAX_BUCKETS_PER_RUN = 48;

/** Advisory lock, so two replicas do not aggregate the same hour twice. */
export const USAGE_ADVISORY_LOCK_KEY = 0x4855_5341_4745_0001n;

export interface UsageReport {
  skipped: boolean;
  /** Hourly buckets filled by this pass. */
  buckets: number;
  rows: number;
  truncated: boolean;
}

/**
 * Hourly usage rollups, so the billing page has something true to show.
 *
 * ## Why aggregate at all, when the numbers are already in `events`
 *
 * They are, and counting them live is what `analytics/events` does. The
 * difference is the PERIOD: a bill is about a month, and a month of `events`
 * for a busy project is a sequential scan of the largest table in the system,
 * run every time somebody opens a page. The rollup turns that into 720 small
 * rows per project.
 *
 * It is also the only way the number can survive retention. The delivery ledger
 * is pruned; what a customer was charged for must not be.
 *
 * ## Why COMPLETE hours only
 *
 * The pass never aggregates the hour it is running in. A partial hour written
 * as a complete one is a number that goes UP after it was read, and the
 * `@@unique` upsert would happily overwrite it — so a bill assembled at 10:30
 * would disagree with the same bill assembled at 11:00, for the same period.
 * The most recent complete hour is the newest thing this ever writes.
 *
 * ## Why it is idempotent rather than incremental
 *
 * Every bucket is counted from the source tables and UPSERTED on
 * `(organization_id, project_id, metric, period_start)`. Re-running a pass
 * rewrites the same numbers; a crash halfway through loses nothing. An
 * incremental counter would need a watermark that is itself a thing to get
 * wrong, and getting it wrong means billing somebody twice.
 */
@Injectable()
export class UsageAggregatorService {
  private readonly logger = new Logger(UsageAggregatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sweep(now: Date = new Date()): Promise<UsageReport> {
    const locked = await this.takeLock();
    if (!locked) return { skipped: true, buckets: 0, rows: 0, truncated: false };

    const buckets = await this.pendingBuckets(now);
    let rows = 0;
    for (const start of buckets.slice(0, MAX_BUCKETS_PER_RUN)) {
      rows += await this.fill(start);
    }

    const report: UsageReport = {
      skipped: false,
      buckets: Math.min(buckets.length, MAX_BUCKETS_PER_RUN),
      rows,
      truncated: buckets.length > MAX_BUCKETS_PER_RUN,
    };
    if (report.buckets > 0) {
      this.logger.log(
        `Usage: ${report.rows} rows across ${report.buckets} hours${report.truncated ? ' (more are waiting)' : ''}.`,
      );
    }
    return report;
  }

  /**
   * The complete hours that have not been rolled up yet, oldest first.
   *
   * Bounded by looking back a fixed window rather than by a watermark: a
   * watermark is a thing that can be wrong, and being wrong here means a
   * customer's usage silently stops being counted. Re-checking the last two
   * days every pass costs a small indexed query and cannot drift.
   */
  private async pendingBuckets(now: Date): Promise<Date[]> {
    const HOUR = 3_600_000;
    const currentHour = Math.floor(now.getTime() / HOUR) * HOUR;
    const oldest = currentHour - MAX_BUCKETS_PER_RUN * HOUR;

    const existing = await this.prisma.usageRecord.findMany({
      where: { periodStart: { gte: new Date(oldest) }, metric: USAGE_METRICS[0] },
      select: { periodStart: true },
      distinct: ['periodStart'],
    });
    const done = new Set(existing.map((row) => row.periodStart.getTime()));

    const pending: Date[] = [];
    // `< currentHour`, never `<=`: the hour we are in is not complete, and
    // writing it as if it were makes a bill that changes after it was read.
    for (let start = oldest; start < currentHour; start += HOUR) {
      if (!done.has(start)) pending.push(new Date(start));
    }
    return pending;
  }

  /** Count one hour, for every project that had any activity in it. */
  private async fill(start: Date): Promise<number> {
    const end = new Date(start.getTime() + 3_600_000);
    const window = { gte: start, lt: end };

    const [events, deliveries, replays] = await Promise.all([
      this.prisma.event.groupBy({
        by: ['organizationId', 'projectId'],
        where: { createdAt: window },
        _count: { _all: true },
      }),
      this.prisma.delivery.groupBy({
        by: ['organizationId', 'projectId'],
        where: { createdAt: window },
        _count: { _all: true },
      }),
      // A replay is a delivery that points at an earlier one. Counted
      // separately because it is the metric customers ask about — "am I being
      // charged twice for fixing your outage?" — and the honest answer needs
      // the number to be visible rather than folded into deliveries.
      this.prisma.delivery.groupBy({
        by: ['organizationId', 'projectId'],
        where: { createdAt: window, replayOfDeliveryId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const rows: Prisma.UsageRecordCreateManyInput[] = [
      ...toRows('events_ingested', events, start, end),
      ...toRows('deliveries', deliveries, start, end),
      ...toRows('replays', replays, start, end),
    ];

    for (const row of rows) {
      await this.prisma.usageRecord.upsert({
        where: {
          organizationId_projectId_metric_periodStart: {
            organizationId: row.organizationId,
            // Never null here — every row this sweep writes is per project.
            // The org-level rollup exists in the schema for a summary nobody
            // writes yet, and giving it a different shape would make the
            // NULLS NOT DISTINCT index do two jobs.
            projectId: row.projectId as string,
            metric: row.metric,
            periodStart: row.periodStart as Date,
          },
        },
        create: row,
        // Overwrite, never increment. The count is recomputed from the source,
        // so a re-run must land on the same number rather than doubling it.
        update: { quantity: row.quantity },
      });
    }

    return rows.length;
  }

  private async takeLock(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${USAGE_ADVISORY_LOCK_KEY}::bigint) AS locked`;
    return rows[0]?.locked === true;
  }
}

function toRows(
  metric: UsageMetric,
  groups: Array<{ organizationId: string; projectId: string; _count: { _all: number } }>,
  periodStart: Date,
  periodEnd: Date,
): Prisma.UsageRecordCreateManyInput[] {
  return groups
    .filter((group) => group._count._all > 0)
    .map((group) => ({
      id: newId('usage'),
      organizationId: group.organizationId,
      projectId: group.projectId,
      metric,
      quantity: BigInt(group._count._all),
      periodStart,
      periodEnd,
    }));
}
