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
  Tabs,
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
import { useProject } from '../projects/api';
import {
  useAttemptLatency,
  useDeliveryOutcomes,
  useDeliverySeries,
  useEventVolume,
  useFailingEndpoints,
} from './api';
import {
  formatCountDelta,
  formatNullableDuration,
  formatRate,
  formatRateDelta,
  rateTone,
  share,
} from './derive';
import { WindowCaption } from './tiles';
import { OutcomeChart, OutcomeLegend } from './OutcomeChart';
import { ANCHOR_PARAM, anchorWasChosenForVisitor } from './UsageRedirect';
import { UsageTab } from './UsageTab';
import { WindowSelector, useAnalyticsWindow } from './WindowSelector';
import type { AnalyticsWindowChoice } from './window';

/**
 * Analytics — two questions about one window, behind one nav item.
 *
 * ## Why Usage is a tab here rather than a page of its own
 *
 * The two screens were asking the same routes the same question at different
 * scopes: "how is delivery going in this project" and "what has each project
 * consumed". Separately they each carried their own notion of the window —
 * Analytics a selector, Usage a hard-coded 720 hours — so the same figure
 * (deliveries per event) could be read off two screens and disagree. One page,
 * one selector in the header above the tabs, and every number on both tabs is
 * the same window.
 *
 * A tab rather than a sixth panel on one long scroll, for a reason that is not
 * layout: the Usage rows are TWO THROTTLED REQUESTS PER PROJECT, and this is
 * the page an operator reloads during an incident. Appending them to the
 * delivery panels would spend an organization's whole `analytics/events` budget
 * every time someone refreshed to see whether the failure rate moved. A tab
 * mounts its queries when someone asks for consumption. It also keeps the
 * 2am answer — the chart, the outcome tiles, the failing endpoints — above the
 * fold rather than pushing it under a billing-adjacent table.
 *
 * ## The Delivery tab
 *
 * Five questions, five routes, five panels that land independently. The chart
 * at the top is a real time series — `/analytics/deliveries/series` buckets the
 * window, and `series-layout.ts` turns it into bars. Everything below it
 * COMPARES rather than charts: each count is reported for the window and for
 * the immediately preceding window of equal length, with the delta, which
 * answers "is it getting worse?" in a number rather than asking someone to
 * eyeball a slope. The two are complements — the chart says WHEN, the deltas
 * say WHETHER.
 *
 * Every proportional bar beside a table is a share of counts the response
 * actually carries, never a bucket this page invented, and the table is the
 * accessible equal of every bar.
 *
 * Both the window and the tab are in the URL (`?window=1h|24h|7d|30d&tab=usage`)
 * so a link pasted into an incident channel opens on the same period and the
 * same half of the page.
 */
const ANALYTICS_TABS = [
  { value: 'delivery', label: 'Delivery' },
  { value: 'usage', label: 'Usage' },
] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number]['value'];

export const DEFAULT_ANALYTICS_TAB: AnalyticsTab = 'delivery';

/**
 * `?tab=` → a tab. Anything unrecognised is the delivery panels rather than an
 * error: the parameter is a view preference, and a stale link should open the
 * page on its primary half, not break it.
 */
export function readAnalyticsTab(raw: string | null | undefined): AnalyticsTab {
  return ANALYTICS_TABS.some((tab) => tab.value === raw)
    ? (raw as AnalyticsTab)
    : DEFAULT_ANALYTICS_TAB;
}

export function AnalyticsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { key: windowKey, window, setKey: setWindow } = useAnalyticsWindow();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readAnalyticsTab(searchParams.get('tab'));
  const anchoredForVisitor = anchorWasChosenForVisitor(searchParams.get(ANCHOR_PARAM));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Analytics"
        description={`How delivery is going over the ${window.label.toLowerCase()}, beside ${window.previous} — and what each project consumed over the same window. One window governs both tabs.`}
        actions={<WindowSelector value={windowKey} onChange={setWindow} />}
      />

      {anchoredForVisitor && <AnchorNotice orgId={orgId} projectId={projectId} />}

      <Tabs
        aria-label="Analytics view"
        items={[...ANALYTICS_TABS]}
        value={tab}
        onChange={(value) =>
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (value === DEFAULT_ANALYTICS_TAB) next.delete('tab');
              else next.set('tab', value);
              return next;
            },
            { replace: true },
          )
        }
      >
        {tab === 'delivery' ? (
          <DeliveryTab orgId={orgId} projectId={projectId} window={window} />
        ) : (
          <UsageTab
            orgId={orgId}
            projectId={projectId}
            windowKey={windowKey}
            window={window}
          />
        )}
      </Tabs>
    </div>
  );
}

