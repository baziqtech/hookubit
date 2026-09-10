import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  EmptyState,
  Input,
  Pager,
  PageHeader,
  Panel,
  Select,
  Table,
  type Column,
} from '../../components';
import { formatRelativeTime, formatTimestamp, truncateId } from '../../lib/format';
import {
  DEFAULT_PAGE_SIZE,
  MAX_REQUEUE_BATCH,
  type Organization,
  type OutboxEntry,
  type OutboxStatus,
} from '../../types/api';
import { useOrganizations } from '../organizations/api';
import { useOutboxEntries, type OutboxFilters } from './api';
import { OUTBOX_STATUS_SENTENCE, OutboxStatusBadge } from './OutboxStatusBadge';
import { ParkedExplanation } from './ParkedExplanation';
import { isParked } from './parked';
import { requeueGate, type RequeueGate } from './permissions';
import { BulkRequeueDialog, EventLink, RequeueButton, RequeueEntryDialog } from './RequeueDialogs';

/**
 * The status filter as it lives in the URL.
 *
 * ABSENT MEANS PARKED. This page exists for the rows the platform answered
 * 202 to and then could not fan out, so the default is the set that needs a
 * person, and `?status=all` is the explicit way to widen it. A default of
 * "everything" would open on a wall of `processed` rows — every event that
 * ever went through — with the three that matter somewhere on page 40.
 */
export type StatusChoice = OutboxStatus | 'all';

const STATUS_CHOICES: readonly OutboxStatus[] = ['failed', 'pending', 'processing', 'processed'];

export function readStatusChoice(param: string | null): StatusChoice {
  if (param === null || param === '') return 'failed';
  if (param === 'all') return 'all';
  return (STATUS_CHOICES as readonly string[]).includes(param) ? (param as OutboxStatus) : 'failed';
}

const STATUS_OPTIONS: { value: StatusChoice; label: string }[] = [
  { value: 'failed', label: 'Parked — needs a person' },
  { value: 'pending', label: 'Queued' },
  { value: 'processing', label: 'Fanning out' },
  { value: 'processed', label: 'Fanned out' },
  { value: 'all', label: 'Any status' },
];

export function OutboxPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  const status = readStatusChoice(searchParams.get('status'));
  const filters: OutboxFilters = {
    status: status === 'all' ? '' : status,
    event_id: searchParams.get('event_id') ?? '',
  };
  const entries = useOutboxEntries(projectId, filters, offset);

  // Only for the gate and the denial copy — the caller's real role in THIS
  // organization. A failure here leaves the gate `unknown`, which means the
  // button stays enabled and the server answers; it never blocks the page.
  const organizations = useOrganizations();
  const organization: Organization | undefined = organizations.data?.rows.find(
    (row) => row.id === orgId,
  );
  const gate = requeueGate(organization);

  const [requeueing, setRequeueing] = useState<OutboxEntry | null>(null);
  const [bulk, setBulk] = useState(false);

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

  const showingParked = status === 'failed';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Outbox"
        description="What the router still owes each accepted event. A parked row is an event the publisher was told we accepted and that nothing will deliver until someone requeues it."
        actions={
          showingParked && (
            <RequeueButton
              gate={gate}
              size="md"
              variant="primary"
              onClick={() => setBulk(true)}
            >
              {filters.event_id
                ? 'Requeue this event’s parked rows'
                : `Requeue parked, ${MAX_REQUEUE_BATCH} at a time`}
            </RequeueButton>
          )
        }
      />

      {showingParked && <ParkedPrimer />}

      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setFilter('status', event.target.value === 'failed' ? '' : event.target.value)}
            options={STATUS_OPTIONS}
            className="w-56"
          />
          <Input
            aria-label="Filter by event ID"
            placeholder="Event ID (exact)"
            mono
            value={filters.event_id ?? ''}
            onChange={(event) => setFilter('event_id', event.target.value)}
            className="w-64"
          />
          {filters.event_id && (
            <Link
              to={`/orgs/${orgId}/projects/${projectId}/events/${filters.event_id}`}
              className="text-xs font-medium text-accent hover:underline"
            >
              Open event →
            </Link>
          )}
        </div>

        {!showingParked && status !== 'all' && (
          <p className="border-b border-line bg-raised px-3 py-1.5 text-2xs text-ink-muted">
            {OUTBOX_STATUS_SENTENCE[status]} Nothing here needs a person; only parked rows can be
            requeued.
          </p>
        )}

        <Async
          query={entries}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            showingParked ? (
              <EmptyState
                title={filters.event_id ? 'Nothing parked for this event' : 'Nothing is parked'}
                description={
                  filters.event_id
                    ? 'This event has no parked outbox row. If its status still reads failed, a requeue is already in flight — or widen the status filter to see its row.'
                    : 'Every accepted event has either fanned out or is still in the queue. Widen the status filter to see the rest of the outbox.'
                }
              />
            ) : (
              <EmptyState
                title="No outbox rows match"
                description="Try a different status, or clear the event filter."
              />
            )
          }
        >
          {(page) => (
            <>
              <Table
                caption="Outbox entries"
                columns={outboxColumns(orgId, projectId, gate, setRequeueing)}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label={showingParked ? 'parked entries' : 'outbox entries'}
              />
            </>
          )}
        </Async>
      </Panel>

      {requeueing && (
        <RequeueEntryDialog
          entry={requeueing}
          projectId={projectId}
          currentRole={organization?.role}
          onClose={() => setRequeueing(null)}
        />
      )}
      {bulk && (
        <BulkRequeueDialog
          projectId={projectId}
          scopeEventId={filters.event_id || undefined}
          currentRole={organization?.role}
          onClose={() => setBulk(false)}
        />
      )}
    </div>
  );
}

