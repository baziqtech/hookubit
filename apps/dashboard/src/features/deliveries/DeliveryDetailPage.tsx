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
  PageHeader,
  Panel,
  Tabs,
} from '../../components';
import {
  attemptOutcome,
  attemptProgressLabel,
  canReplay,
  describeDelivery,
} from '../../lib/delivery-status';
import { formatDuration, formatRelativeTime, formatTimestamp } from '../../lib/format';
import type { DeliveryAttempt } from '../../types/api';
import { useDelivery, useDeliveryAttempts, useReplayDelivery } from './api';

/**
 * "What happened to this delivery?" — the whole reason the operator surface
 * exists. Every attempt, its status code, duration, and the response body the
 * endpoint actually returned.
 */
export function DeliveryDetailPage() {
  const { orgId = '', projectId = '', deliveryId = '' } = useParams();
  const delivery = useDelivery(deliveryId);
  const attempts = useDeliveryAttempts(deliveryId);
  const replay = useReplayDelivery(deliveryId);
  const [tab, setTab] = useState('attempts');
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Async query={delivery}>
        {(data) => (
          <>
            <PageHeader
              eyebrow={
                <>
                  <Link
                    to={`/orgs/${orgId}/projects/${projectId}/deliveries`}
                    className="text-ink-muted hover:text-ink"
                  >
                    Deliveries
                  </Link>
                  <span className="text-ink-subtle">/</span>
                  <span className="font-mono text-xs text-ink-subtle">{data.id}</span>
                </>
              }
              title={data.endpoint_name}
              description={describeDelivery(data)}
              actions={
                <>
                  <DeliveryStatusBadge status={data.status} />
                  <Button
                    onClick={() => setConfirming(true)}
                    disabled={!canReplay(data)}
                    title={
                      canReplay(data)
                        ? undefined
                        : 'Replay is available once the retry chain has stopped'
                    }
                  >
                    Replay delivery
                  </Button>
                </>
              }
            />

            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Meta label="Attempts" value={attemptProgressLabel(data)} />
              <Meta
                label="Last response"
                value={data.last_status_code ? `HTTP ${data.last_status_code}` : (data.last_error ?? '—')}
              />
              <Meta
                label="Next attempt"
                value={data.next_attempt_at ? formatRelativeTime(data.next_attempt_at) : '—'}
                hint={data.next_attempt_at ? formatTimestamp(data.next_attempt_at) : undefined}
              />
              <Meta
                label="Event"
                value={data.event_type}
                link={`/orgs/${orgId}/projects/${projectId}/events/${data.event_id}`}
              />
            </dl>

            <p className="truncate rounded-md border border-line bg-panel px-3 py-2 font-mono text-2xs text-ink-muted">
              POST {data.endpoint_url}
            </p>

            <Tabs
              aria-label="Delivery detail"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'attempts', label: 'Attempts', badge: data.attempt_count },
                { value: 'request', label: 'Request' },
              ]}
            >
              <div className="pt-4">
                {tab === 'attempts' && (
                  <Async
                    query={attempts}
                    isEmpty={(rows) => rows.length === 0}
                    empty={
                      <EmptyState
                        title="No attempts yet"
                        description="This delivery is queued; the first attempt has not been made."
                      />
                    }
                  >
                    {(rows) => (
                      <ol className="flex flex-col gap-2">
                        {[...rows].reverse().map((attempt) => (
                          <li key={attempt.id}>
                            <AttemptCard attempt={attempt} total={data.max_attempts} />
                          </li>
                        ))}
                      </ol>
                    )}
                  </Async>
                )}
                {tab === 'request' && (
                  <div className="flex flex-col gap-3">
                    <CodeBlock value={data.request_headers} label="request headers" />
                    <CodeBlock value={data.payload} label="request body" showLineNumbers />
                  </div>
                )}
              </div>
            </Tabs>

            <Dialog
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Replay this delivery?"
              description={`A fresh attempt chain is queued for ${data.endpoint_name}.`}
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
                Only this endpoint is retried. The other deliveries for event{' '}
                <code className="font-mono">{data.event_id}</code> are untouched.
              </p>
            </Dialog>
          </>
        )}
      </Async>
    </div>
  );
}

function AttemptCard({ attempt, total }: { attempt: DeliveryAttempt; total: number }) {
  const outcome = attemptOutcome(attempt);

  return (
    <Panel
      flush
      className="border-line"
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-2xs text-ink-subtle">
            #{attempt.attempt_number}/{total}
          </span>
          <Badge tone={outcome.tone} dot>
            {outcome.label}
          </Badge>
        </span>
      }
      actions={
        <span className="flex items-center gap-3 text-2xs text-ink-subtle">
          <span className="tabular">{formatDuration(attempt.duration_ms)}</span>
          <span title={formatTimestamp(attempt.attempted_at)}>
            {formatRelativeTime(attempt.attempted_at)}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 p-3">
        {attempt.error && (
          <p className="rounded border border-danger/25 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs text-danger">
            {attempt.error}
          </p>
        )}
        {attempt.response_headers && (
          <CodeBlock value={attempt.response_headers} label="response headers" maxHeight="8rem" />
        )}
        {attempt.response_body && (
          <CodeBlock
            value={attempt.response_body}
            language="text"
            label="response body"
            maxHeight="12rem"
          />
        )}
        {!attempt.error && !attempt.response_body && (
          <p className="text-xs text-ink-subtle">No response body was returned.</p>
        )}
      </div>
    </Panel>
  );
}

function Meta({
  label,
  value,
  hint,
  link,
}: {
  label: string;
  value: string;
  hint?: string;
  link?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-2.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-1 truncate text-xs text-ink">
        {link ? (
          <Link to={link} className="text-accent hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
      {hint && <dd className="mt-0.5 text-2xs text-ink-subtle">{hint}</dd>}
    </div>
  );
}
