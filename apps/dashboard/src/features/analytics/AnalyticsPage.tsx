import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  Badge,
  DeliveryStatusBadge,
  EmptyState,
  PageHeader,
  Panel,
  Stat,
  Table,
  type Column,
} from '../../components';
import { cn } from '../../lib/cn';
import { deliveryStatusMeta, type StatusTone } from '../../lib/delivery-status';
import { formatCount, formatDuration, formatPercent, truncateId } from '../../lib/format';
import type {
  AttemptLatency,
  DeliveryOutcomes,
  DeliveryStatus,
  EventVolume,
  FailingEndpoint,
} from '../../types/api';
import { DEFAULT_ANALYTICS_LIMIT } from '../../types/api';
import {
  useAttemptLatency,
  useDeliveryOutcomes,
  useEventVolume,
  useFailingEndpoints,
} from './api';
import {
  fanOutRatio,
  formatCountDelta,
  formatNullableDuration,
  formatRate,
  formatRateDelta,
  formatRatio,
  rateTone,
  share,
} from './derive';
import { WindowCaption } from './tiles';
import {
  ANALYTICS_WINDOWS,
  DEFAULT_WINDOW_KEY,
  parseWindowKey,
  windowFor,
  type AnalyticsWindowKey,
} from './window';

/**
 * Four questions, four routes, four panels that land independently.
 *
 * There is NO hourly time series. `AnalyticsService` explains why: bucketing
 * needs `date_trunc`, which needs raw SQL, which is banned outside the
 * allowlist; the honest alternative it offers is every count for the window
 * AND for the immediately preceding window of equal length, with the delta.
 * So this page compares rather than charts. The bars beside each table are
 * proportions of counts the response actually carries — never a bucket this
 * page made up — and the table is the accessible equal of every bar.
 *
 * The window is in the URL (`?window=24h|7d|30d`) so a link pasted into an
 * incident channel opens on the same period. Everything on the page is read
 * from a response field; the two derivations (fan-out and share-of-total) are
 * named where they appear.
 */
export function AnalyticsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const windowKey = parseWindowKey(searchParams.get('window'));
  const window = windowFor(windowKey);
  const base = `/orgs/${orgId}/projects/${projectId}`;

  const outcomes = useDeliveryOutcomes(projectId, window.hours);
  const ranking = useFailingEndpoints(projectId, window.hours, DEFAULT_ANALYTICS_LIMIT);
  const latency = useAttemptLatency(projectId, window.hours);
  const events = useEventVolume(projectId, window.hours, DEFAULT_ANALYTICS_LIMIT);

  const setWindow = (key: AnalyticsWindowKey) => {
    const next = new URLSearchParams(searchParams);
    if (key === DEFAULT_WINDOW_KEY) next.delete('window');
    else next.set('window', key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Analytics"
        description={`Delivery outcomes, failing endpoints, attempt latency and event volume over the ${window.label.toLowerCase()}, each beside ${window.previous}.`}
        actions={<WindowSelector value={windowKey} onChange={setWindow} />}
      />

      <Panel
        title="Delivery outcomes"
        description={`Every delivery created in the ${window.label.toLowerCase()}, by status, compared with ${window.previous}.`}
      >
        <Async
          query={outcomes}
          isEmpty={(data) => data.current.total === 0 && data.previous.total === 0}
          empty={
            <EmptyState
              title={`No deliveries in the ${window.label.toLowerCase()}`}
              description="Nor in the window before it. Nothing here is an error — a delivery exists once a published event matches a subscription."
            />
          }
        >
          {(data) => <Outcomes data={data} previousLabel={window.previous} base={base} />}
        </Async>
      </Panel>

      <Panel
        title="Failing endpoints"
        description="Worst first by failed + exhausted. Read the rate beside the count: one endpoint at 100% of two deliveries is not the outage; the one at 40% of twelve thousand is."
        flush
      >
        <Async
          query={ranking}
          isEmpty={(data) => data.data.length === 0}
          empty={
            <EmptyState
              title="No failed or exhausted deliveries"
              description={`No endpoint had a delivery end badly in the ${window.label.toLowerCase()}.`}
            />
          }
        >
          {(data) => (
            <>
              <Table
                caption={`Endpoints ranked by failing deliveries in the ${window.label.toLowerCase()}`}
                columns={rankingColumns(base)}
                rows={data.data}
                rowKey={(row) => row.endpoint_id}
              />
              <div className="flex flex-col gap-1 border-t border-line px-4 py-2.5">
                {data.has_more && (
                  <p className="text-2xs text-ink-muted">
                    More endpoints had failures than the {data.data.length} shown. These are still
                    the worst; the list is not the whole set.
                  </p>
                )}
                <WindowCaption window={data.window} />
              </div>
            </>
          )}
        </Async>
      </Panel>

      <Panel
        title="Attempt latency"
        description="How long endpoints took to answer, nearest-rank over measured attempts. Every value is a duration some request actually took."
      >
        <Async query={latency}>{(data) => <Latency data={data} />}</Async>
      </Panel>

      <Panel
        title="Event volume"
        description={`Events published in the ${window.label.toLowerCase()} — not deliveries. One event fans out to one delivery per matching subscription, so the two totals differ and their ratio is this project's fan-out.`}
      >
        <Async
          query={events}
          isEmpty={(data) => data.total === 0 && data.previous_total === 0}
          empty={
            <EmptyState
              title={`No events published in the ${window.label.toLowerCase()}`}
              description="Nor in the window before it."
            />
          }
        >
          {(data) => (
            <Events
              data={data}
              deliveriesTotal={outcomes.data?.current.total}
              deliveriesPending={outcomes.isPending}
              previousLabel={window.previous}
              base={base}
            />
          )}
        </Async>
      </Panel>
    </div>
  );
}

