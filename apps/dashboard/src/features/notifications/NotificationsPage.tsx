import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  GatedButton,
  Input,
  PageHeader,
  Panel,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format';
import { roleGate } from '../../lib/role-gate';
import type { NotificationDestination } from '../../types/api';
import { useOrganization } from '../organizations/api';
import {
  useCreateDestination,
  useDeleteDestination,
  useDestinations,
  useResendConfirmation,
  useTestDestination,
  useUpdateDestination,
} from './api';
import { NOTIFICATION_EVENTS, UNWIRED_EVENTS, eventLabel } from './events';

/** `notifications.write` is developer and up; viewers read. */
const WRITE_ROLES = ['owner', 'admin', 'developer'] as const;

/**
 * Where HookuBit tells a human that something went wrong in this project.
 *
 * ## Per project, and the page says so first
 *
 * An on-call address for payments is not the on-call address for the archive
 * project. One list for both is a list nobody trusts, and somebody who adds an
 * address here and assumes it covers their other three projects finds out
 * during the incident it was meant to catch.
 *
 * ## Pending is not a spinner
 *
 * A destination receives nothing until somebody who can read the address
 * confirms it. That is both consent — a group address exists so one person can
 * sign up a team — and the only check available that the address is real. So
 * `pending` is a first-class row with a Resend button, not a transient state
 * to hide.
 */
export function NotificationsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const destinations = useDestinations(projectId);
  const organization = useOrganization(orgId);
  const gate = roleGate(organization.data, WRITE_ROLES);

  const create = useCreateDestination(projectId);
  const [address, setAddress] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Notifications"
        description="Where we tell you that something went wrong in this project."
      />

      <p className="rounded-[0.625rem] border border-line bg-raised/50 px-3.5 py-2.5 text-xs leading-relaxed text-ink-muted">
        <strong className="font-semibold text-ink">These belong to this project only.</strong> Every
        project keeps its own destinations and its own rules. Adding an address here does not add
        it for your other projects.
      </p>

      <Panel
        title="Where we send"
        description="An address receives nothing until somebody who can read it confirms."
        flush
      >
        <Async
          query={destinations}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="Nothing is told when this project breaks"
              description="Add an address below. We send it one message asking whoever reads it to say yes, and until they do it receives nothing at all."
            />
          }
        >
          {(page) => (
            <Table
              caption="Notification destinations"
              columns={columns(projectId, gate)}
              rows={page.rows}
              rowKey={(row) => row.id}
            />
          )}
        </Async>
      </Panel>

      <Panel
        title="Add an email address"
        description="A group address works and is usually better — one person on holiday should not stop the message arriving."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const target = address.trim();
            if (!target) return;
            create.mutate(
              { kind: 'email', target },
              { onSuccess: () => setAddress('') },
            );
          }}
        >
          <div className="flex items-end gap-2">
            <Input
              label="Address"
              type="email"
              value={address}
              placeholder="payments-oncall@example.com"
              className="flex-1"
              onChange={(event) => setAddress(event.target.value)}
            />
            <GatedButton
              type="submit"
              variant="primary"
              gate={gate}
              action="Adding a notification destination"
              loading={create.isPending}
              className="mb-[1.375rem]"
            >
              Send a confirmation
            </GatedButton>
          </div>

          <WriteErrorNotice error={create.error} />

          <p className="text-2xs leading-relaxed text-ink-subtle">
            We confirm the address first: we send one message asking whoever reads it to say yes.
            Until they do, it sits in the list as <strong>Not confirmed</strong> and gets nothing.
            The link lasts seven days.
          </p>
        </form>
      </Panel>

      <WhatWeSend />
      <HowOften />
    </div>
  );
}

function columns(projectId: string, gate: ReturnType<typeof roleGate>): Column<NotificationDestination>[] {
  return [
    {
      key: 'target',
      header: 'Destination',
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-xs font-medium text-ink">{row.label}</span>
          <span className="text-2xs text-ink-subtle">
            {row.kind === 'email' ? 'Email' : 'Slack'}
            {row.label !== row.target && ` · ${row.target}`}
          </span>
        </span>
      ),
    },
    {
      key: 'events',
      header: 'What it gets',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-muted">
          {row.events.length === 0
            ? 'Nothing — muted'
            : row.events.length === NOTIFICATION_EVENTS.length
              ? 'Anything urgent'
              : row.events.map(eventLabel).join(', ')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <DestinationStatus destination={row} />,
    },
    {
      key: 'last',
      header: 'Last sent',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">
          {row.last_sent_at ? formatRelativeTime(row.last_sent_at) : 'never'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => <DestinationActions projectId={projectId} destination={row} gate={gate} />,
    },
  ];
}

function DestinationStatus({ destination }: { destination: NotificationDestination }) {
  if (destination.status === 'confirmed') {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge tone="ok" dot>
          Connected
        </Badge>
        {destination.last_error && (
          <span className="text-2xs text-danger">{destination.last_error}</span>
        )}
      </span>
    );
  }
  if (destination.status === 'pending') {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge tone="warn" dot>
          Not confirmed
        </Badge>
        <span className="text-2xs text-ink-subtle">Receives nothing until somebody says yes</span>
      </span>
    );
  }
  return (
    <Badge tone="danger" dot>
      {destination.status}
    </Badge>
  );
}

