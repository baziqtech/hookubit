import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  DeliveryStatusBadge,
  EmptyState,
  Input,
  PageHeader,
  Panel,
  Select,
  Table,
  type Column,
} from '../../components';
import { describeDelivery } from '../../lib/delivery-status';
import { formatRelativeTime, truncateId } from '../../lib/format';
import type { Delivery, DeliveryStatus } from '../../types/api';
import { useEndpoints } from '../endpoints/api';
import { useDeliveries } from './api';

const STATUSES: DeliveryStatus[] = [
  'pending',
  'scheduled',
  'queued',
  'processing',
  'succeeded',
  'failed',
  'retrying',
  'exhausted',
  'cancelled',
];

export function DeliveriesPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = {
    search: searchParams.get('search') ?? '',
    status: searchParams.get('status') ?? '',
    endpoint_id: searchParams.get('endpoint_id') ?? '',
  };
  const deliveries = useDeliveries(projectId, filters);
  const endpoints = useEndpoints(projectId);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Deliveries"
        description="One row per event per endpoint, each with its own retry chain."
      />

      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
          <Input
            aria-label="Search deliveries"
            placeholder="Search by delivery, event or endpoint…"
            value={filters.search}
            onChange={(event) => setFilter('search', event.target.value)}
            className="w-72"
          />
          <Select
            aria-label="Filter by status"
            placeholder="All statuses"
            value={filters.status}
            onChange={(event) => setFilter('status', event.target.value)}
            options={STATUSES.map((status) => ({ value: status, label: status }))}
            className="w-40"
          />
          <Select
            aria-label="Filter by endpoint"
            placeholder="All endpoints"
            value={filters.endpoint_id}
            onChange={(event) => setFilter('endpoint_id', event.target.value)}
            /*
             * One page of endpoints. A project past the page size would filter
             * against an incomplete list, so the option is added explicitly
             * rather than the list silently omitting it.
             */
            options={(endpoints.data?.rows ?? []).map((endpoint) => ({
              value: endpoint.id,
              label: endpoint.name,
            }))}
            className="w-48"
          />
        </div>

        <Async
          query={deliveries}
          isEmpty={(page) => page.data.length === 0}
          empty={
            <EmptyState
              title="No deliveries match"
              description="Try clearing a filter, or widen the status selection."
            />
          }
        >
          {(page) => (
            <Table
              caption="Deliveries"
              columns={deliveryColumns(orgId, projectId)}
              rows={page.data}
              rowKey={(row) => row.id}
            />
          )}
        </Async>
      </Panel>
    </div>
  );
}

function deliveryColumns(orgId: string, projectId: string): Column<Delivery>[] {
  return [
    {
      key: 'id',
      header: 'Delivery',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/deliveries/${row.id}`}
          className="flex flex-col hover:underline"
        >
          <span className="font-mono text-xs text-ink">{truncateId(row.id)}</span>
          <span className="text-2xs text-ink-subtle">{row.event_type}</span>
        </Link>
      ),
    },
    {
      key: 'endpoint',
      header: 'Endpoint',
      render: (row) => <span className="text-xs text-ink">{row.endpoint_name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <DeliveryStatusBadge status={row.status} />,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{describeDelivery(row)}</span>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      render: (row) => (
        <span className="text-xs text-ink-subtle">
          {row.attempt_count}/{row.max_attempts}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      render: (row) => (
        <span className="text-xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
  ];
}