/**
 * A group of pressed/unpressed buttons rather than tabs: the panels below are
 * not tab panels, and the value is a URL parameter that survives a reload.
 */
function WindowSelector({
  value,
  onChange,
}: {
  value: AnalyticsWindowKey;
  onChange: (key: AnalyticsWindowKey) => void;
}) {
  return (
    <div role="group" aria-label="Window" className="flex rounded-md border border-line bg-panel p-0.5">
      {ANALYTICS_WINDOWS.map((window) => {
        const active = window.key === value;
        return (
          <button
            key={window.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(window.key)}
            className={cn(
              'h-6 rounded px-2.5 text-xs transition-colors',
              active ? 'bg-raised font-medium text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {window.key}
          </button>
        );
      })}
    </div>
  );
}

/* ── Delivery outcomes ────────────────────────────────────────────────────── */

/** The nine statuses in the order the legend uses: waiting → moving → settled. */
const STATUS_ORDER: DeliveryStatus[] = [
  'pending',
  'queued',
  'processing',
  'scheduled',
  'retrying',
  'failed',
  'succeeded',
  'exhausted',
  'cancelled',
];

const BAR_TONES: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-ink-subtle',
};

function Outcomes({
  data,
  previousLabel,
  base,
}: {
  data: DeliveryOutcomes;
  previousLabel: string;
  base: string;
}) {
  const { current, previous } = data;
  const rows = STATUS_ORDER.map((status) => ({
    status,
    current: current.by_status[status],
    previous: previous.by_status[status],
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {/*
          `success_rate` is over SETTLED deliveries only and is NULL when none
          settled. Null is words here, never 0%. `success_rate_delta` is null
          when either window had nothing settled.
        */}
        <Stat
          label="Success rate"
          value={formatRate(current.success_rate)}
          tone={rateTone(current.success_rate)}
          hint={
            current.success_rate === null
              ? 'No delivery settled in this window'
              : `${formatRateDelta(data.success_rate_delta)} vs ${previousLabel} (${formatRate(previous.success_rate)})`
          }
        />
        <Stat
          label="Deliveries created"
          value={formatCount(current.total)}
          hint={`${formatCountDelta(data.total_delta)} vs ${previousLabel} (${formatCount(previous.total)})`}
        />
        <Stat
          label="Succeeded"
          value={formatCount(current.succeeded)}
          tone={current.succeeded > 0 ? 'ok' : 'default'}
          hint={`${formatCount(previous.succeeded)} in ${previousLabel}`}
        />
        <Stat
          label="Failing"
          value={formatCount(current.failing)}
          tone={current.failing > 0 ? 'danger' : 'default'}
          hint={`${formatCount(current.by_status.failed)} failed with retries left · ${formatCount(current.exhausted)} exhausted`}
        />
        <Stat
          label="In flight"
          value={formatCount(current.in_flight)}
          tone={current.in_flight > 0 ? 'warn' : 'default'}
          hint="Pending, scheduled, queued, processing or retrying — not an outcome yet"
        />
        <Stat
          label="Cancelled"
          value={formatCount(current.cancelled)}
          hint="Neither a success nor a failure"
        />
      </div>

      <ProportionBar
        label={`Share of the ${formatCount(current.total)} deliveries created in this window, by status`}
        segments={rows.map((row) => ({
          key: row.status,
          share: share(row.current, current.total),
          className: BAR_TONES[deliveryStatusMeta(row.status).tone],
        }))}
      />

      <div className="-mx-4 -mb-4 border-t border-line">
        <Table
          caption="Deliveries by status, this window beside the previous one"
          columns={outcomeColumns(current.total, base)}
          rows={rows}
          rowKey={(row) => row.status}
        />
        <div className="border-t border-line px-4 py-2.5">
          <WindowCaption window={data.window}>
            Share is each status’s count over the {formatCount(current.total)} deliveries created
            in this window.
          </WindowCaption>
        </div>
      </div>
    </div>
  );
}

interface OutcomeRow {
  status: DeliveryStatus;
  current: number;
  previous: number;
}

function outcomeColumns(total: number, base: string): Column<OutcomeRow>[] {
  return [
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Link to={`${base}/deliveries?status=${row.status}`} className="hover:underline">
          <DeliveryStatusBadge status={row.status} />
        </Link>
      ),
    },
    {
      key: 'current',
      header: 'This window',
      align: 'right',
      render: (row) => <span className="text-xs tabular text-ink">{formatCount(row.current)}</span>,
    },
    {
      key: 'previous',
      header: 'Previous',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-xs tabular text-ink-muted">{formatCount(row.previous)}</span>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink-muted">
          {formatCountDelta(row.current - row.previous)}
        </span>
      ),
    },
    {
      key: 'share',
      header: 'Share',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink-muted">
          {formatPercent(share(row.current, total), 1)}
        </span>
      ),
    },
  ];
}

