import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Panel,
  Stat,
  Table,
  type Column,
} from '../../components';
import { formatCount, formatDuration, formatPercent, formatRelativeTime, truncateId } from '../../lib/format';
import { deliveryOutcome, describeDelivery } from '../../lib/delivery-status';
import type { Delivery, Endpoint, FailingEndpoint } from '../../types/api';

import {
  useAttemptLatency,
  useDeliveryOutcomes,
  useDeliverySeries,
  useFailingEndpoints,
} from '../analytics/api';
import { OutcomeChart, OutcomeLegend } from '../analytics/OutcomeChart';
import { OutcomeSplit } from '../analytics/OutcomeSplit';
import { WindowSelector, useAnalyticsWindow } from '../analytics/WindowSelector';
import { formatNullableDuration, formatRate, formatRateDelta, rateTone } from '../analytics/derive';
import { ErrorTile, TileSkeletons } from '../analytics/tiles';
import { useDeliveries } from '../deliveries/api';
import { useEndpoints } from '../endpoints/api';
import { StuckEventsNotice } from '../outbox/StuckEventsNotice';
import { useOutboxEntries } from '../outbox/api';
import { stuckEventsState } from '../outbox/stuck-summary';
import { useSetupAffordance } from '../onboarding/api';
import { setupHeadline } from '../onboarding/setup';
import { resolveOverviewSurface } from '../onboarding/setup-visibility';
import { SetupChecklist } from '../onboarding/SetupChecklist';
import type { SetupStep } from '../onboarding/setup';
import type { AnalyticsWindowChoice } from '../analytics/window';

/**
 * The 2am page — once there is something to be at 2am about.
 *
 * Before that it is the first-run page, and the two are genuinely different
 * screens. A project with no endpoints does not need a success-rate tile
 * reading 0.00%: that is a number dressed up as a diagnosis, and it points at
 * nothing. So while setup is incomplete the overview IS the guided path, and it
 * only becomes the health dashboard once a webhook can actually flow.
 *
 * ## Which of the two, and the third answer
 *
 * `resolveOverviewSurface` decides, from the same three-valued affordance the
 * rail reads. This page used to ask `isPending || isError || isComplete`
 * directly, which made it the one affordance the visibility rule did not
 * govern — and a cold load of a 0/6 project therefore rendered the whole health
 * block, skeletons, charts and analytics requests included, before swapping it
 * for the checklist. `waiting` renders NEITHER branch instead, which is the same
 * nothing the rail shows for the same beat.
 *
 * The cost is paid on the first overview of a project in a session: the
 * analytics requests start once the setup check has resolved rather than beside
 * it. Afterwards the session remembers the answer, so every later visit mounts
 * the health page immediately.
 *
 * AN ERRORED CHECK IS DELIBERATELY DIFFERENT HERE. The rail shows its Setup item
 * when a check fails; this page stays on health, per design frame `07b Overview —
 * could not check`. Replacing an operator's instruments with onboarding copy
 * because one list request failed is the worse error on this surface, and the
 * reasoning is with the rule, in `resolveOverviewSurface`.
 */
export function OverviewPage() {
  const { orgId = '', projectId = '' } = useParams();
  const { affordance, setup } = useSetupAffordance(orgId, projectId);
  const { key: windowKey, window, setKey: setWindow } = useAnalyticsWindow();

  const surface = resolveOverviewSurface(affordance, setup.isError);
  const ready = surface === 'health';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description={
          surface === 'waiting'
            ? undefined
            : ready
              ? 'Delivery health for this project.'
              : 'This project cannot deliver a webhook yet. Here is what is left.'
        }
        actions={
          // Nothing is offered while the check is unresolved: a window selector
          // implies the health page and a setup button implies the checklist, and
          // either would be the claim this page is waiting not to make.
          surface === 'waiting' ? undefined : ready ? (
            <WindowSelector value={windowKey} onChange={setWindow} />
          ) : (
            // While setup is incomplete there is nothing to window: every
            // period would read the same empty. The one control that helps is
            // the one that finishes the setup.
            <Link to={`/orgs/${orgId}/projects/${projectId}/get-started`}>
              <Button variant="primary" size="sm">
                Open setup checklist
              </Button>
            </Link>
          )
        }
      />

      {surface === 'checklist' && (
        <FirstRun orgId={orgId} projectId={projectId} steps={setup.steps} />
      )}

      {surface === 'health' && <Health orgId={orgId} projectId={projectId} window={window} />}
    </div>
  );
}