function DestinationActions({
  projectId,
  destination,
  gate,
}: {
  projectId: string;
  destination: NotificationDestination;
  gate: ReturnType<typeof roleGate>;
}) {
  const resend = useResendConfirmation(projectId);
  const test = useTestDestination(projectId);
  const remove = useDeleteDestination(projectId);
  const update = useUpdateDestination(projectId, destination.id);
  const muted = destination.events.length === 0;

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {destination.status === 'pending' ? (
        <GatedButton
          size="sm"
          gate={gate}
          action="Resending a confirmation"
          loading={resend.isPending}
          onClick={() => resend.mutate(destination.id)}
        >
          Resend
        </GatedButton>
      ) : (
        <GatedButton
          size="sm"
          gate={gate}
          action="Sending a test alert"
          loading={test.isPending}
          onClick={() => test.mutate(destination.id)}
        >
          {test.isSuccess ? 'Sent' : 'Send a test'}
        </GatedButton>
      )}

      {/*
        Muting rather than deleting keeps the confirmation, which is the
        expensive part: somebody had to read the mailbox and click a link.
      */}
      <GatedButton
        size="sm"
        gate={gate}
        action="Muting a destination"
        loading={update.isPending}
        onClick={() =>
          update.mutate({
            events: muted ? NOTIFICATION_EVENTS.map((event) => event.id) : [],
          })
        }
      >
        {muted ? 'Unmute' : 'Mute'}
      </GatedButton>

      <GatedButton
        size="sm"
        variant="danger"
        gate={gate}
        action="Removing a destination"
        loading={remove.isPending}
        onClick={() => remove.mutate(destination.id)}
      >
        Remove
      </GatedButton>
    </span>
  );
}

/**
 * What we send, and — for three of the four — that nothing sends it yet.
 *
 * Hiding the unwired triggers would mean an operator subscribes to what is
 * offered, sees nothing for a month, and concludes the feature is broken. A
 * row with a reason beside it is the honest version.
 */
function WhatWeSend() {
  return (
    <Panel
      title="What we send"
      description="Nothing routine. Only things a person has to act on."
    >
      <ul className="flex flex-col gap-3">
        {NOTIFICATION_EVENTS.map((event) => (
          <li key={event.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-ink">{event.label}</span>
              {event.urgent && <Badge tone="danger">wakes you</Badge>}
              {!event.wired && <Badge tone="neutral">not raised yet</Badge>}
            </span>
            <span className="text-2xs leading-relaxed text-ink-muted">{event.detail}</span>
          </li>
        ))}
      </ul>

      {UNWIRED_EVENTS.length > 0 && (
        <p className="mt-3 rounded-md border border-line bg-raised/50 px-3 py-2 text-2xs leading-relaxed text-ink-muted">
          <strong className="font-semibold text-ink">
            {UNWIRED_EVENTS.length} of these are not raised yet.
          </strong>{' '}
          An endpoint being stopped is noticed by the control plane, which is what sends it. The
          others are noticed in the delivery workers, and nothing carries the signal across yet.
          You can subscribe to them now; they will start arriving without you changing anything.
        </p>
      )}
    </Panel>
  );
}

function HowOften() {
  const rules = [
    [
      'Repeats are grouped',
      'If the same thing happens again within thirty minutes we do not send a second message. The next one says how many times it happened.',
    ],
    [
      'Nothing between 22:00 and 07:00',
      'Except an endpoint being stopped, which wakes you whatever the hour. Everything else waits for the morning.',
    ],
    [
      'Delivery is not guaranteed',
      'Email can fail. Treat these as a nudge, not as the record. The record is here.',
    ],
  ];

  return (
    <Panel title="How often" description="The rules that stop a bad afternoon becoming four hundred messages.">
      <dl className="flex flex-col gap-2.5">
        {rules.map(([title, detail]) => (
          <div key={title} className={cn('flex flex-col gap-0.5')}>
            <dt className="text-xs font-medium text-ink">{title}</dt>
            <dd className="text-2xs leading-relaxed text-ink-muted">{detail}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
