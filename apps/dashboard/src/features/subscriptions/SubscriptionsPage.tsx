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
import { useSubscriptions } from '../endpoints/api';
import type { Subscription } from '../../types/api';

export function SubscriptionsPage() {
  const { projectId = '' } = useParams();
  const subscriptions = useSubscriptions(projectId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Subscriptions"
        description="A subscription binds an endpoint to the event types it should receive. Fan-out is materialised per subscription."
        actions={<Button variant="primary">New subscription</Button>}
      />

      <Panel flush>
        <Async
          query={subscriptions}
          isEmpty={(rows) => rows.length === 0}
          empty={
            <EmptyState
              title="No subscriptions"
              description="Events are accepted but nothing is routed until a subscription matches them."
            />
          }
        >
          {(rows) => (
            <Table caption="Subscriptions" columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
        </Async>
      </Panel>
    </div>
  );
}

const columns: Column<Subscription>[] = [
  {
    key: 'name',
    header: 'Subscription',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name}</span>
        <span className="text-2xs text-ink-subtle">→ {row.endpoint_name}</span>
      </span>
    ),
  },
  {
    key: 'types',
    header: 'Event types',
    render: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.event_types.map((type) => (
          <Badge key={type} tone={type === '*' ? 'warn' : 'neutral'} className="font-mono">
            {type}
          </Badge>
        ))}
      </span>
    ),
  },
  {
    key: 'filter',
    header: 'Filter',
    secondary: true,
    render: (row) => (
      <span className="font-mono text-2xs text-ink-subtle">
        {row.filter ? JSON.stringify(row.filter) : '—'}
      </span>
    ),
  },
  {
    key: 'enabled',
    header: 'State',
    align: 'right',
    render: (row) => (
      <Badge tone={row.enabled ? 'ok' : 'neutral'} dot>
        {row.enabled ? 'enabled' : 'disabled'}
      </Badge>
    ),
  },
];