/**
 * The checklist, inline, on the page someone actually lands on.
 *
 * Making them navigate to a separate "get started" page first would be one more
 * thing to discover, and the whole problem being solved here is that a new user
 * has nothing to discover it from.
 */
function FirstRun({
  orgId,
  projectId,
  steps,
}: {
  orgId: string;
  projectId: string;
  steps: SetupStep[];
}) {
  const base = `/orgs/${orgId}/projects/${projectId}`;
  const hrefFor = (step: SetupStep): string | null => {
    // A step this role cannot read is not a link: the page behind it answers 403.
    if (step.state === 'unavailable') return null;
    switch (step.id) {
      case 'api-key':
        return `${base}/api-keys`;
      case 'endpoint':
        return `${base}/endpoints`;
      case 'subscription':
        return `${base}/subscriptions`;
      case 'event':
        return `${base}/get-started`;
      default:
        return null;
    }
  };

  return (
    <Panel title="Setup" description={setupHeadline(steps)}>
      <div className="flex flex-col gap-4">
        <SetupChecklist steps={steps} hrefFor={hrefFor} />
        <p className="text-xs text-ink-muted">
          The{' '}
          <Link to={`${base}/get-started`} className="text-accent hover:underline">
            Get started page
          </Link>{' '}
          explains how events, deliveries and attempts relate, and carries the exact request to
          publish your first event.
        </p>
      </div>
    </Panel>
  );
}

/**
 * The health tiles read TWO of the four analytics routes, each as its own
 * request: `analytics/deliveries` for the outcome tiles and
 * `analytics/latency` for p95. They render as they land — the controller
 * split them precisely so the cheapest tile never waits for the dearest query
 * — and each fails alone, with its own request id, rather than blanking the
 * row. The window is whichever the page header selects; Analytics is where the
 * window is a choice.
 */
