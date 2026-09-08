import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  NoBackendRoute,
  PageHeader,
  Panel,
  Stat,
} from '../../components';
import { usingMockApi } from '../../lib/api';
import { formatCount, formatDuration, formatPercent, formatTimestamp } from '../../lib/format';
import type { AnalyticsPoint, ProjectAnalytics } from '../../types/api';
import { useAnalytics } from '../projects/api';

/**
 * Delivery volume, outcome mix and latency over the last 24 hours.
 *
 * `GET /v1/projects/:id/analytics` IS NOT IN THE OPENAPI DOCUMENT. Not "a
 * module whose shape drifted" — there is no analytics module at all, and none
 * of the 42 published paths would answer this. Under the real transport the
 * page therefore refuses to run the query and says so; under the mock it
 * renders, because the screen itself is finished and worth keeping ready for
 * the route that lands.
 *
 * Charted with inline SVG and no charting dependency. The data is 24 points
 * with three series; a library would be more bundle than the whole feature, and
 * the accessible fallback (a real table, below) is the part that actually
 * matters for an operator surface.
 */
export function AnalyticsPage() {
  const { projectId = '' } = useParams();
  const analytics = useAnalytics(projectId);

  if (!usingMockApi) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Analytics"
          description="Delivery volume, outcome mix and latency over the last 24 hours."
        />
        <Panel>
          <NoBackendRoute
            title="Analytics"
            path="GET /v1/projects/:projectId/analytics"
            purpose="It would need bucketed delivery counts by outcome and a p95 latency per bucket — derivable from delivery_attempts, but not something the dashboard can compute from a paged list."
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Analytics"
        description="Delivery volume, outcome mix and latency over the last 24 hours."
        actions={<Badge tone="neutral">24h</Badge>}
      />

      <Async
        query={analytics}
        isEmpty={(data) => data.totals.total === 0}
        empty={
          <Panel>
            <EmptyState
              title="No deliveries in the last 24 hours"
              description="Charts appear once this project has published an event that matched a subscription. Nothing here is an error — there is simply no traffic yet."
            />
          </Panel>
        }
      >
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Success rate"
                value={formatPercent(data.success_rate, 2)}
                tone={data.success_rate < 0.99 ? 'warn' : 'ok'}
                hint={`${formatCount(data.totals.total)} deliveries`}
              />
              <Stat
                label="Failed"
                value={formatCount(data.totals.failed)}
                tone={data.totals.failed > 0 ? 'danger' : 'default'}
                hint={`${formatCount(data.totals.exhausted)} exhausted every retry`}
              />
              <Stat
                label="In retry"
                value={formatCount(data.totals.pending)}
                tone={data.totals.pending > 0 ? 'warn' : 'default'}
                hint="Awaiting another attempt"
              />
              <Stat
                label="p95 latency"
                value={formatDuration(data.p95_latency_ms)}
                hint="How long endpoints take to answer"
              />
            </div>

            <Panel
              title="Delivery outcomes by hour"
              description="Stacked: succeeded, retrying, failed."
            >
              <OutcomeChart points={data.points} />
            </Panel>

            <Panel title="p95 latency by hour" description="Endpoint response time.">
              <LatencyChart points={data.points} />
            </Panel>

            <Panel flush title="Hourly detail">
              <HourTable data={data} />
            </Panel>

            <p className="text-2xs leading-relaxed text-ink-subtle">
              This route is served by the mock transport. There is no analytics module in the
              control API yet, so the shape above is provisional — see HANDOFF.md.
            </p>
          </>
        )}
      </Async>
    </div>
  );
}

const CHART_HEIGHT = 140;

/**
 * Stacked bars, one per hour.
 *
 * Colour is never the only carrier of meaning here: the legend names each
 * series, and the table underneath repeats every value. That table is not a
 * concession — on an operator surface the exact number at 03:00 is the thing
 * someone actually needs, and reading it off a bar is guesswork.
 */
