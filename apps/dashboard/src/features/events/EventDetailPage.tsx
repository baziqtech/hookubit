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
import {
  deliveryOutcome,
  describeDelivery,
  summarizeDeliveries,
} from '../../lib/delivery-status';
import { formatBytes, formatTimestamp, truncateId } from '../../lib/format';
import type { Delivery, DeliveryCounts, EventPayload } from '../../types/api';
import { nextAttemptLabel } from '../deliveries/next-attempt';
import { useEndpoints } from '../endpoints/api';
import { ParkedEventNotice } from '../outbox/ParkedEventNotice';
import { useEvent, useEventDeliveries, useReplayEvent } from './api';

export function EventDetailPage() {
  const { orgId = '', projectId = '', eventId = '' } = useParams();
  const event = useEvent(projectId, eventId);
  const deliveries = useEventDeliveries(projectId, eventId);
  const replay = useReplayEvent(projectId, eventId);
  // A delivery row carries `endpoint_id` and no name; the name is joined here.
  const endpoints = useEndpoints(projectId);
  const endpointNames = new Map(
    (endpoints.data?.rows ?? []).map((endpoint) => [endpoint.id, endpoint.name]),
  );
  /*
   * The routing roll-up is DERIVED from the delivery rows, not read off the
   * event. `EventDto` has no `delivery_counts` — that object was invented — and
   * deriving it is better anyway: a denormalised counter can disagree with the
   * table printed directly beneath it, and this one cannot.
   */
  const counts = summarizeDeliveries(deliveries.data?.rows ?? []);
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

            {/*
              The 2am path. A `failed` event PARKED before it routed — the
              publisher got 202, no delivery rows exist, replay has nothing to
              work from — and the only way back is a requeue. That row, its
              reason and the requeue live here rather than behind a menu.
            */}
            {data.status === 'failed' && (
              <ParkedEventNotice orgId={orgId} projectId={projectId} eventId={data.id} />
            )}

            <RoutingSummary counts={counts} pending={deliveries.isPending} />

            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Meta label="Payload size" value={formatBytes(data.payload_size)} />
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
                { value: 'deliveries', label: 'Deliveries', badge: counts.total },
                { value: 'payload', label: 'Payload' },
                { value: 'headers', label: 'Headers' },
              ]}
            >
              <div className="pt-4">
                {tab === 'deliveries' && (
                  <Panel flush>
                    <Async
                      query={deliveries}
                      isEmpty={(page) => page.rows.length === 0}
                      empty={
                        <EmptyState
                          title="No matching subscriptions"
                          description="This event was accepted but no enabled subscription matched it, so nothing was queued."
                        />
                      }
                    >
                      {(page) => (
                        <Table
                          caption="Deliveries for this event"
                          columns={deliveryColumns(orgId, projectId, endpointNames)}
                          rows={page.rows}
                          rowKey={(row) => row.id}
                        />
                      )}
                    </Async>
                  </Panel>
                )}
                {tab === 'payload' && <PayloadTab payload={data.payload} />}
                {tab === 'headers' && (
                  <CodeBlock value={data.headers ?? {}} label="ingest headers" />
                )}
              </div>
            </Tabs>

            <Dialog
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Replay this event?"
              description="The event is routed again to every matching subscription."
              footer={
                <>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={replay.isPending}
                    onClick={async () => {
                      await replay.mutateAsync({});
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
 * Routing, stated as the sentence it is.
 *
 * The tile this replaces read "1 deliveries" — a grammar bug, but the real
 * problem was that a bare count does not explain WHY there is more than one
 * row. One publish becomes one delivery per matching subscription, and someone
 * meeting that for the first time needs it said out loud rather than inferred
 * from a number.
 */
function RoutingSummary({ counts, pending }: { counts: DeliveryCounts; pending: boolean }) {
  const noun = counts.total === 1 ? 'delivery' : 'deliveries';
  // Counted from the rows below. Until they arrive, say so rather than showing
  // a confident zero that is about to change.
  if (pending) {
    return (
      <section aria-label="Routing" className="rounded-lg border border-line bg-panel px-4 py-3">
        <p className="text-sm text-ink">Counting the deliveries this event routed to…</p>
      </section>
    );
  }
  const outstanding = counts.exhausted + counts.failed;

  return (
    <section
      aria-label="Routing"
      className="rounded-lg border border-line bg-panel px-4 py-3"
    >
      <p className="text-sm text-ink">
        Published once, routed to{' '}
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

/**
 * The payload, as the API actually returns it.
 *
 * `EventDetailDto.payload` is an ENVELOPE, not the raw body: it says where the
 * bytes came from and carries a `notice` explaining the case. An event whose
 * payload was offloaded to object storage — or is simply gone — must not render
 * as an empty code block, which is what reading `data.payload` as the body
 * would have produced.
 */
function PayloadTab({ payload }: { payload: EventPayload }) {
  const body =
    payload.normalised_json ??
    (payload.encoding === 'base64' ? payload.body : (payload.body ?? null));

  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-subtle">
        <Badge tone={payload.source === 'inline' ? 'neutral' : 'warn'}>{payload.source}</Badge>
        <span>{formatBytes(payload.size_bytes)}</span>
        <span className="font-mono">sha256:{truncateId(payload.sha256, 12)}</span>
      </p>
      {payload.notice && (
        <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-ink-muted">
          {payload.notice}
        </p>
      )}
      {body === null ? (
        <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          The payload is not available to read here
          {payload.location ? ` — it is held at ${payload.location}.` : '.'}
        </p>
      ) : (
        <CodeBlock
          value={body}
          language={payload.encoding === 'base64' ? 'text' : undefined}
          label="payload"
          showLineNumbers
          maxHeight="34rem"
        />
      )}
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
      key: 'endpoint',
      header: 'Endpoint',
      render: (row) => (
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/deliveries/${row.id}`}
          className="flex flex-col hover:underline"
        >
          <span className="text-xs font-medium text-ink">
            {endpointNames.get(row.endpoint_id) ?? truncateId(row.endpoint_id)}
          </span>
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
      // No status code: it lives on an attempt, and this list carries none.
      render: (row) => (
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
      key: 'next',
      header: 'Next attempt',
      align: 'right',
      secondary: true,
      // Gated on `terminal`, as the delivery page already is. `next_attempt_at`
      // is becoming NOT NULL and a terminal row carries a meaningless one; a
      // succeeded delivery must never read "2 minutes ago" here.
      render: (row) => (
        <span className="text-xs text-ink-subtle" data-testid="next-attempt">
          {nextAttemptLabel(row)}
        </span>
      ),
    },
  ];
}