/**
 * A single stacked proportion bar. Decorative on purpose: `aria-hidden`, with
 * the counts it draws in the table beside it, and a visually hidden sentence
 * saying what the bar is a share of. Colour is never the only carrier — the
 * table row has the status name.
 */
function ProportionBar({
  label,
  segments,
}: {
  label: string;
  segments: { key: string; share: number; className: string }[];
}) {
  return (
    <div>
      <p className="sr-only">{label}</p>
      <div
        aria-hidden="true"
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-raised"
      >
        {segments
          .filter((segment) => segment.share > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className={cn('h-full', segment.className)}
              style={{ width: `${segment.share * 100}%` }}
            />
          ))}
      </div>
    </div>
  );
}

/* ── Failing endpoints ────────────────────────────────────────────────────── */

function rankingColumns(base: string): Column<FailingEndpoint>[] {
  return [
    {
      key: 'endpoint',
      header: 'Endpoint',
      render: (row) => (
        <Link
          to={`${base}/deliveries?endpoint_id=${encodeURIComponent(row.endpoint_id)}&failing_now=true`}
          className="flex flex-col hover:underline"
        >
          {/*
            Nullable on purpose: the ranking is the truth about what failed
            even when the endpoint row is gone, so the id is shown in its place
            rather than the row being dropped.
          */}
          <span className="text-xs font-medium text-ink">
            {row.name ?? <span className="text-ink-subtle">endpoint row missing</span>}
          </span>
          <span className="truncate font-mono text-2xs text-ink-subtle">
            {row.url ?? truncateId(row.endpoint_id)}
          </span>
        </Link>
      ),
    },
    {
      key: 'state',
      header: 'State now',
      secondary: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.status === null ? (
            <Badge tone="neutral">unknown</Badge>
          ) : (
            <Badge
              tone={row.status === 'active' ? 'ok' : row.status === 'paused' ? 'neutral' : 'danger'}
              dot
            >
              {row.status}
            </Badge>
          )}
          {/*
            `enabled` is operator intent and `status` the breaker's verdict.
            `false` with a failing count is an endpoint someone already turned
            off; `true` + `disabled` is one the platform did.
          */}
          {row.enabled === false && <Badge tone="neutral">paused by operator</Badge>}
          {row.enabled === true && row.status === 'disabled' && (
            <Badge tone="danger">auto-disabled</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'failing',
      header: 'Failing',
      align: 'right',
      render: (row) => (
        <span className="flex flex-col items-end">
          <span className="text-xs tabular text-danger">{formatCount(row.failing)}</span>
          <span className="text-2xs tabular text-ink-subtle">
            {formatCount(row.failed)} failed · {formatCount(row.exhausted)} exhausted
          </span>
        </span>
      ),
    },
    {
      key: 'retrying',
      header: 'Retrying',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-xs tabular text-warn">{formatCount(row.retrying)}</span>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (row) => <span className="text-xs tabular text-ink">{formatCount(row.total)}</span>,
    },
    {
      key: 'rate',
      header: 'Failure rate',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink">{formatPercent(row.failure_rate, 1)}</span>
      ),
    },
  ];
}

/* ── Latency ──────────────────────────────────────────────────────────────── */

