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
      header: 'Payload filter',
      secondary: true,
      // `payload_filter`, not `filter`. Stored, and NOT yet evaluated by the
      // data plane — the form says so; the column just shows what is stored.
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
