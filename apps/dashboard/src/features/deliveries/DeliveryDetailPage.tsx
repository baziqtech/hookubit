import { useState, type ReactNode } from 'react';
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
  attemptsRemaining,
  canReplay,
  classifyFailure,
  diagnoseDelivery,
  failureKindLabel,
  type FailureKind,
} from '../../lib/delivery-status';
import { formatDuration, formatRelativeTime, formatTimestamp, truncateId } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { Delivery, DeliveryAttempt, DeliveryDetail, Endpoint } from '../../types/api';
import { useEndpoint } from '../endpoints/api';
import { EndpointActions } from '../endpoints/EndpointActions';
import { useEventDeliveries } from '../events/api';
import { useDelivery, useDeliveryAttempts, useReplayDelivery } from './api';

/**
 * "What happened to this delivery?" — the whole reason the operator surface
 * exists, and the page the product is judged on at 2am.
 *
 * The bar is that the cause is obvious in under five seconds, so the page leads
 * with a written diagnosis rather than with metadata. Four things have to be
 * true of it, and the fixtures are built to break a page that only handles the
 * first:
 *
 *   - A transport failure (DNS, TLS, connect timeout) has NO STATUS CODE. It
 *     cannot be rendered as "HTTP —".
 *   - A permanent 4xx will never be retried, and saying "4 attempts left" over
 *     one is a lie the page must not tell.
 *   - A delivery can say "retrying" while its ENDPOINT has been auto-disabled
 *     by the circuit breaker, in which case nothing is going to retry. That
 *     cross-check is the single most valuable fact on this page and it lives on
 *     a different resource, so it has to be fetched deliberately.
 *   - One event fans out to several deliveries. "Did finance get it?" is
 *     answered by the siblings, so they are on the page rather than two clicks
 *     away.
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
              description={
                <span className="font-mono text-2xs text-ink-subtle">
                  POST {data.endpoint_url}
                </span>
              }
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

            <Diagnosis delivery={data} />
            <EndpointHealthCheck delivery={data} orgId={orgId} projectId={projectId} />
            <RetrySchedule delivery={data} />

            <Tabs
              aria-label="Delivery detail"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'attempts', label: 'Attempts', badge: data.attempt_count },
                { value: 'siblings', label: 'Same event' },
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
                        description="This delivery is queued and the first request has not been made. Attempts appear here as soon as a worker picks it up."
                      />
                    }
                  >
                    {(rows) => (
                      <ol className="flex flex-col gap-2">
                        {/* Newest first: in an incident you want the last thing that happened. */}
                        {[...rows].reverse().map((attempt) => (
                          <li key={attempt.id}>
                            <AttemptCard attempt={attempt} total={data.max_attempts} />
                          </li>
                        ))}
                      </ol>
                    )}
                  </Async>
                )}
                {tab === 'siblings' && (
                  <SiblingDeliveries
                    delivery={data}
                    orgId={orgId}
                    projectId={projectId}
                  />
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

/**
 * The five-second answer.
 *
 * Deliberately the first thing under the title, written as sentences rather
 * than as a grid of fields: "HTTP 504 / 8 / 8 / —" requires the reader to
 * already know how this system works, which is the assumption that makes
 * operator surfaces unusable to everyone except the person who built them.
 */
function Diagnosis({ delivery }: { delivery: DeliveryDetail }) {
  const diagnosis = diagnoseDelivery(delivery);

  const tone = {
    ok: 'border-ok/30 bg-ok-soft/50',
    warn: 'border-warn/30 bg-warn-soft/50',
    danger: 'border-danger/30 bg-danger-soft/50',
    info: 'border-info/30 bg-info-soft/50',
    neutral: 'border-line bg-raised/50',
  }[diagnosis.tone];

  return (
    <section className={cn('rounded-lg border px-4 py-3.5', tone)} aria-label="Diagnosis">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">{diagnosis.headline}</h2>
        {diagnosis.kind !== 'none' && (
          <FailureBadge kind={diagnosis.kind} code={delivery.last_status_code} />
        )}
      </div>

      <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-muted">
        {diagnosis.explanation}
      </p>

      {/*
        The raw transport error, verbatim. It is the string an operator pastes
        into a support thread with the consumer's team, so it is never
        paraphrased and never truncated away.
      */}
      {delivery.last_error && (
        <p className="mt-2 overflow-x-auto rounded border border-line bg-panel px-2.5 py-1.5 font-mono text-2xs text-ink">
          {delivery.last_error}
        </p>
      )}

      <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink">
        <span
          aria-hidden="true"
          className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current opacity-60"
        />
        <span>
          <span className="font-medium">What happens next: </span>
          <span className="text-ink-muted">{diagnosis.next}</span>
        </span>
      </p>
    </section>
  );
}

function FailureBadge({ kind, code }: { kind: FailureKind; code: number | null }) {
  const tone = kind === 'http_retryable' ? 'warn' : kind === 'none' ? 'ok' : 'danger';
  return (
    <Badge tone={tone}>
      {/* A transport failure has no code to show, and inventing one would be worse than none. */}
      {code === null ? failureKindLabel(kind) : `HTTP ${code} · ${failureKindLabel(kind)}`}
    </Badge>
  );
}

/**
 * The cross-check that is the difference between a page that looks informative
 * and one that is.
 *
 * `enabled` is operator intent; `status` is the circuit breaker's verdict. An
 * endpoint that has failed twenty times consecutively reads `enabled: true,
 * status: 'disabled'` — nobody chose that, the platform did — and every
 * delivery queued against it will sit at "retrying" without a single further
 * request being made. Without this panel the operator waits for a retry that is
 * never coming.
 */
function EndpointHealthCheck({
  delivery,
  orgId,
  projectId,
}: {
  delivery: Delivery;
  orgId: string;
  projectId: string;
}) {
  const endpoint = useEndpoint(projectId, delivery.endpoint_id);

  // Silence is correct while loading or on error: a missing warning is better
  // than a wrong one, and the endpoint list is one click away regardless.
  if (!endpoint.data) return null;
  const target: Endpoint = endpoint.data;
  const healthy = target.enabled && target.status === 'active';
  if (healthy) return null;
  if (delivery.terminal) return null;

  const autoDisabled = target.enabled && target.status === 'disabled';

  return (
    <section
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger-soft/60 px-4 py-3"
    >
      <h2 className="text-xs font-semibold text-danger">
        {autoDisabled
          ? 'No retry will run — the circuit breaker has disabled this endpoint'
          : `No retry will run — this endpoint is ${target.status}`}
      </h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">
        This delivery still shows as <strong className="text-ink">{delivery.status}</strong>, but{' '}
        <span className="font-medium text-ink">{target.name}</span> is not accepting deliveries, so
        the scheduled attempt will not be made until it is back.
      </p>
      {target.disabled_reason && (
        <p className="mt-2 rounded border border-line bg-panel px-2.5 py-1.5 text-2xs text-ink-muted">
          {target.disabled_reason}
          {target.disabled_at && (
            <span className="text-ink-subtle">
              {' '}
              · {formatRelativeTime(target.disabled_at)} ({formatTimestamp(target.disabled_at)})
            </span>
          )}
        </p>
      )}
      {/*
        The cure, next to the diagnosis.

        Until this existed the panel was a dead end: it named the problem
        precisely and then required the operator to leave, find the endpoint by
        name in a paged table, and act there — which at 2am is where the useful
        page stopped being useful. The wording is deliberate and is explained in
        `EndpointActions`: an endpoint the BREAKER disabled offers "Resume
        deliveries anyway", because resuming does not repair the consumer that
        caused it, and one a PERSON paused offers a plain "Resume deliveries".
      */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <EndpointActions endpoint={target} projectId={projectId} />
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/endpoints`}
          className="text-xs font-medium text-accent hover:underline"
        >
          Review {target.name} →
        </Link>
      </div>
    </section>
  );
}

/**
 * The retry chain as a progress read-out.
 *
 * "Attempt 3 of 8" and "next attempt in 14 minutes" are the two facts someone
 * checks before deciding whether to wait or to intervene, so they are stated
 * both relatively (how long do I wait) and absolutely (what do I put in the
 * incident timeline).
 */
function RetrySchedule({ delivery }: { delivery: DeliveryDetail }) {
  const remaining = attemptsRemaining(delivery);
  const nextAt = !delivery.terminal ? delivery.next_attempt_at : null;

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Meta
        label="Attempts"
        value={attemptProgressLabel(delivery)}
        hint={
          delivery.terminal
            ? 'The chain has stopped.'
            : `${remaining} of ${delivery.max_attempts} still available`
        }
      >
        <AttemptPips
          used={delivery.attempt_count}
          total={delivery.max_attempts}
          terminal={delivery.terminal}
        />
      </Meta>

      <Meta
        label="Last response"
        value={
          delivery.last_status_code
            ? `HTTP ${delivery.last_status_code}`
            : delivery.last_error
              ? 'No response'
              : '—'
        }
        hint={delivery.last_error ?? undefined}
      />

      <Meta
        label="Next attempt"
        value={nextAt ? formatRelativeTime(nextAt) : delivery.terminal ? 'None — chain stopped' : '—'}
        hint={nextAt ? formatTimestamp(nextAt) : undefined}
      />

      <Meta
        label="Completed"
        value={delivery.completed_at ? formatRelativeTime(delivery.completed_at) : 'Not yet'}
        hint={delivery.completed_at ? formatTimestamp(delivery.completed_at) : undefined}
      />
    </dl>
  );
}

/**
 * Eight small marks rather than a bar: the number of attempts is small and
 * discrete, and "three filled, five hollow" is read at a glance without
 * decoding a percentage.
 */
function AttemptPips({
  used,
  total,
  terminal,
}: {
  used: number;
  total: number;
  terminal: boolean;
}) {
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-1.5 w-4 rounded-full',
            index < used ? (terminal ? 'bg-danger' : 'bg-warn') : 'bg-line-strong/60',
          )}
        />
      ))}
    </span>
  );
}

/**
 * The other deliveries created by the same event.
 *
 * This is where the fan-out model stops being an abstraction: one publish, one
 * row per matching subscription, each with an independent chain. "Did finance
 * ever receive this?" is answered here, and the failure of a partner endpoint
 * is visibly not the failure of the ledger.
 */
function SiblingDeliveries({
  delivery,
  orgId,
  projectId,
}: {
  delivery: Delivery;
  orgId: string;
  projectId: string;
}) {
  const siblings = useEventDeliveries(delivery.event_id);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-ink-muted">
        Event{' '}
        <Link
          to={`/orgs/${orgId}/projects/${projectId}/events/${delivery.event_id}`}
          className="font-mono text-accent hover:underline"
        >
          {delivery.event_id}
        </Link>{' '}
        was published once and fanned out to one delivery per matching subscription. Each has its
        own retry chain, and replaying one does not touch the others.
      </p>

      <Async
        query={siblings}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title="No sibling deliveries" />}
      >
        {(rows) => (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => {
              const isThis = row.id === delivery.id;
              return (
                <li key={row.id}>
                  <Link
                    to={`/orgs/${orgId}/projects/${projectId}/deliveries/${row.id}`}
                    aria-current={isThis ? 'page' : undefined}
                    className={cn(
                      'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 transition-colors',
                      isThis
                        ? 'border-accent/50 bg-accent-soft/40'
                        : 'border-line bg-panel hover:border-line-strong',
                    )}
                  >
                    <span className="text-xs font-medium text-ink">{row.endpoint_name}</span>
                    <DeliveryStatusBadge status={row.status} />
                    <span className="text-2xs text-ink-subtle">
                      {row.attempt_count}/{row.max_attempts} attempts
                    </span>
                    {isThis && (
                      <span className="ml-auto text-2xs font-medium text-accent">
                        You are here
                      </span>
                    )}
                    {!isThis && (
                      <span className="ml-auto font-mono text-2xs text-ink-subtle">
                        {truncateId(row.id)}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
    </div>
  );
}

function AttemptCard({ attempt, total }: { attempt: DeliveryAttempt; total: number }) {
  const outcome = attemptOutcome(attempt);
  const kind = classifyFailure(attempt.status_code, attempt.error);

  return (
    <Panel
      flush
      className="border-line"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-2xs text-ink-subtle">
            #{attempt.attempt_number}/{total}
          </span>
          {/*
            For a transport failure `attemptOutcome` returns the raw error as
            the badge label, which is long and duplicates the body below. Show
            the KIND here instead and let the body carry the verbatim string.
          */}
          <Badge tone={outcome.tone} dot>
            {attempt.status_code === null ? failureKindLabel(kind) : outcome.label}
          </Badge>
          {kind === 'http_permanent' && <Badge tone="danger">not retried</Badge>}
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
          <p className="overflow-x-auto rounded border border-danger/25 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs text-danger">
            {attempt.error}
          </p>
        )}
        {attempt.status_code === null && (
          <p className="text-2xs leading-relaxed text-ink-subtle">
            No HTTP response was received, so there is no status code and no response body — the
            request failed before the endpoint could answer.
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
        {attempt.status_code !== null && !attempt.response_body && (
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
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-2.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-1 text-xs text-ink">{value}</dd>
      {children}
      {hint && <dd className="mt-1 text-2xs leading-relaxed text-ink-subtle">{hint}</dd>}
    </div>
  );
}
