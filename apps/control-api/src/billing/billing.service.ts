import { Injectable } from '@nestjs/common';
import { RequestContext, TenantScopeFactory } from '../authz';
import { BillingDto, UsageLineDto } from './dto';

const METRICS = ['events_ingested', 'deliveries', 'replays'] as const;

/**
 * What an organization is using, and what it is on.
 *
 * ## What this is honest about
 *
 * There is no payment provider, no invoice and no price anywhere in this
 * system. `billable` is false and the page renders that as a sentence rather
 * than as an empty invoice table with a total of $0.00 — a fabricated invoice
 * is worse than no invoice, because somebody will believe it.
 *
 * What IS real is the metered volume. `usage_records` is filled hourly by
 * `UsageAggregatorService`, and this reads those rollups rather than counting
 * the source tables: a month of `events` for a busy project is a sequential
 * scan of the largest table in the system, and this page would run it on every
 * open.
 *
 * ## Why the period ends at the last complete hour
 *
 * Because that is the newest thing the rollup ever writes. Reporting the period
 * as ending "now" would label a number that stops at 10:00 as covering 10:37,
 * and the difference is exactly the traffic somebody is looking for when they
 * open this page during an incident.
 */
@Injectable()
export class BillingService {
  constructor(private readonly scopes: TenantScopeFactory) {}

  async summary(context: RequestContext, now: Date = new Date()): Promise<BillingDto> {
    const scope = this.scopes.for(context);

    // Calendar month to date, in UTC. Not "the last 30 days": a bill is about a
    // month, and a rolling window would disagree with any invoice ever issued.
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const periodEnd = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

    const [subscription, totals] = await Promise.all([
      scope.billingSubscriptions.findFirst({
        orderBy: { createdAt: 'desc' },
      }),
      this.totals(scope, periodStart, periodEnd),
    ]);

    return {
      /*
       * Always null today, and deliberately.
       *
       * `plans` is a GLOBAL table — it has no tenant column and therefore no
       * `TenantScope` accessor, which is correct: a plan is not something an
       * organization owns. Reading it would need the unscoped client, and there
       * is nothing to read: no plans are defined anywhere.
       *
       * Reporting that as null rather than inventing a free tier is the whole
       * point. A null plan is not an allowance of zero and it is not something
       * anybody agreed to, and the page renders the difference.
       */
      plan: null,
      status: subscription?.status ?? null,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      usage: METRICS.map(
        (metric): UsageLineDto => ({
          metric,
          used: (totals.get(metric) ?? 0n).toString(),
          included: null,
        }),
      ),
      billable: false,
    };
  }

  /**
   * Sum the hourly rollups for the period.
   *
   * One grouped `_sum` over `usage_records`, which is ~720 small rows per
   * project per month — as opposed to counting `events` and `deliveries`, which
   * is the two largest tables in the system.
   */
  private async totals(
    scope: ReturnType<TenantScopeFactory['for']>,
    from: Date,
    to: Date,
  ): Promise<Map<string, bigint>> {
    const groups = await scope.usageRecords.groupBy({
      by: ['metric'],
      where: { periodStart: { gte: from, lt: to } },
      _sum: { quantity: true },
      take: 16,
    });

    const totals = new Map<string, bigint>();
    for (const group of groups) {
      const metric = group.metric;
      const sum = (group._sum as { quantity?: bigint | null } | undefined)?.quantity;
      if (typeof metric === 'string') totals.set(metric, sum ?? 0n);
    }
    return totals;
  }
}
