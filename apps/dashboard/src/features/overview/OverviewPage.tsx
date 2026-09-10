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
import { DEFAULT_WINDOW_HOURS } from '../../types/api';
import { useAttemptLatency, useDeliveryOutcomes, useFailingEndpoints } from '../analytics/api';
import { formatNullableDuration, formatRate, formatRateDelta, rateTone } from '../analytics/derive';
import { ErrorTile, TileSkeletons } from '../analytics/tiles';
import { useDeliveries } from '../deliveries/api';
import { useEndpoints } from '../endpoints/api';
import { useSetupState } from '../onboarding/api';
import { isSetupComplete, setupHeadline } from '../onboarding/setup';
import { SetupChecklist } from '../onboarding/SetupChecklist';
import type { SetupStep } from '../onboarding/setup';

/**
 * The 2am page — once there is something to be at 2am about.
 *
 * Before that it is the first-run page, and the two are genuinely different
 * screens. A project with no endpoints does not need a success-rate tile
 * reading 0.00%: that is a number dressed up as a diagnosis, and it points at
 * nothing. So while setup is incomplete the overview IS the guided path, and it
 * only becomes the health dashboard once a webhook can actually flow.
 */
export function OverviewPage() {
  const { orgId = '', projectId = '' } = useParams();
  const setup = useSetupState(orgId, projectId);

  const ready = setup.isPending || setup.isError || isSetupComplete(setup.steps);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description={
          ready
            ? 'Delivery health for this project.'
            : 'This project cannot deliver a webhook yet. Here is what is left.'
        }
        actions={
          !ready && (
            <Link to={`/orgs/${orgId}/projects/${projectId}/get-started`}>
              <Button variant="primary" size="sm">
                Open Get started
              </Button>
            </Link>
          )
        }
      />

      {!ready && <FirstRun orgId={orgId} projectId={projectId} steps={setup.steps} />}

      {ready && <Health orgId={orgId} projectId={projectId} />}
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
 * row. The window is the API default (24h); the Analytics page is where the
 * window is a choice.
 */
function Health({ orgId, projectId }: { orgId: string; projectId: string }) {
  const outcomes = useDeliveryOutcomes(projectId, DEFAULT_WINDOW_HOURS);
  const latency = useAttemptLatency(projectId, DEFAULT_WINDOW_HOURS);
  const ranking = useFailingEndpoints(projectId, DEFAULT_WINDOW_HOURS, 5);
  const endpoints = useEndpoints(projectId);
  const failing = useDeliveries(projectId, { status: 'exhausted' });
  const base = `/orgs/${orgId}/projects/${projectId}`;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {outcomes.isPending ? (
          <TileSkeletons
            labels={['Success rate (24h)', 'Failing (24h)', 'Exhausted (24h)', 'In flight']}
          />
        ) : outcomes.isError ? (
          <ErrorTile
            label="Delivery outcomes (24h)"
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
              label="Success rate (24h)"
              value={formatRate(outcomes.data.current.success_rate)}
              tone={rateTone(outcomes.data.current.success_rate)}
              hint={
                outcomes.data.current.success_rate === null
                  ? 'No delivery settled in the last 24 hours'
                  : `${formatRateDelta(outcomes.data.success_rate_delta)} vs the 24 hours before · ${formatCount(outcomes.data.current.total)} deliveries created`
              }
            />
            <Stat
              label="Failing (24h)"
              value={formatCount(outcomes.data.current.failing)}
              tone={outcomes.data.current.failing > 0 ? 'danger' : 'default'}
              hint={`${formatCount(outcomes.data.current.by_status.failed)} failed with retries left · ${formatCount(outcomes.data.current.exhausted)} exhausted`}
            />
            <Stat
              label="Exhausted (24h)"
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
          <TileSkeletons labels={['p95 latency (24h)']} />
        ) : latency.isError ? (
          <ErrorTile
            label="p95 latency (24h)"
            error={latency.error}
            onRetry={() => void latency.refetch()}
          />
        ) : (
          <Stat
            label="p95 latency (24h)"
            value={formatNullableDuration(latency.data.p95_ms, formatDuration)}
            hint={latencyCaveat(latency.data)}
          />
        )}
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
          of the last 24 hours actually failed against, from the ranking route
          that exists for exactly this question. An endpoint can be on both
          (auto-disabled because it was failing) or on either alone.
        */}
        <Panel
          title="Failing endpoints (24h)"
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
                description="No endpoint had a delivery end badly in the last 24 hours."
              />
            }
          >
            {(data) => (
              <>
                <Table
                  caption="Endpoints ranked by failing deliveries in the last 24 hours"
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
  if (data.sample_size === 0) return 'No measured attempts in the last 24 hours';
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
