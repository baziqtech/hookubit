import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  Panel,
  Stat,
  Table,
  type Column,
} from '../../components';
import { formatCount, formatDuration, formatPercent, formatRelativeTime, truncateId } from '../../lib/format';
import { describeDelivery } from '../../lib/delivery-status';
import type { Delivery, Endpoint } from '../../types/api';
import { useDeliveries } from '../deliveries/api';
import { useEndpoints } from '../endpoints/api';
import { useAnalytics } from '../projects/api';

/**
 * The 2am page. It answers, in order: is delivery healthy, which endpoint is
 * hurting, and what failed most recently — so the next click is obvious.
 */
export function OverviewPage() {
  const { orgId = '', projectId = '' } = useParams();
  const analytics = useAnalytics(projectId);
  const endpoints = useEndpoints(projectId);
  const failing = useDeliveries(projectId, { status: 'exhausted' });

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-base font-semibold tracking-tight">Overview</h1>

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
        <Panel
          title="Endpoint health"
          description="Ordered by 24-hour success rate"
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
          <Async
            query={endpoints}
            isEmpty={(data) => data.length === 0}
            empty={<EmptyState title="No endpoints" description="Add one to start delivering." />}
          >
            {(data) => (
              <Table
                caption="Endpoint health"
                columns={endpointColumns}
                rows={[...data].sort((a, b) => a.success_rate_24h - b.success_rate_24h)}
                rowKey={(row) => row.id}
              />
            )}
          </Async>
        </Panel>

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
    </div>
  );
}

const endpointColumns: Column<Endpoint>[] = [
  {
    key: 'name',
    header: 'Endpoint',
    render: (row) => (
      <span className="flex flex-col">
        <span className="font-medium text-ink">{row.name}</span>
        <span className="truncate font-mono text-2xs text-ink-subtle">{row.url}</span>
      </span>
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
        {row.circuit_state !== 'closed' && (
          <Badge tone={row.circuit_state === 'open' ? 'danger' : 'warn'}>
            breaker {row.circuit_state.replace('_', ' ')}
          </Badge>
        )}
      </span>
    ),
  },
  {
    key: 'success',
    header: '24h',
    align: 'right',
    render: (row) => (
      <span
        className={
          row.success_rate_24h < 0.9 ? 'text-danger' : row.success_rate_24h < 0.99 ? 'text-warn' : ''
        }
      >
        {formatPercent(row.success_rate_24h, 2)}
      </span>
    ),
  },
];

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