function OutcomeChart({ points }: { points: AnalyticsPoint[] }) {
  const peak = Math.max(1, ...points.map((p) => p.succeeded + p.failed + p.retrying));
  const width = 100 / points.length;

  return (
    <figure className="flex flex-col gap-2">
      <div
        className="relative w-full overflow-hidden rounded-md border border-line bg-raised/40"
        style={{ height: CHART_HEIGHT }}
      >
        <svg
          viewBox={`0 0 100 ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Delivery outcomes for each of the last ${points.length} hours. Peak volume ${peak} deliveries in an hour. Exact values are in the table below.`}
        >
          {points.map((point, index) => {
            const total = point.succeeded + point.failed + point.retrying;
            const scale = (value: number) => (value / peak) * (CHART_HEIGHT - 8);
            const heights = {
              succeeded: scale(point.succeeded),
              retrying: scale(point.retrying),
              failed: scale(point.failed),
            };
            const x = index * width;
            const barWidth = width * 0.72;
            const offset = (width - barWidth) / 2;

            let y = CHART_HEIGHT - 4;
            const segments: { key: string; fill: string; height: number }[] = [
              { key: 'succeeded', fill: 'rgb(var(--c-ok))', height: heights.succeeded },
              { key: 'retrying', fill: 'rgb(var(--c-warn))', height: heights.retrying },
              { key: 'failed', fill: 'rgb(var(--c-danger))', height: heights.failed },
            ];

            return (
              <g key={point.bucket}>
                <title>
                  {`${hourLabel(point.bucket)} — ${total} deliveries: ${point.succeeded} succeeded, ${point.retrying} retrying, ${point.failed} failed`}
                </title>
                {segments.map((segment) => {
                  y -= segment.height;
                  return (
                    <rect
                      key={segment.key}
                      x={x + offset}
                      y={y}
                      width={barWidth}
                      height={Math.max(segment.height, 0)}
                      fill={segment.fill}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="flex flex-wrap items-center gap-3 text-2xs text-ink-subtle">
        <LegendSwatch className="bg-ok" label="Succeeded" />
        <LegendSwatch className="bg-warn" label="Retrying" />
        <LegendSwatch className="bg-danger" label="Failed" />
        <span className="ml-auto tabular">Peak {formatCount(peak)}/hour</span>
      </figcaption>
    </figure>
  );
}

function LatencyChart({ points }: { points: AnalyticsPoint[] }) {
  const peak = Math.max(1, ...points.map((point) => point.p95_latency_ms));
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * 100;
      const y = CHART_HEIGHT - 4 - (point.p95_latency_ms / peak) * (CHART_HEIGHT - 12);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <figure className="flex flex-col gap-2">
      <div
        className="w-full overflow-hidden rounded-md border border-line bg-raised/40"
        style={{ height: CHART_HEIGHT }}
      >
        <svg
          viewBox={`0 0 100 ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`p95 endpoint latency over the last ${points.length} hours, peaking at ${formatDuration(peak)}. Exact values are in the table below.`}
        >
          <path
            d={path}
            fill="none"
            stroke="rgb(var(--c-accent))"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <figcaption className="flex items-center justify-between text-2xs text-ink-subtle">
        <span>{hourLabel(points[0]?.bucket ?? '')}</span>
        <span className="tabular">Peak {formatDuration(peak)}</span>
        <span>{hourLabel(points[points.length - 1]?.bucket ?? '')}</span>
      </figcaption>
    </figure>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

/** The chart's accessible equal, and the thing an operator reads a number off. */
function HourTable({ data }: { data: ProjectAnalytics }) {
  return (
    <div className="max-h-80 overflow-y-auto scrollbar-thin">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Delivery outcomes and p95 latency for each hour</caption>
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {['Hour', 'Succeeded', 'Retrying', 'Failed', 'p95'].map((header, index) => (
              <th
                key={header}
                scope="col"
                className={`whitespace-nowrap px-3 py-2 text-2xs font-medium uppercase tracking-wider text-ink-subtle ${
                  index === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...data.points].reverse().map((point) => (
            <tr key={point.bucket} className="border-b border-line last:border-0">
              <td className="px-3 py-1.5 text-xs text-ink-muted" title={formatTimestamp(point.bucket)}>
                {hourLabel(point.bucket)}
              </td>
              <td className="px-3 py-1.5 text-right text-xs tabular text-ink">{point.succeeded}</td>
              <td className="px-3 py-1.5 text-right text-xs tabular text-warn">{point.retrying}</td>
              <td className="px-3 py-1.5 text-right text-xs tabular text-danger">{point.failed}</td>
              <td className="px-3 py-1.5 text-right text-xs tabular text-ink-muted">
                {formatDuration(point.p95_latency_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `14:00` in UTC — the same clock the timestamps elsewhere on the product use. */
function hourLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getUTCHours().toString().padStart(2, '0')}:00`;
}
