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
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  truncateId,
} from '../../lib/format';
import { describeDelivery } from '../../lib/delivery-status';
import type { Delivery, Endpoint } from '../../types/api';
import { useDeliveries } from '../deliveries/api';
import { useEndpoints } from '../endpoints/api';
import { useSetupState } from '../onboarding/api';
import { isSetupComplete, setupHeadline } from '../onboarding/setup';
import { SetupChecklist } from '../onboarding/SetupChecklist';
import type { SetupStep } from '../onboarding/setup';
import { useAnalytics } from '../projects/api';

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

function Health({ orgId, projectId }: { orgId: string; projectId: string }) {
  const analytics = useAnalytics(projectId);
  const endpoints = useEndpoints(projectId);
  const failing = useDeliveries(projectId, { status: 'exhausted' });

  return (
    <>
      <Async query={analytics}>
        {(data) => (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Success rate (24h)"
              value={formatPercent(data.success_rate, 2)}
              tone={data.success_rate < 0.99 ? 'warn' : 'ok'}
              hint={`${formatCount(data.totals.total)} deliveries attempted`}
            />
            <Stat
              label="Failed (24h)"
              value={formatCount(data.totals.failed)}
              tone={data.totals.failed > 0 ? 'danger' : 'default'}
              hint={`${formatCount(data.totals.exhausted)} exhausted their retries`}
            />
            <Stat
              label="In retry"
              value={formatCount(data.totals.pending)}
              tone={data.totals.pending > 0 ? 'warn' : 'default'}
              hint="Scheduled for another attempt"
            />
            <Stat
              label="p95 latency"
              value={formatDuration(data.p95_latency_ms)}
              hint="Endpoint response time"
            />
          </div>
        )}
      </Async>

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
                  <Link to={`/orgs/${orgId}/projects/${projectId}/endpoints`}>
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
                  <Link
                    to={`/orgs/${orgId}/projects/${projectId}/endpoints`}
                    className="text-xs text-ink-muted hover:text-ink"
                  >
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

        <Panel
          title="Needs attention"
          description="Deliveries that exhausted every retry"
          flush
          actions={
            <Link
              to={`/orgs/${orgId}/projects/${projectId}/deliveries?status=exhausted`}
              className="text-xs text-ink-muted hover:text-ink"
            >
              All failures
            </Link>
          }
        >
          <Async
            query={failing}
            isEmpty={(page) => page.data.length === 0}
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
                rows={page.data.slice(0, 8)}
                rowKey={(row) => row.id}
              />
            )}
          </Async>
        </Panel>
      </div>
    </>
  );
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
          <span className="text-2xs text-ink-subtle">
            {row.event_type} → {row.endpoint_name}
          </span>
        </Link>
      ),
    },
    {
      key: 'why',
      header: 'Outcome',
      secondary: true,
      render: (row) => <span className="text-xs text-ink-muted">{describeDelivery(row)}</span>,
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
