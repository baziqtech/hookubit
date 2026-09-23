import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  DeliveryStatusBadge,
  EmptyState,
  Input,
  Pager,
  PageHeader,
  Panel,
  Select,
  StatusLegend,
  Table,
  type Column,
} from '../../components';
import { deliveryOutcome, describeDelivery } from '../../lib/delivery-status';
import { formatRelativeTime, truncateId } from '../../lib/format';
import { StuckEventsNotice } from '../outbox/StuckEventsNotice';
import { DEFAULT_PAGE_SIZE, type Delivery, type DeliveryStatus } from '../../types/api';
import { useEndpoints } from '../endpoints/api';
import { useDeliveries, type DeliveryFilters } from './api';

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

/**
 * Filter state lives in the URL, not in component state: an operator's next
 * move after finding a bad window is to paste the link into an incident
 * channel, and that only works if the filters travel with it.
 *
 * THE FREE-TEXT SEARCH BOX IS GONE. `DeliveriesController` has no `search`
 * parameter — the box sent `?search=` at a route that does not accept it — and
 * the filters it does accept are exact-match. `event_type` replaces it, which
 * is the thing the box was actually used for, and it is honest about being an
 * exact match rather than a substring.
 */
export function DeliveriesPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  const failingNow = searchParams.get('failing_now') === 'true';
  const filters: DeliveryFilters = {
    // `failing_now` and `status` CANNOT be combined — the API refuses the pair
    // rather than picking one, so the narrower control wins here too.
    status: failingNow ? '' : ((searchParams.get('status') ?? '') as DeliveryStatus | ''),
    failing_now: failingNow,
    endpoint_id: searchParams.get('endpoint_id') ?? '',
    event_type: searchParams.get('event_type') ?? '',
    origin: (searchParams.get('origin') ?? '') as '' | 'original' | 'replay',
  };
  const deliveries = useDeliveries(projectId, filters, offset);
  const endpoints = useEndpoints(projectId);

  // A delivery row carries `endpoint_id` and no name. The name is joined from
  // the endpoint list the page already loads for its filter, and a row whose
  // endpoint is not on that page falls back to the id rather than to blank.
  const endpointNames = new Map(
    (endpoints.data?.rows ?? []).map((endpoint) => [endpoint.id, endpoint.name]),
  );

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the page position.
    next.delete('offset');
    setSearchParams(next, { replace: true });
  };

  const setOffset = (value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value > 0) next.set('offset', String(value));
    else next.delete('offset');
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Deliveries"
        description="One row per event per endpoint. An event you published once appears here once per matching subscription, and each row retries independently."
      />

      {/*
        An event stuck before routing has no rows in this list at all, so an
        empty result here is indistinguishable from "never published". This is
        the only thing on the page that can tell those apart, and it renders
        nothing when there is nothing stuck.
      */}
      <StuckEventsNotice orgId={orgId} projectId={projectId} />

      {/*
        The glossary lives next to the filter that uses these words, not in a
        docs site. `exhausted` and `cancelled` both mean "stopped" and mean very
        different things, and the badge alone never says which.
      */}
      <StatusLegend highlight={filters.status as DeliveryStatus | ''} />

      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
          <label className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={failingNow}
              onChange={(event) => setFilter('failing_now', event.target.checked ? 'true' : '')}
              className="h-3.5 w-3.5 accent-[color:var(--danger,#dc2626)]"
            />
            Failing now
          </label>
          <Select
            aria-label="Filter by status"
            placeholder="All statuses"
            value={filters.status ?? ''}
            disabled={failingNow}
            onChange={(event) => setFilter('status', event.target.value)}
            options={STATUSES.map((status) => ({ value: status, label: status }))}
            className="w-40"
          />
          <Select
            aria-label="Filter by endpoint"
            placeholder="All endpoints"
            value={filters.endpoint_id ?? ''}
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
          <Input
            aria-label="Filter by event type"
            placeholder="Event type (exact)"
            value={filters.event_type ?? ''}
            onChange={(event) => setFilter('event_type', event.target.value)}
            className="w-56"
          />
          <Select
            aria-label="Filter by origin"
            placeholder="Originals and replays"
            value={filters.origin ?? ''}
            onChange={(event) => setFilter('origin', event.target.value)}
            options={[
              { value: 'original', label: 'Originals only' },
              { value: 'replay', label: 'Replays only' },
            ]}
            className="w-48"
          />
        </div>

        {failingNow && (
          <p className="border-b border-line bg-raised px-3 py-1.5 text-2xs text-ink-muted">
            Showing <strong className="text-ink">retrying</strong>,{' '}
            <strong className="text-ink">failed</strong> and{' '}
            <strong className="text-ink">exhausted</strong> together. The status filter is disabled
            while this is on — the API refuses the two combined rather than quietly picking one.
          </p>
        )}

        <Async
          query={deliveries}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No deliveries match"
              description="Try clearing a filter, or widen the status selection."
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Deliveries"
                columns={deliveryColumns(orgId, projectId, endpointNames)}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="deliveries"
              />
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

function deliveryColumns(
  orgId: string,
  projectId: string,
  endpointNames: Map<string, string>,
): Column<Delivery>[] {
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
          {/*
            The event TYPE is not on a delivery row — only `event_id` is, and
            the type lives on the event. The id is shown rather than a type this
            row cannot supply; the detail page has both.
          */}
          <span className="font-mono text-2xs text-ink-subtle">
            {truncateId(row.event_id)}
            {row.is_replay && ' · replay'}
          </span>
        </Link>
      ),
    },
    {
      key: 'endpoint',
      header: 'Endpoint',
      render: (row) => (
        <span className="text-xs text-ink">
          {endpointNames.get(row.endpoint_id) ?? (
            <span className="font-mono text-2xs text-ink-subtle">
              {truncateId(row.endpoint_id)}
            </span>
          )}
        </span>
      ),
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
        // No status code here: the code lives on an attempt, and a list row
        // carries none. `describeDelivery` falls back to `last_error`.
        <span className="text-xs text-ink-muted">{describeDelivery(deliveryOutcome(row))}</span>
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
