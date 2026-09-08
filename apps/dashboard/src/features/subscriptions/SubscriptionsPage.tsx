import { useSearchParams, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  Pager,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { truncateId } from '../../lib/format';
import { useEndpoints, useSubscriptions } from '../endpoints/api';
import { DEFAULT_PAGE_SIZE, type Subscription } from '../../types/api';

export function SubscriptionsPage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  const subscriptions = useSubscriptions(projectId, offset);
  // `SubscriptionDto` carries `endpoint_id` and NO `endpoint_name`. The name is
  // joined from the endpoint list; a row whose endpoint is off the first page
  // shows the id rather than an empty cell.
  const endpoints = useEndpoints(projectId);
  const endpointNames = new Map(
    (endpoints.data?.rows ?? []).map((endpoint) => [endpoint.id, endpoint.name]),
  );

  const setOffset = (value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value > 0) next.set('offset', String(value));
    else next.delete('offset');
    setSearchParams(next, { replace: true });
  };

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
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No subscriptions"
              description="Events are accepted but nothing is routed until a subscription matches them."
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Subscriptions"
                columns={columns(endpointNames)}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="subscriptions"
              />
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

const columns = (endpointNames: Map<string, string>): Column<Subscription>[] => [
  {
    key: 'name',
    header: 'Subscription',
    render: (row) => (
      <span className="flex flex-col">
        {/* `name` is NULLABLE on the wire — an unnamed subscription is legal. */}
        <span className="text-xs font-medium text-ink">
          {row.name ?? <span className="text-ink-subtle">Unnamed</span>}
        </span>
        <span className="text-2xs text-ink-subtle">
          → {endpointNames.get(row.endpoint_id) ?? truncateId(row.endpoint_id)}
        </span>
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
    header: 'Payload filter',
    secondary: true,
    // `payload_filter`, not `filter`.
    render: (row) => (
      <span className="font-mono text-2xs text-ink-subtle">
        {row.payload_filter ? JSON.stringify(row.payload_filter) : '—'}
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