/**
 * "You are not where you chose to be."
 *
 * `/orgs/:orgId/usage` has no project in it and this page does, so
 * `UsageRedirect` picks one — and the whole left rail is built from the
 * `:projectId` it picked. Being moved to another project's Deliveries, Events
 * and Endpoints without being told is the failure this notice exists to prevent;
 * it is rendered above the tabs rather than inside the Usage tab because it
 * describes the PAGE's anchor, which outlives the tab someone landed on.
 *
 * Only on `anchor=auto` — the flag the redirect sets when it, rather than the
 * visitor, chose. A visitor who came from the rail, a project-scoped link or
 * `/orgs/:orgId/usage?project=<id>` chose their own project and needs no notice.
 *
 * The name comes from the same `useProject` the shell already reads for the
 * project card, so it is a cache hit and not a sixth request. Before it lands
 * the notice still states the important half — that a project was chosen for
 * you — rather than waiting for a name to say anything at all.
 */
function AnchorNotice({ orgId, projectId }: { orgId: string; projectId: string }) {
  const project = useProject(orgId, projectId);
  const name = project.data?.name;

  return (
    <div
      role="status"
      className="rounded-[0.625rem] border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-warn"
    >
      <strong className="font-semibold">
        {name ? `This page is anchored to ${name}.` : 'A project was chosen for this page.'}
      </strong>{' '}
      You followed{' '}
      <code className="rounded border border-warn/30 px-1 py-0.5 font-mono text-2xs">
        /orgs/{orgId}/usage
      </code>
      , which names no project, so the organization’s first one was used. The Usage table below is
      organization-wide and reads the same whichever project that is — but the Delivery tab, the
      project card and every project-scoped item in the navigation now describe{' '}
      {name ?? 'that project'}. Switch project from the card at the top of the navigation if it is
      not the one you were working in.
    </div>
  );
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

function DeliveryTab({
  orgId,
  projectId,
  window,
}: {
  orgId: string;
  projectId: string;
  window: AnalyticsWindowChoice;
}) {
  const base = `/orgs/${orgId}/projects/${projectId}`;

  const series = useDeliverySeries(projectId, window.hours, window.bucket);
  const outcomes = useDeliveryOutcomes(projectId, window.hours);
  const ranking = useFailingEndpoints(projectId, window.hours, DEFAULT_ANALYTICS_LIMIT);
  const latency = useAttemptLatency(projectId, window.hours);
  const events = useEventVolume(projectId, window.hours, DEFAULT_ANALYTICS_LIMIT);

  return (
    <div className="flex flex-col gap-4 pt-4">
      <Panel
        title="Delivery over time"
        description={`Deliveries created in each bucket of the ${window.label.toLowerCase()}, and how they turned out.`}
        actions={<OutcomeLegend />}
      >
        <Async
          query={series}
          isEmpty={(data) => data.buckets.every((row) => row.delivered_first_try + row.delivered_after_retry + row.failed + row.in_flight === 0)}
          empty={
            <EmptyState
              title={`Nothing was delivered in the ${window.label.toLowerCase()}`}
              description="A delivery exists once a published event matches a subscription. An empty chart here means no event matched one, not that something failed."
            />
          }
        >
          {(data) => <OutcomeChart series={data} height={200} />}
        </Async>
      </Panel>

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
        description={`Events published in the ${window.label.toLowerCase()} — not deliveries. One event routes to one delivery per matching subscription, so the two totals differ. The ratio between them is a column on the Usage tab, project by project across the organization.`}
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
          {(data) => <Events data={data} previousLabel={window.previous} base={base} />}
        </Async>
      </Panel>
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
  previousLabel,
  base,
}: {
  data: EventVolume;
  previousLabel: string;
  base: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/*
        Deliveries per event used to be a third tile here, divided out of the
        outcomes response beside this one. It is on the Usage tab now, where it
        is computed for every project the tab lists and for their total — the
        same division, in the one place it can be compared. Two screens carrying
        the same ratio was how they could disagree.

        The caveat, which the panel copy above no longer talks past: the Usage
        tab lists the FIRST PAGE of projects, so on an organization with more
        than a page of them the project you are looking at may not have a row
        there. The tab says so when that happens, and the two totals it would
        divide are both on this tab.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
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
