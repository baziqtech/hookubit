import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { formatCount } from '../../lib/format';
import type { DeliverySeries } from '../../types/api';
import { layoutSeries, settledRate, type ChartLayout } from './series-layout';

/**
 * The headline number, and the three ways a delivery reached it.
 *
 * ## Why this is computed from the SERIES and not from the outcome summary
 *
 * The summary route gives a success rate over settled deliveries, which is the
 * same number — but it cannot split "delivered" from "delivered after a retry",
 * because that is a predicate on `attempt_count` rather than a status. That
 * split is the interesting half: a project at 99.3% where a third of the
 * successes needed a retry is a project with a problem, and one where none did
 * is not. Same rate, different day.
 *
 * ## Why the rate can be absent
 *
 * `null` means nothing settled in the window. Rendering that as 0% would say
 * "everything we tried failed", which is the loudest thing this panel can say,
 * about a project that simply had no traffic.
 */
export function OutcomeSplit({
  series,
  stuckCount,
  stuckHref,
  className,
}: {
  series: DeliverySeries;
  /**
   * Events accepted and never fanned out. They have no delivery rows, so they
   * are in NONE of the numbers here — which is exactly why the panel has to
   * mention them.
   */
  stuckCount?: number;
  stuckHref?: string;
  className?: string;
}) {
  const chart = layoutSeries(series);
  const rate = settledRate(chart.totals);
  const settled =
    chart.totals.delivered_first_try + chart.totals.delivered_after_retry + chart.totals.failed;

  return (
    <div className={cn('flex flex-col gap-3.5', className)}>
      <div className="flex flex-col gap-1">
        <span className="text-hero font-semibold tabular text-ink">
          {rate === null ? '—' : `${(rate * 100).toFixed(2)}%`}
        </span>
        <span className="text-xs text-ink-muted">
          {rate === null
            ? 'No delivery settled in this window, so there is no rate to report. That is not 0%.'
            : `of ${formatCount(settled)} deliveries that settled in this window`}
        </span>
      </div>

      {settled > 0 && <ProportionBar chart={chart} settled={settled} />}

      <dl className="flex flex-col gap-1.5">
        <SplitRow
          dot="bg-ok-dot"
          label="Delivered first try"
          value={chart.totals.delivered_first_try}
          settled={settled}
        />
        <SplitRow
          dot="bg-warn-dot"
          label="Delivered after retry"
          value={chart.totals.delivered_after_retry}
          settled={settled}
        />
        <SplitRow
          dot="bg-danger-dot"
          label="Failed permanently"
          value={chart.totals.failed}
          settled={settled}
        />
        {chart.totals.in_flight > 0 && (
          <SplitRow
            dot="bg-line-strong"
            label="Still going"
            value={chart.totals.in_flight}
            settled={null}
          />
        )}
      </dl>

      {stuckCount !== undefined && stuckCount > 0 && stuckHref && (
        <div className="flex flex-col gap-1.5 rounded-[0.625rem] border border-warn/30 bg-warn-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-warn">
            {formatCount(stuckCount)} {stuckCount === 1 ? 'event is' : 'events are'} not counted
            above
          </p>
          <p className="text-2xs text-ink-muted">
            They never became deliveries, so they have no outcome to count. A success rate built
            only from deliveries cannot see them.
          </p>
          <Link
            to={stuckHref}
            className="text-2xs font-semibold text-accent underline-offset-2 hover:underline"
          >
            See stuck events
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * One bar, three shares. Not a pie: three values one of which is usually 99% of
 * the total are three slices nobody can compare, and the two that matter are
 * the slivers.
 */
function ProportionBar({ chart, settled }: { chart: ChartLayout; settled: number }) {
  const bands = [
    { key: 'ok', value: chart.totals.delivered_first_try, className: 'bg-ok-dot' },
    { key: 'warn', value: chart.totals.delivered_after_retry, className: 'bg-warn-dot' },
    { key: 'danger', value: chart.totals.failed, className: 'bg-danger-dot' },
  ].filter((band) => band.value > 0);

  return (
    <div aria-hidden="true" className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
      {bands.map((band) => (
        <span
          key={band.key}
          className={band.className}
          // A band worth 0.01% still has to be visible, or the bar says
          // "nothing ever fails here" on a project where something does.
          style={{ width: `${Math.max((band.value / settled) * 100, 1)}%` }}
        />
      ))}
    </div>
  );
}

function SplitRow({
  dot,
  label,
  value,
  settled,
}: {
  dot: string;
  label: string;
  value: number;
  /** Null for a row that is not part of the settled total, e.g. in flight. */
  settled: number | null;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <dt className="min-w-0 flex-1 truncate text-xs text-ink-muted">{label}</dt>
      <dd className="text-xs font-semibold tabular text-ink">{formatCount(value)}</dd>
      {settled !== null && (
        <span className="w-14 text-right text-2xs tabular text-ink-subtle">
          {settled === 0 ? '—' : `${((value / settled) * 100).toFixed(2)}%`}
        </span>
      )}
    </div>
  );
}
