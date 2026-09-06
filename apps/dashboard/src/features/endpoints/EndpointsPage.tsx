import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { formatDuration, formatPercent, formatRelativeTime } from '../../lib/format';
import type { Endpoint } from '../../types/api';
import { useEndpoints } from './api';

export function EndpointsPage() {
  const { projectId = '' } = useParams();
  const endpoints = useEndpoints(projectId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Endpoints"
        description="Each endpoint has its own concurrency, rate limit and circuit breaker — a slow one cannot starve the others."
        actions={<Button variant="primary">Add endpoint</Button>}
      />

      <Panel flush>
        <Async
          query={endpoints}
          isEmpty={(rows) => rows.length === 0}
          empty={
            <EmptyState
              title="No endpoints"
              description="An endpoint is a URL the platform delivers to. Add one, then subscribe it to event types."
              action={<Button variant="primary">Add endpoint</Button>}
            />
          }
        >
          {(rows) => (
            <Table caption="Endpoints" columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
        </Async>
      </Panel>
    </div>
  );
}

const columns: Column<Endpoint>[] = [
  {
    key: 'name',
    header: 'Endpoint',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name}</span>
        <span className="font-mono text-2xs text-ink-subtle">{row.url}</span>
        {row.disabled_reason && (
          <span className="mt-0.5 text-2xs text-danger">{row.disabled_reason}</span>
        )}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span className="flex flex-wrap gap-1">
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
    key: 'limits',
    header: 'Limits',
    secondary: true,
    render: (row) => (
      <span className="text-2xs text-ink-muted">
        {row.rate_limit_per_second ? `${row.rate_limit_per_second}/s` : 'unlimited'} ·{' '}
        {formatDuration(row.timeout_ms)} timeout
      </span>
    ),
  },
  {
    key: 'health',
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
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    secondary: true,
    render: (row) => (
      <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
    ),
  },
];
