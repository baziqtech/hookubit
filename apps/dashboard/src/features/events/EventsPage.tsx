import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  Input,
  Pager,
  PageHeader,
  Panel,
  Select,
  Table,
  type Column,
} from '../../components';
import { formatBytes, formatRelativeTime, truncateId } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type EventStatus, type WebhookEvent } from '../../types/api';
import { StuckEventsNotice } from '../outbox/StuckEventsNotice';
import { describeRollup } from './rollup';
import { useEvents, type EventFilters } from './api';

/**
 * Filter state lives in the URL, not in component state: an operator's next
 * move after finding a bad window is to paste the link into an incident
 * channel, and that only works if the filters travel with it.
 *
 * TWO THINGS CHANGED WITH THE REAL CONTRACT.
 *
 * The event-type dropdown was a HARD-CODED list of five payment types. There is
 * no route that enumerates the event types a project has seen, and a project
 * that publishes `shipment.dispatched` could not filter for it at all. It is a
 * text box, and `event_type` is an exact match.
 *
 * The general search box is gone. `EventsController` has no `search` parameter.
 * What it has is `idempotency_key` — a case-insensitive SUBSTRING of the
 * producer's own key, which is the "the producer says they sent order 41f9, did
 * we get it?" question the box was really being used for.
 */
export function EventsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  const filters: EventFilters = {
    event_type: searchParams.get('event_type') ?? '',
    status: (searchParams.get('status') ?? '') as EventStatus | '',
    idempotency_key: searchParams.get('idempotency_key') ?? '',
  };
  const events = useEvents(projectId, filters, offset);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
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
        title="Events"
        description="Everything published to this project. One event routes to one delivery per matching subscription."
      />

      {/*
        A stuck event IS in this list — it was accepted — and its rollup reads
        `received`, which is indistinguishable from an event published a second
        ago. Telling them apart needs `event_outbox`, a different table and a
        different screen. This is the door to it.
      */}
      <StuckEventsNotice orgId={orgId} projectId={projectId} />

      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
          <Input
            aria-label="Filter by event type"
            placeholder="Event type (exact), e.g. payment.settled"
            value={filters.event_type ?? ''}
            onChange={(event) => setFilter('event_type', event.target.value)}
            className="w-64"
          />
          <Input
            aria-label="Find by idempotency key"
            placeholder="Idempotency key contains… (3+ chars)"
            value={filters.idempotency_key ?? ''}
            onChange={(event) => setFilter('idempotency_key', event.target.value)}
            className="w-64"
          />
          <Select
            aria-label="Filter by status"
            placeholder="All statuses"
            value={filters.status ?? ''}
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
          isEmpty={(page) => page.rows.length === 0}
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
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="events"
              />
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
    {
      key: 'status',
      header: 'Status',
      /*
       * The DELIVERY rollup, not `status`.
       *
       * `status` is the ingest/routing state: `processed` means the router ran
       * and committed, and says nothing about whether anybody received
       * anything. A list built on it reports a project as healthy while every
       * delivery it produced is failing — and it cannot express `dropped`,
       * which is routing completing and matching nobody. That is the state
       * newcomers actually hit: a cheerful 202, and the event goes nowhere.
       */
      render: (row) => {
        const summary = describeRollup(row.deliveries);
        return (
          <Badge tone={summary.tone} dot>
            {summary.label}
          </Badge>
        );
      },
    },
    {
      key: 'deliveries',
      header: 'Deliveries',
      /*
       * THE ROUTING COLUMN IS BACK.
       *
       * It was removed because `EventDto` had no per-event delivery counts and
       * deriving them meant one `…/events/:id/deliveries` request per visible
       * row — fifty requests to paint one page. `EventsService` now rolls them
       * up in one grouped query over the page's ids, which is what HANDOFF.md
       * said would put this column back.
       */
      render: (row) => (
        <span className="text-2xs text-ink-muted">{describeRollup(row.deliveries).detail}</span>
      ),
    },
    {
      key: 'idempotency',
      header: 'Idempotency key',
      secondary: true,
      render: (row) => (
        <span className="font-mono text-2xs text-ink-subtle">
          {row.idempotency_key ?? '—'}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Payload',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-subtle">
          {formatBytes(row.payload_size)}
          {!row.payload_inline && (
            <span className="ml-1 text-2xs text-ink-subtle" title="Held in object storage">
              · offloaded
            </span>
          )}
        </span>
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
