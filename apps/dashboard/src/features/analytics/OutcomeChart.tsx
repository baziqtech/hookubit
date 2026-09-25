import { cn } from '../../lib/cn';
import type { DeliverySeries } from '../../types/api';
import { BANDS, layoutSeries, type BandKey } from './series-layout';

/** Band → the two tokens it is drawn in. `in_flight` is not a band. */
const BAND_CLASS: Record<BandKey | 'in_flight', string> = {
  delivered_first_try: 'bg-ok-dot',
  delivered_after_retry: 'bg-warn-dot',
  failed: 'bg-danger-dot',
  // Not an outcome — work that has not finished. Muted and unlabelled, but
  // present, so the newest bar is not a cliff.
  in_flight: 'bg-line-strong',
};

/**
 * Delivery outcomes over time, as stacked bars.
 *
 * ## Why this is hand-drawn and not a charting library
 *
 * The whole chart is flex boxes with percentage heights. A charting library
 * would arrive at 40-200 KB to draw rectangles, bring its own colour and font
 * conventions to be overridden, and — the part that actually matters — its own
 * opinions about axis fitting and empty data, both of which this product needs
 * to control. `series-layout.ts` holds those decisions and is tested without a
 * DOM; this file is markup.
 *
 * ## The tooltip is a `title`, deliberately
 *
 * A hover card would need positioning, portals, and a touch story. The native
 * tooltip is free, keyboard-reachable through the bar's own focus, and cannot
 * end up rendered off the edge of the panel.
 */
export function OutcomeChart({
  series,
  className,
  height = 168,
}: {
  series: DeliverySeries;
  className?: string;
  height?: number;
}) {
  const chart = layoutSeries(series);

  return (
    <figure className={cn('flex flex-col gap-2', className)}>
      <div className="flex gap-2.5">
        {/* Y axis. `tabular` so the digits do not shuffle between refreshes. */}
        <div
          className="flex w-9 shrink-0 flex-col justify-between text-right text-2xs tabular text-ink-subtle"
          style={{ height }}
          aria-hidden="true"
        >
          {chart.ticks.map((tick, index) => (
            <span key={index}>{compact(tick)}</span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          {/* Gridlines, behind the bars. */}
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            {chart.ticks.map((_, index) => (
              <span key={index} className="h-px w-full bg-grid" />
            ))}
          </div>

          <div className="absolute inset-0 flex items-end gap-[3px]">
            {chart.bars.map((bar) => (
              <div
                key={bar.start}
                className="group relative flex h-full min-w-0 flex-1 flex-col justify-end gap-px"
                title={describe(bar.start, bar.end, bar.total, chart.totals && bar)}
              >
                {bar.empty ? (
                  // A baseline tick, not nothing: an empty bucket and a gap in
                  // the data must not look the same.
                  <span className="h-px w-full bg-line" />
                ) : (
                  // Reversed so the first band in `BANDS` ends up at the BOTTOM
                  // of the stack: best outcome on the baseline, worst on top,
                  // which is where the eye goes.
                  [...bar.segments].reverse().map((segment) => (
                    <span
                      key={segment.key}
                      className={cn('w-full rounded-[1px]', BAND_CLASS[segment.key])}
                      style={{ height: `${Math.max(segment.fraction * 100, 0.5)}%` }}
                    />
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* X axis, under the plot and offset by the Y axis gutter. */}
      <div className="flex gap-2.5">
        <span className="w-9 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 gap-[3px]">
          {chart.bars.map((bar, index) => (
            <span
              key={bar.start}
              className="min-w-0 flex-1 truncate text-center text-2xs tabular text-ink-subtle"
            >
              {chart.xLabels.get(index) ?? ''}
            </span>
          ))}
        </div>
      </div>

      {series.leading_partial && (
        <figcaption className="text-2xs text-ink-subtle">
          The oldest bar starts before the window does, because bars are cut on the clock rather
          than on the moment you opened this page.
        </figcaption>
      )}
    </figure>
  );
}

/** The legend, as its own export so a panel header can carry it. */
export function OutcomeLegend({ className }: { className?: string }) {
  return (
    <ul className={cn('flex items-center gap-3', className)}>
      {BANDS.map((band) => (
        <li key={band.key} className="flex items-center gap-1.5 text-2xs font-medium text-ink-muted">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-sm', BAND_CLASS[band.key])} />
          {band.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The tooltip. Names every band with a count, because a stacked bar read by eye
 * gives you a ratio at best.
 */
function describe(
  start: string,
  end: string,
  total: number,
  bar: { segments: Array<{ key: BandKey | 'in_flight'; count: number }> },
): string {
  const when = `${clock(start)}–${clock(end)}`;
  if (total === 0) return `${when} · nothing`;

  const parts = bar.segments.map((segment) => {
    const band = BANDS.find((candidate) => candidate.key === segment.key);
    return `${segment.count.toLocaleString()} ${band ? band.label.toLowerCase() : 'still going'}`;
  });
  return `${when} · ${total.toLocaleString()} deliveries — ${parts.join(', ')}`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 48210 → "48k". An axis label is read, not audited. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${round(value / 1_000)}k`;
  return String(value);
}

function round(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