function Latency({ data }: { data: AttemptLatency }) {
  const measured = data.sample_size > 0;
  const percentiles: { label: string; value: number | null }[] = [
    { label: 'p50', value: data.p50_ms },
    { label: 'p95', value: data.p95_ms },
    { label: 'p99', value: data.p99_ms },
    { label: 'Min', value: data.min_ms },
    { label: 'Max', value: data.max_ms },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {percentiles.map((item) => (
          <Stat
            key={item.label}
            label={item.label}
            value={formatNullableDuration(item.value, formatDuration)}
            hint={measured ? undefined : 'No measured attempts'}
          />
        ))}
      </div>

      {/*
        `exact` is the honest part of the response. An exact percentile over
        the whole window is not offered; when the window held more traffic
        than the sample cap, these numbers describe its MOST RECENT part.
      */}
      <div className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-raised/40 px-3 py-2.5">
        <Badge tone={data.exact ? 'ok' : 'warn'}>{data.exact ? 'exact' : 'sampled'}</Badge>
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-muted">
          {!measured
            ? data.exact
              ? 'No attempt in this window recorded a duration, and there was no traffic beyond what was checked — an exact answer about nothing.'
              : `No measured attempt among the ${formatCount(data.sampled_deliveries)} most recent deliveries; the window held more deliveries than were checked.`
            : data.exact
              ? `Computed from every measured attempt in the window: ${formatCount(data.sample_size)} attempts across ${formatCount(data.sampled_deliveries)} deliveries.`
              : `A sample, not the whole window: the most recent ${formatCount(data.sample_size)} measured attempts, drawn from the ${formatCount(data.sampled_deliveries)} most recent deliveries. The window held more traffic than the sample cap, so these numbers describe its most recent part.`}
        </p>
      </div>

      <WindowCaption window={data.window} />
    </div>
  );
}

/* ── Event volume ─────────────────────────────────────────────────────────── */

function Events({
  data,
  deliveriesTotal,
  deliveriesPending,
  previousLabel,
  base,
}: {
  data: EventVolume;
  deliveriesTotal: number | undefined;
  deliveriesPending: boolean;
  previousLabel: string;
  base: string;
}) {
  const ratio = fanOutRatio(deliveriesTotal, data.total);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Events published"
          value={formatCount(data.total)}
          hint={`${formatCountDelta(data.total_delta)} vs ${previousLabel} (${formatCount(data.previous_total)})`}
        />
        <Stat
          label="Previous window"
          value={formatCount(data.previous_total)}
          hint={`Events published in ${previousLabel}`}
        />
        {/*
          The one number here from two responses: deliveries created (from the
          outcomes route) over events published (this one). Shown only when
          both are in hand and there were events; otherwise it says why.
        */}
        <Stat
          label="Fan-out"
          value={formatRatio(ratio)}
          hint={
            ratio !== null
              ? `${formatCount(deliveriesTotal ?? 0)} deliveries created ÷ ${formatCount(data.total)} events published`
              : data.total === 0
                ? 'No events to divide by'
                : deliveriesPending
                  ? 'Waiting for delivery outcomes'
                  : 'Delivery outcomes did not load'
          }
        />
      </div>

      <ProportionBar
        label={`Share of the ${formatCount(data.total)} events published in this window, by the ${data.by_type.length} busiest event types`}
        segments={data.by_type.map((row, index) => ({
          key: row.event_type,
          share: share(row.count, data.total),
          className: index % 2 === 0 ? 'bg-accent' : 'bg-accent/50',
        }))}
      />

      <div className="-mx-4 -mb-4 border-t border-line">
        <Table
          caption="Event types by count in this window, busiest first"
          columns={eventTypeColumns(data.total, base)}
          rows={data.by_type}
          rowKey={(row) => row.event_type}
        />
        <div className="flex flex-col gap-1 border-t border-line px-4 py-2.5">
          {data.has_more && (
            <p className="text-2xs text-ink-muted">
              More event types occurred than the {data.by_type.length} shown. These are the
              busiest; the shares below do not sum to 100%.
            </p>
          )}
          <WindowCaption window={data.window}>
            Share is each type’s count over the {formatCount(data.total)} events published in
            this window.
          </WindowCaption>
        </div>
      </div>
    </div>
  );
}

function eventTypeColumns(total: number, base: string): Column<EventVolume['by_type'][number]>[] {
  return [
    {
      key: 'type',
      header: 'Event type',
      render: (row) => (
        <Link
          to={`${base}/events?event_type=${encodeURIComponent(row.event_type)}`}
          className="font-mono text-xs text-ink hover:underline"
        >
          {row.event_type}
        </Link>
      ),
    },
    {
      key: 'count',
      header: 'Published',
      align: 'right',
      render: (row) => <span className="text-xs tabular text-ink">{formatCount(row.count)}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink-muted">
          {formatPercent(share(row.count, total), 1)}
        </span>
      ),
    },
  ];
}
