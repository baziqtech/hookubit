import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
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
import type { Delivery, DeliveryCounts } from '../../types/api';
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

            <FanOutSummary counts={data.delivery_counts} />

            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Meta label="Payload size" value={formatBytes(data.payload_size_bytes)} />
              <Meta
                label="Idempotency key"
                value={data.idempotency_key ?? 'None sent'}
                hint={
                  data.idempotency_key
                    ? 'Re-publishing with this key returns this event instead of creating another.'
                    : 'Without one, a publisher that retries creates a second event.'
                }
                mono={Boolean(data.idempotency_key)}
              />
              <Meta
                label="Ordering key"
                value={data.ordering_key ?? 'None'}
                hint={
                  data.ordering_key
                    ? 'Stored, but per-key serialisation is not enforced yet.'
                    : 'Deliveries for this event are unordered.'
                }
                mono={Boolean(data.ordering_key)}
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


/**
 * Fan-out, stated as the sentence it is.
 *
 * The tile this replaces read "1 deliveries" — a grammar bug, but the real
 * problem was that a bare count does not explain WHY there is more than one
 * row. One publish becomes one delivery per matching subscription, and someone
 * meeting that for the first time needs it said out loud rather than inferred
 * from a number.
 */
function FanOutSummary({ counts }: { counts: DeliveryCounts }) {
  const noun = counts.total === 1 ? 'delivery' : 'deliveries';
  const outstanding = counts.exhausted + counts.failed;

  return (
    <section
      aria-label="Fan-out"
      className="rounded-lg border border-line bg-panel px-4 py-3"
    >
      <p className="text-sm text-ink">
        Published once, fanned out to{' '}
        <strong className="font-semibold">
          {counts.total} {noun}
        </strong>{' '}
        — one per matching subscription.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        Each has an independent retry chain, so one endpoint failing does not hold up the others,
        and replaying one does not re-send to the rest.
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={counts.succeeded > 0 ? 'ok' : 'neutral'} dot>
          {counts.succeeded} succeeded
        </Badge>
        {counts.pending > 0 && (
          <Badge tone="warn" dot>
            {counts.pending} still going
          </Badge>
        )}
        {counts.failed > 0 && (
          <Badge tone="danger" dot>
            {counts.failed} failing
          </Badge>
        )}
        {counts.exhausted > 0 && (
          <Badge tone="danger" dot>
            {counts.exhausted} exhausted
          </Badge>
        )}
      </div>

      {outstanding > 0 && (
        <p className="mt-2 text-2xs text-ink-subtle">
          Open a delivery below to see its attempts and why it stopped.
        </p>
      )}
    </section>
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