function Health({
  orgId,
  projectId,
  window,
}: {
  orgId: string;
  projectId: string;
  window: AnalyticsWindowChoice;
}) {
  const outcomes = useDeliveryOutcomes(projectId, window.hours);
  const series = useDeliverySeries(projectId, window.hours, window.bucket);
  const latency = useAttemptLatency(projectId, window.hours);
  const ranking = useFailingEndpoints(projectId, window.hours, 5);
  const endpoints = useEndpoints(projectId);
  const failing = useDeliveries(projectId, { status: 'exhausted' });
  const base = `/orgs/${orgId}/projects/${projectId}`;

  // Already fetched by `StuckEventsNotice` under the same key, so this is a
  // cache read rather than a second request.
  const parked = useOutboxEntries(projectId, { status: 'failed' }, 0);
  const stuck = stuckEventsState(parked.data, parked.isError);
  const stuckCount = stuck.kind === 'stuck' ? stuck.count : 0;

  return (
    <>
      {/*
        A health screen built only from delivery outcomes reports a project as
        healthy while events silently go nowhere: a stuck event produces no
        delivery rows, so it is in none of the numbers below it.
      */}
      <StuckEventsNotice orgId={orgId} projectId={projectId} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {outcomes.isPending ? (
          <TileSkeletons
            labels={[
              `Success rate (${window.key})`,
              `Failing (${window.key})`,
              `Exhausted (${window.key})`,
              'In flight',
            ]}
          />
        ) : outcomes.isError ? (
          <ErrorTile
            label={`Delivery outcomes (${window.key})`}
            error={outcomes.error}
            onRetry={() => void outcomes.refetch()}
            className="sm:col-span-2 xl:col-span-4"
          />
        ) : (
          <>
            {/*
              `success_rate` is NULL when nothing settled — not 0%, which would
              read as "everything failed" on a project that simply had no
              traffic. The delta is null when either window had nothing
              settled, because a change from "unknown" is not a change.
            */}
            <Stat
              label={`Success rate (${window.key})`}
              value={formatRate(outcomes.data.current.success_rate)}
              tone={rateTone(outcomes.data.current.success_rate)}
              hint={
                outcomes.data.current.success_rate === null
                  ? `No delivery settled in the ${window.label.toLowerCase()}`
                  : `${formatRateDelta(outcomes.data.success_rate_delta)} vs ${window.previous} · ${formatCount(outcomes.data.current.total)} deliveries created`
              }
            />
            <Stat
              label={`Failing (${window.key})`}
              value={formatCount(outcomes.data.current.failing)}
              tone={outcomes.data.current.failing > 0 ? 'danger' : 'default'}
              hint={`${formatCount(outcomes.data.current.by_status.failed)} failed with retries left · ${formatCount(outcomes.data.current.exhausted)} exhausted`}
            />
            <Stat
              label={`Exhausted (${window.key})`}
              value={formatCount(outcomes.data.current.exhausted)}
              tone={outcomes.data.current.exhausted > 0 ? 'danger' : 'default'}
              hint="Gave up; will not retry without a replay"
            />
            <Stat
              label="In flight"
              value={formatCount(outcomes.data.current.in_flight)}
              tone={outcomes.data.current.in_flight > 0 ? 'warn' : 'default'}
              hint={`${formatCount(outcomes.data.current.by_status.retrying)} retrying · not yet an outcome`}
            />
          </>
        )}

        {latency.isPending ? (
          <TileSkeletons labels={[`p95 latency (${window.key})`]} />
        ) : latency.isError ? (
          <ErrorTile
            label={`p95 latency (${window.key})`}
            error={latency.error}
            onRetry={() => void latency.refetch()}
          />
        ) : (
          <Stat
            label={`p95 latency (${window.key})`}
            value={formatNullableDuration(latency.data.p95_ms, formatDuration)}
            hint={latencyCaveat(latency.data)}
          />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr,1fr]">
        <Panel
          title="Delivery outcomes"
          description={`Deliveries created in each bucket of the ${window.label.toLowerCase()}, and how they turned out.`}
          actions={<OutcomeLegend />}
        >
          <Async query={series}>{(data) => <OutcomeChart series={data} />}</Async>
        </Panel>

        {/*
          The same numbers as the chart, totalled, plus the one thing neither
          the chart nor the success rate can see: events that never became
          deliveries at all. A rate computed from deliveries is blind to them
          by construction, so the panel that reports the rate is the right
          place to say so.
        */}
        <Panel title="Outcome split" description={window.label}>
          <Async query={series}>
            {(data) => (
              <OutcomeSplit
                series={data}
                stuckCount={stuckCount}
                stuckHref={`${base}/outbox`}
              />
            )}
          </Async>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Async
          query={endpoints}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <Panel title="Endpoints">
              <EmptyState
                title="No endpoints"
                description="An endpoint is the URL we POST to. Nothing is delivered until one exists."
                action={
                  <Link to={`${base}/endpoints`}>
                    <Button size="sm" variant="primary">
                      Add an endpoint
                    </Button>
                  </Link>
                }
              />
            </Panel>
          }
        >
          {(page) => {
            const needsAttention = page.rows.filter((row) => attention(row) < 2);
            const healthy = page.rows.length - needsAttention.length;

            return (
              <Panel
                title="Endpoints needing attention"
                description={
                  needsAttention.length === 0
                    ? `All ${healthy} endpoints are delivering.`
                    : `${needsAttention.length} of ${page.rows.length} are not delivering.`
                }
                flush
                actions={
                  <Link to={`${base}/endpoints`} className="text-xs text-ink-muted hover:text-ink">
                    All endpoints
                  </Link>
                }
              >
                {/*
                  Only the endpoints an operator has to act on. The previous
                  version listed every endpoint in the project, so fifty-odd
                  healthy merchant callbacks buried the one with an open circuit
                  breaker — the exact row the panel exists to surface.
                */}
                {needsAttention.length === 0 ? (
                  <EmptyState
                    title="Every endpoint is delivering"
                    description="Nothing here is paused, disabled by the circuit breaker, or waiting on a signing secret."
                  />
                ) : (
                  <Table
                    caption="Endpoints needing attention"
                    columns={endpointColumns(orgId, projectId)}
                    rows={[...needsAttention].sort((a, b) => attention(a) - attention(b))}
                    rowKey={(row) => row.id}
                  />
                )}
              </Panel>
            );
          }}
        </Async>

        {/*
          The panel above is about STATE — what the breaker or an operator has
          stopped. This one is about OUTCOMES — which endpoints the deliveries
          of the selected window actually failed against, from the ranking route
          that exists for exactly this question. An endpoint can be on both
          (auto-disabled because it was failing) or on either alone.
        */}
        <Panel
          title={`Failing endpoints (${window.key})`}
          description="Worst first by failed + exhausted. Read the rate beside the count."
          flush
          actions={
            <Link to={`${base}/analytics`} className="text-xs text-ink-muted hover:text-ink">
              Analytics
            </Link>
          }
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
                {data.has_more && (
                  <p className="border-t border-line px-3 py-2 text-2xs text-ink-subtle">
                    More endpoints had failures than the {data.data.length} shown; these are the
                    worst.
                  </p>
                )}
              </>
            )}
          </Async>
        </Panel>

        <Panel
          title="Needs attention"
          description="Deliveries that exhausted every retry"
          flush
          className="xl:col-span-2"
          actions={
            <Link
              to={`${base}/deliveries?status=exhausted`}
              className="text-xs text-ink-muted hover:text-ink"
            >
              All failures
            </Link>
          }
        >
          <Async
            query={failing}
            isEmpty={(page) => page.rows.length === 0}
            empty={
              <EmptyState
                title="Nothing exhausted"
                description="Every delivery in the window either succeeded or is still retrying."
              />
            }
          >
            {(page) => (
              <Table
                caption="Exhausted deliveries"
                columns={failureColumns(orgId, projectId)}
                rows={page.rows.slice(0, 8)}
                rowKey={(row) => row.id}
              />
            )}
          </Async>
        </Panel>
      </div>
    </>
  );
}

