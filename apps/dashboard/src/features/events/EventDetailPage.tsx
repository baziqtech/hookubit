import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Button,
  CodeBlock,
  DeliveryStatusBadge,
  Dialog,
  EmptyState,
  EventStatusBadge,
  PageHeader,
  Panel,
  Table,
  Tabs,
  type Column,
} from '../../components';
import { describeDelivery } from '../../lib/delivery-status';
import { formatBytes, formatRelativeTime, formatTimestamp, truncateId } from '../../lib/format';
import type { Delivery } from '../../types/api';
import { useEvent, useEventDeliveries, useReplayEvent } from './api';

export function EventDetailPage() {
  const { orgId = '', projectId = '', eventId = '' } = useParams();
  const event = useEvent(eventId);
  const deliveries = useEventDeliveries(eventId);
  const replay = useReplayEvent(eventId);
  const [tab, setTab] = useState('deliveries');
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Async query={event}>
        {(data) => (
          <>
            <PageHeader
              eyebrow={
                <>
                  <Link
                    to={`/orgs/${orgId}/projects/${projectId}/events`}
                    className="text-ink-muted hover:text-ink"
                  >
                    Events
                  </Link>
                  <span className="text-ink-subtle">/</span>
                  <span className="font-mono text-xs text-ink-subtle">{data.id}</span>
                </>
              }
              title={data.event_type}
              description={`Received ${formatTimestamp(data.created_at)}`}
              actions={
                <>
                  <EventStatusBadge status={data.status} />
                  <Button onClick={() => setConfirming(true)}>Replay event</Button>
                </>
              }
            />

            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Meta label="Payload size" value={formatBytes(data.payload_size_bytes)} />
              <Meta label="Idempotency key" value={data.idempotency_key ?? '—'} mono />
              <Meta label="Ordering key" value={data.ordering_key ?? '—'} mono />
              <Meta
                label="Fan-out"
                value={`${data.delivery_counts.total} deliveries`}
                hint={`${data.delivery_counts.succeeded} succeeded · ${data.delivery_counts.exhausted} exhausted`}
              />
            </dl>

            <Tabs
              aria-label="Event detail"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'deliveries', label: 'Deliveries', badge: data.delivery_counts.total },
                { value: 'payload', label: 'Payload' },
                { value: 'headers', label: 'Headers' },
              ]}
            >
              <div className="pt-4">
                {tab === 'deliveries' && (
                  <Panel flush>
                    <Async
                      query={deliveries}
                      isEmpty={(rows) => rows.length === 0}
                      empty={
                        <EmptyState
                          title="No matching subscriptions"
                          description="This event was accepted but no enabled subscription matched it, so nothing was queued."
                        />
                      }
                    >
                      {(rows) => (
                        <Table
                          caption="Deliveries for this event"
                          columns={deliveryColumns(orgId, projectId)}
                          rows={rows}
                          rowKey={(row) => row.id}
                        />
                      )}
                    </Async>
                  </Panel>
                )}
                {tab === 'payload' && (
                  <CodeBlock value={data.payload} label="payload" showLineNumbers maxHeight="34rem" />
                )}
                {tab === 'headers' && <CodeBlock value={data.headers} label="request headers" />}
              </div>
            </Tabs>

            <Dialog
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Replay this event?"
              description="Every matching subscription is fanned out again."
              footer={
                <>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={replay.isPending}
                    onClick={async () => {
                      await replay.mutateAsync();
                      setConfirming(false);
                    }}
                  >
                    Replay
                  </Button>
                </>
              }
            >
              <p className="text-xs text-ink-muted">
                Consumers receive a duplicate delivery. Delivery is at-least-once by design, so this
                is safe only for consumers that deduplicate on{' '}
                <code className="font-mono">Webhook-Id</code>.
              </p>
            </Dialog>
          </>
        )}
      </Async>
    </div>
  );
}

function Meta({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-2.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={`mt-1 truncate text-xs text-ink ${mono ? 'font-mono' : ''}`}>{value}</dd>
      {hint && <dd className="mt-0.5 text-2xs text-ink-subtle">{hint}</dd>}
    </div>
  );
}

function deliveryColumns(orgId: string, projectId: string): Column<Delivery>[] {
  return [
    {
      key: 'endpoint',
      header: 'Endpoint',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/deliveries/${row.id}`}
          className="flex flex-col hover:underline"
        >
          <span className="text-xs font-medium text-ink">{row.endpoint_name}</span>
          <span className="font-mono text-2xs text-ink-subtle">{truncateId(row.id)}</span>
        </Link>
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
      render: (row) => <span className="text-xs text-ink-muted">{describeDelivery(row)}</span>,
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
      key: 'next',
      header: 'Next attempt',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-subtle">
          {row.next_attempt_at ? formatRelativeTime(row.next_attempt_at) : '—'}
        </span>
      ),
    },
  ];
}