/**
 * The model, in three sentences, above the table that uses it.
 *
 * A parked row is the one state in the product where the platform has broken
 * a promise it already made, and the counters that explain it — `attempts`
 * versus `unaccounted_attempts` — are not guessable. The primer is what stops
 * this page needing a runbook open beside it.
 */
function ParkedPrimer() {
  return (
    <section
      aria-label="What a parked row is"
      className="rounded-lg border border-danger/30 bg-danger-soft/40 px-4 py-3"
    >
      <h2 className="text-xs font-semibold text-ink">Parked means accepted and undelivered</h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">
        The publisher received <strong className="text-ink">202 Accepted</strong>, then the router
        gave up before writing any delivery rows — so there is nothing on the deliveries page and
        nothing for a replay to work from. Each row says why it parked in the router’s own words:
        claims that <em>left no record</em> mean the event kept killing the router; claims that
        were all recorded mean something underneath it — usually the database — was failing for
        longer than the retry window.
      </p>
      <p className="mt-1.5 text-2xs text-ink-subtle">
        Requeueing runs the fan-out that never happened. It is bounded to the subscriptions that
        existed when the event was accepted, it preserves the claim history, and a partly-done
        fan-out resumes where it stopped.
      </p>
    </section>
  );
}

function outboxColumns(
  orgId: string,
  projectId: string,
  gate: RequeueGate,
  onRequeue: (entry: OutboxEntry) => void,
): Column<OutboxEntry>[] {
  return [
    {
      key: 'event',
      header: 'Event',
      width: 'w-44',
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <EventLink orgId={orgId} projectId={projectId} eventId={row.event_id} />
          <span className="font-mono text-2xs text-ink-subtle" title={row.id}>
            {truncateId(row.id)}
          </span>
          <span className="text-2xs text-ink-subtle" title={formatTimestamp(row.created_at)}>
            accepted {formatRelativeTime(row.created_at)}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-28',
      render: (row) => <OutboxStatusBadge status={row.status} />,
    },
    {
      key: 'why',
      header: 'Why',
      render: (row) =>
        isParked(row) ? (
          <ParkedExplanation entry={row} compact />
        ) : (
          <LiveRow entry={row} />
        ),
    },
    {
      key: 'claims',
      header: 'Claims',
      align: 'right',
      secondary: true,
      width: 'w-24',
      render: (row) => (
        <span
          className="flex flex-col items-end text-xs"
          title="Total claims / claims that ended with nothing recorded"
        >
          <span className="text-ink">{row.attempts}</span>
          <span className="text-2xs text-ink-subtle">{row.unaccounted_attempts} unaccounted</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      width: 'w-28',
      render: (row) =>
        isParked(row) ? (
          <RequeueButton gate={gate} onClick={() => onRequeue(row)}>
            Requeue
          </RequeueButton>
        ) : null,
    },
  ];
}

/**
 * A row that is NOT parked, described honestly rather than left blank.
 *
 * `pending` with a `last_error` is a row in its backoff after a recorded
 * failure — not broken, but worth a glance if it has been failing for a while.
 * `processing` shows who holds the lease, so one misbehaving router replica is
 * findable from here.
 */
function LiveRow({ entry }: { entry: OutboxEntry }) {
  return (
    <div className="flex flex-col gap-0.5 text-2xs text-ink-subtle">
      {entry.status === 'processing' && entry.locked_by && (
        <span>
          leased by <span className="font-mono text-ink">{entry.locked_by}</span>
          {entry.locked_until && ` until ${formatRelativeTime(entry.locked_until)}`}
        </span>
      )}
      {entry.status === 'pending' && entry.failing_since && (
        <span className="text-warn">
          retrying — failing since {formatRelativeTime(entry.failing_since)}, next claim{' '}
          {formatRelativeTime(entry.available_at)}
        </span>
      )}
      {entry.status === 'pending' && !entry.failing_since && (
        <span>claimable {formatRelativeTime(entry.available_at)}</span>
      )}
      {entry.status === 'processed' && entry.processed_at && (
        <span>completed {formatRelativeTime(entry.processed_at)}</span>
      )}
      {entry.fan_out_cursor && entry.status !== 'processed' && (
        <span>
          fan-out partly done · resumes after{' '}
          <span className="font-mono">{entry.fan_out_cursor}</span>
        </span>
      )}
      {entry.last_error && (
        <span className="overflow-x-auto font-mono text-ink-muted">{entry.last_error}</span>
      )}
    </div>
  );
}
