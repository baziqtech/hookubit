import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrganizations } from '../organizations/api';
import type { OutboxEntry, Role } from '../../types/api';
import { useOutboxEntries } from './api';
import { ParkedExplanation } from './ParkedExplanation';
import { isParked } from './parked';
import { requeueGate, type RequeueGate } from './permissions';
import { RequeueButton, RequeueEntryDialog } from './RequeueDialogs';

/**
 * The 2am path: event page → "why did this park?" → requeue.
 *
 * An event whose status is `failed` has NO delivery rows, so the event page's
 * routing summary honestly reads "0 deliveries" and its replay button has
 * nothing to work from. Without this panel the operator is left to guess that
 * a menu called "Outbox" exists. With it, the row that parked the event is on
 * the event page, with its reason, and the requeue is one click from there.
 */
export function ParkedEventNotice({
  orgId,
  projectId,
  eventId,
}: {
  orgId: string;
  projectId: string;
  eventId: string;
}) {
  const entries = useOutboxEntries(projectId, { status: '', event_id: eventId }, 0);
  const organizations = useOrganizations();
  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const gate = requeueGate(organization);

  // Silence while loading; a wrong panel is worse than a late one.
  if (!entries.data) return null;
  const parked = entries.data.rows.filter(isParked);

  return (
    <ParkedEventPanel
      orgId={orgId}
      projectId={projectId}
      eventId={eventId}
      parked={parked}
      gate={gate}
      currentRole={organization?.role}
    />
  );
}

/** The presentational half, so the copy can be tested without a query client. */
export function ParkedEventPanel({
  orgId,
  projectId,
  eventId,
  parked,
  gate,
  currentRole,
}: {
  orgId: string;
  projectId: string;
  eventId: string;
  parked: OutboxEntry[];
  gate: RequeueGate;
  currentRole?: Role;
}) {
  const [requeueing, setRequeueing] = useState<OutboxEntry | null>(null);
  const outboxHref = `/orgs/${orgId}/projects/${projectId}/outbox?event_id=${encodeURIComponent(eventId)}`;

  return (
    <section
      role="alert"
      data-testid="parked-event-notice"
      className="rounded-lg border border-danger/40 bg-danger-soft/60 px-4 py-3"
    >
      <h2 className="text-xs font-semibold text-danger">
        This event parked before it routed — nothing will deliver it until it is requeued
      </h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">
        The publisher was told <strong className="text-ink">202 Accepted</strong>, then the router
        gave up before writing a single delivery row. That is why there are no deliveries below,
        and why replay cannot help: there is nothing to replay. Requeue runs the routing that never
        happened.
      </p>

      {parked.length === 0 ? (
        <p className="mt-2 text-2xs text-ink-subtle">
          No parked outbox row was found for this event — a requeue may already be in flight.{' '}
          <Link to={outboxHref} className="font-medium text-accent hover:underline">
            See its outbox rows →
          </Link>
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {parked.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-2 rounded-md border border-line bg-panel px-3 py-2.5 md:flex-row md:items-start md:justify-between"
            >
              <ParkedExplanation entry={entry} />
              <RequeueButton
                gate={gate}
                variant="primary"
                className="shrink-0"
                onClick={() => setRequeueing(entry)}
              >
                Requeue
              </RequeueButton>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-2xs">
        <Link to={outboxHref} className="font-medium text-accent hover:underline">
          Open in the outbox →
        </Link>
      </p>

      {requeueing && (
        <RequeueEntryDialog
          entry={requeueing}
          projectId={projectId}
          currentRole={currentRole}
          onClose={() => setRequeueing(null)}
        />
      )}
    </section>
  );
}
