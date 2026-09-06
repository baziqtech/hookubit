import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  EventStatusBadge,
  Input,
  PageHeader,
  Panel,
  Select,
  Table,
  type Column,
} from '../../components';
import { formatBytes, formatRelativeTime, truncateId } from '../../lib/format';
import type { WebhookEvent } from '../../types/api';
import { useEvents } from './api';

const EVENT_TYPES = [
  'payment.settled',
  'payment.failed',
  'payment.refunded',
  'payout.completed',
  'order.created',
];

/**
 * Filter state lives in the URL, not in component state: an operator's next
 * move after finding a bad window is to paste the link into an incident
 * channel, and that only works if the filters travel with it.
 */
export function EventsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = {
    search: searchParams.get('search') ?? '',
    event_type: searchParams.get('event_type') ?? '',
    status: searchParams.get('status') ?? '',
  };
  const events = useEvents(projectId, filters);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Events"
        description="Everything published to this project. One event fans out to one delivery per matching subscription."
      />

      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
          <Input
            aria-label="Search events"
            placeholder="Search by event ID or type…"
            value={filters.search}
            onChange={(event) => setFilter('search', event.target.value)}
            className="w-64"
          />
          <Select
            aria-label="Filter by event type"
            placeholder="All event types"
            value={filters.event_type}
            onChange={(event) => setFilter('event_type', event.target.value)}
            options={EVENT_TYPES.map((type) => ({ value: type, label: type }))}
            className="w-48"
          />
          <Select
            aria-label="Filter by status"
            placeholder="All statuses"
            value={filters.status}
            onChange={(event) => setFilter('status', event.target.value)}
            options={[
              { value: 'received', label: 'Received' },
              { value: 'processing', label: 'Processing' },
              { value: 'processed', label: 'Processed' },
              { value: 'failed', label: 'Failed' },
            ]}
            className="w-40"
          />
        </div>

        <Async
          query={events}
          isEmpty={(page) => page.data.length === 0}
          empty={
            <EmptyState
              title="No events match"
              description="Nothing in this project matches the current filters."
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Events"
                columns={eventColumns(orgId, projectId)}
                rows={page.data}
                rowKey={(row) => row.id}
              />
              {page.has_more && (
                <p className="border-t border-line px-3 py-2 text-2xs text-ink-subtle">
                  Showing {page.data.length} events. Cursor pagination lands with the real API.
                </p>
              )}
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

function eventColumns(orgId: string, projectId: string): Column<WebhookEvent>[] {
  return [
    {
      key: 'id',
      header: 'Event',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/events/${row.id}`}
          className="flex flex-col hover:underline"
        >
          <span className="font-mono text-xs text-ink">{truncateId(row.id)}</span>
          <span className="text-2xs text-ink-subtle">{row.event_type}</span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <EventStatusBadge status={row.status} /> },
    {
      key: 'fanout',
      header: 'Fan-out',
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone="ok">{row.delivery_counts.succeeded} ok</Badge>
          {row.delivery_counts.failed > 0 && (
            <Badge tone="warn">{row.delivery_counts.failed} failing</Badge>
          )}
          {row.delivery_counts.exhausted > 0 && (
            <Badge tone="danger">{row.delivery_counts.exhausted} exhausted</Badge>
          )}
          {row.delivery_counts.pending > 0 && (
            <Badge>{row.delivery_counts.pending} pending</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Payload',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-subtle">{formatBytes(row.payload_size_bytes)}</span>
      ),
    },
    {
      key: 'created',
      header: 'Received',
      align: 'right',
      render: (row) => (
        <span className="text-xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
  ];
}
