import { useState } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  GatedButton,
  Pager,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { truncateId } from '../../lib/format';
import type { RoleGate } from '../../lib/role-gate';
import { DEFAULT_PAGE_SIZE, type Subscription } from '../../types/api';
import { useEndpoints } from '../endpoints/api';
import { useOrganizations } from '../organizations/api';
import { useSubscriptions } from './api';
import { subscriptionWriteGate } from './permissions';
import { SubscriptionActions } from './SubscriptionActions';
import { SubscriptionFormDialog } from './SubscriptionFormDialog';

export function SubscriptionsPage() {
  const { orgId = '', projectId = '' } = useParams();
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
  // Only for the gate and the denial copy — the caller's real role in THIS
  // organization. A failure here leaves the gate `unknown`, which enables the
  // controls: the server is the authority and its 403 is rendered honestly.
  const organizations = useOrganizations();
  const gate = subscriptionWriteGate(
    organizations.data?.rows.find((organization) => organization.id === orgId),
  );

  // One dialog for the whole table, driven by which row was clicked; `'new'`
  // is the create case. A dialog per row would put fifty `<dialog>` elements
  // in the document.
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);

  const setOffset = (value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value > 0) next.set('offset', String(value));
    else next.delete('offset');
    setSearchParams(next, { replace: true });
  };

  const nameOf = (endpointId: string) => endpointNames.get(endpointId) ?? truncateId(endpointId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Subscriptions"
        description="A subscription binds an endpoint to the event types it should receive. Fan-out is materialised per subscription."
        actions={
          <GatedButton
            variant="primary"
            gate={gate}
            action="Creating a subscription"
            onClick={() => setEditing('new')}
          >
            New subscription
          </GatedButton>
        }
      />

      <MatcherReference />

      <Panel flush>
        <Async
          query={subscriptions}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No subscriptions"
              description="Events are accepted but nothing is routed until a subscription matches them."
              action={
                <GatedButton
                  variant="primary"
                  gate={gate}
                  action="Creating a subscription"
                  onClick={() => setEditing('new')}
                >
                  New subscription
                </GatedButton>
              }
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Subscriptions"
                columns={buildColumns(projectId, nameOf, gate, setEditing)}
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

      {editing !== null && (
        <SubscriptionFormDialog
          projectId={projectId}
          subscription={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * The three matchers, and nothing else.
 *
 * `event_types` accepts an exact type, a trailing-wildcard prefix, or `*`.
 * Anything else is refused by the API — and the refusal arrives after the form
 * has been filled in, which is the wrong moment to learn the vocabulary. Three
 * rows of reference above the table cost nothing and remove the whole class of
 * guess.
 *
 * `*` is called out as matching types that do not exist yet, because that is
 * the property people are surprised by: a catch-all subscription written today
 * starts receiving a new event type the day someone else publishes one.
 */
function MatcherReference() {
  const matchers = [
    {
      pattern: '*',
      name: 'Everything',
      detail:
        'Every event type in this project, including types that do not exist yet. A new type starts arriving here the day it is first published.',
    },
    {
      pattern: 'payment.*',
      name: 'Prefix',
      detail: 'Every type beginning payment. — payment.settled, payment.failed, and so on.',
    },
    { pattern: 'payment.settled', name: 'Exact', detail: 'That one type and nothing else.' },
  ];

  return (
    <Panel
      title="Accepted matchers"
      description="Only these three. Anything else is refused when you save."
    >
      <ul className="grid gap-3 sm:grid-cols-3">
        {matchers.map((matcher) => (
          <li key={matcher.pattern} className="flex flex-col gap-1.5">
            <span className="flex items-baseline gap-2">
              <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-2xs text-ink">
                {matcher.pattern}
              </code>
              <span className="text-2xs font-semibold text-ink-muted">{matcher.name}</span>
            </span>
            <span className="text-2xs text-ink-subtle">{matcher.detail}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function buildColumns(
  projectId: string,
  nameOf: (endpointId: string) => string,
  gate: RoleGate,
  onEdit: (subscription: Subscription) => void,
): Column<Subscription>[] {
  return [
    {
      key: 'name',
      header: 'Subscription',
      render: (row) => (
        <span className="flex flex-col">
          {/* `name` is NULLABLE on the wire — an unnamed subscription is legal. */}
          <span className="text-xs font-medium text-ink">
            {row.name ?? <span className="text-ink-subtle">Unnamed</span>}
          </span>
          <span className="text-2xs text-ink-subtle">→ {nameOf(row.endpoint_id)}</span>
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
      header: 'Condition',
      secondary: true,
      /*
       * `payload_filter`, not `filter`. The control API stores it and the Go
       * router never reads it, so a subscription with a condition delivers
       * exactly as if it had none.
       *
       * A stored rule that does nothing is the most dangerous kind of
       * configuration: it looks like a guard, it reads back correctly, and
       * the only way to discover it is inert is for the wrong consumer to
       * receive something. So the row that HAS one says so, every time, in
       * the cell next to it — not in a footnote, and not only in the form
       * where it was typed.
       */
      render: (row) =>
        row.payload_filter ? (
          <span className="flex flex-col items-start gap-1">
            <span className="font-mono text-2xs text-ink-muted">
              {JSON.stringify(row.payload_filter)}
            </span>
            <Badge tone="warn">stored, not yet applied</Badge>
          </span>
        ) : (
          <span className="text-2xs text-ink-subtle">—</span>
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
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <SubscriptionActions
          subscription={row}
          projectId={projectId}
          endpointName={nameOf(row.endpoint_id)}
          gate={gate}
          onEdit={() => onEdit(row)}
        />
      ),
    },
  ];
}