/**
 * The p95 is a nearest-rank percentile over a BOUNDED sample, and the tile
 * says which: `exact` means the sample was every measured attempt in the
 * window; otherwise it is the most recent `sample_size`, and the number
 * describes recent traffic rather than the whole day.
 */
function latencyCaveat(data: {
  exact: boolean;
  sample_size: number;
  sampled_deliveries: number;
}): string {
  if (data.sample_size === 0) return 'No measured attempts in this window';
  const scope = `${formatCount(data.sample_size)} attempts across ${formatCount(data.sampled_deliveries)} deliveries`;
  return data.exact ? `Exact over ${scope}` : `Most recent ${scope} — a sample, not the whole day`;
}

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
      key: 'failing',
      header: 'Failing',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-danger">{formatCount(row.failing)}</span>
      ),
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (row) => (
        <span className="flex flex-col items-end">
          <span className="text-xs tabular text-ink">{formatPercent(row.failure_rate, 1)}</span>
          <span className="text-2xs tabular text-ink-subtle">of {formatCount(row.total)}</span>
        </span>
      ),
    },
  ];
}

function endpointColumns(orgId: string, projectId: string): Column<Endpoint>[] {
  return [
    {
      key: 'name',
      header: 'Endpoint',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/endpoints`}
          className="flex flex-col hover:underline"
        >
          <span className="text-xs font-medium text-ink">{row.name}</span>
          <span className="truncate font-mono text-2xs text-ink-subtle">{row.url}</span>
        </Link>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge
            tone={row.status === 'active' ? 'ok' : row.status === 'paused' ? 'neutral' : 'danger'}
            dot
          >
            {row.status}
          </Badge>
          {/*
            `enabled` is operator intent and `status` is the breaker's verdict.
            Both true-ish at once means nobody chose this — the platform did.
          */}
          {row.enabled && row.status === 'disabled' && <Badge tone="danger">auto-disabled</Badge>}
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Why',
      render: (row) => (
        <span className="block max-w-[22rem] text-2xs leading-relaxed text-ink-subtle">
          {row.disabled_reason ?? '—'}
        </span>
      ),
    },
  ];
}

/** Sort weight: the endpoints an operator has to act on come first. */
function attention(endpoint: Endpoint): number {
  if (endpoint.status === 'disabled') return 0;
  if (endpoint.status === 'paused') return 1;
  return 2;
}

function failureColumns(orgId: string, projectId: string): Column<Delivery>[] {
  return [
    {
      key: 'delivery',
      header: 'Delivery',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/deliveries/${row.id}`}
          className="flex flex-col hover:underline"
        >
          <span className="font-mono text-xs text-ink">{truncateId(row.id)}</span>
          {/*
            A delivery row carries IDS, not names: there is no `event_type` and
            no `endpoint_name` on `DeliveryDto`. The ids are shown rather than a
            name this row cannot supply — the detail page has both.
          */}
          <span className="font-mono text-2xs text-ink-subtle">
            {truncateId(row.event_id)} → {truncateId(row.endpoint_id)}
          </span>
        </Link>
      ),
    },
    {
      key: 'why',
      header: 'Outcome',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{describeDelivery(deliveryOutcome(row))}</span>
      ),
    },
    {
      key: 'when',
      header: 'Age',
      align: 'right',
      render: (row) => (
        <span className="text-xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
  ];
}
