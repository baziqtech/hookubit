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
  deliveryOutcome,
  diagnoseDelivery,
  failureKindLabel,
  type DeliveryOutcome,
  type FailureKind,
} from '../../lib/delivery-status';
import { formatDuration, formatRelativeTime, formatTimestamp, truncateId } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { Delivery, DeliveryAttempt, DeliveryDetail, Endpoint } from '../../types/api';
import { useEndpoint, useEndpoints } from '../endpoints/api';
import { EndpointActions } from '../endpoints/EndpointActions';
import { useEventDeliveries } from '../events/api';
import { useDelivery, useDeliveryAttempts, useReplayDelivery } from './api';
import { attemptHistoryState, attemptsWerePruned } from './pruned';

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
 *   - One event routes to several deliveries. "Did finance get it?" is
 *     answered by the siblings, so they are on the page rather than two clicks
 *     away.
 */
export function DeliveryDetailPage() {
  const { orgId = '', projectId = '', deliveryId = '' } = useParams();
  const delivery = useDelivery(projectId, deliveryId);
  /*
   * The attempt history is EMBEDDED in the detail response, so the common case
   * costs no second request. `attempts_truncated` says when the embedded array
   * is not the whole story, and only then is the paged `…/attempts` route
   * fetched — rendering a truncated history as a complete one, on the screen
   * whose entire job is "what happened to this delivery", is the worst possible
   * place to be quietly incomplete.
   */
  const truncated = delivery.data?.attempts_truncated === true;
  const moreAttempts = useDeliveryAttempts(projectId, deliveryId, truncated);
  const replay = useReplayDelivery(projectId, deliveryId);
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
              title={data.endpoint.name}
              description={
                <span className="font-mono text-2xs text-ink-subtle">POST {data.endpoint.url}</span>
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

            <Diagnosis
              delivery={data}
              outcome={outcomeOf(data, moreAttempts.data?.rows)}
              pruned={attemptsWerePruned(data, moreAttempts.data?.rows ?? data.attempts)}
            />
            <EndpointHealthCheck delivery={data} orgId={orgId} projectId={projectId} />
            <RetrySchedule
              delivery={data}
              outcome={outcomeOf(data, moreAttempts.data?.rows)}
              pruned={attemptsWerePruned(data, moreAttempts.data?.rows ?? data.attempts)}
            />

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
                  <AttemptHistory
                    embedded={data.attempts}
                    paged={moreAttempts.data?.rows}
                    truncated={data.attempts_truncated}
                    total={data.max_attempts}
                    delivery={data}
                  />
                )}
                {tab === 'siblings' && (
                  <SiblingDeliveries delivery={data} orgId={orgId} projectId={projectId} />
                )}
                {tab === 'request' && (
                  <RequestTab delivery={data} orgId={orgId} projectId={projectId} />
                )}
              </div>
            </Tabs>

            <Dialog
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Replay this delivery?"
              description={`A fresh attempt chain is queued for ${data.endpoint.name}.`}
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
/**
 * `outcomeOf` is the join the wire no longer does for us.
 *
 * `DeliveryDto` has no `last_status_code` — the code only ever existed on an
 * attempt, as `http_status` — so the diagnosis is built from the row plus the
 * attempts in hand. On the detail page there always are some; on the list page
 * there are none, and the diagnosis degrades to "no HTTP response", which is
 * the honest reading rather than a fabricated code.
 */
function outcomeOf(delivery: DeliveryDetail, extra?: DeliveryAttempt[]): DeliveryOutcome {
  return deliveryOutcome(delivery, extra ?? delivery.attempts);
}

function Diagnosis({
  delivery,
  outcome,
  pruned = false,
}: {
  delivery: DeliveryDetail;
  outcome: DeliveryOutcome;
  /** Retention reclaimed the attempts, so `outcome.last_status_code` is unknown, not null. */
  pruned?: boolean;
}) {
  const diagnosis = diagnoseDelivery(outcome);
  /*
   * With no attempts in hand `classifyFailure` reads a null code plus an error
   * as a TRANSPORT failure — correct for a list row, wrong for a pruned one,
   * where the code existed and was reclaimed. The explanation must not claim
   * "the request never reached an HTTP server" about a delivery that may have
   * been answered 503 five times.
   */
  const codeUnknown = pruned && diagnosis.kind === 'transport';

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
        {codeUnknown ? (
          <Badge tone="neutral">attempt detail reclaimed</Badge>
        ) : (
          diagnosis.kind !== 'none' && (
            <FailureBadge kind={diagnosis.kind} code={outcome.last_status_code} />
          )
        )}
      </div>

      <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-muted">
        {codeUnknown
          ? `The per-attempt detail was reclaimed by retention on ${formatTimestamp(delivery.attempts_pruned_at)}, so whether this was an HTTP failure or a transport failure can no longer be read from the attempts. The last error the worker recorded is below; it is the only per-attempt fact that survives.`
          : diagnosis.explanation}
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
 * endpoint that has failed five times consecutively (the breaker's open threshold) reads `enabled: true,
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
function RetrySchedule({
  delivery,
  outcome,
  pruned = false,
}: {
  delivery: DeliveryDetail;
  outcome: DeliveryOutcome;
  pruned?: boolean;
}) {
  const remaining = attemptsRemaining(outcome);
  const nextAt = !delivery.terminal ? delivery.next_attempt_at : null;

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Meta
        label="Attempts"
        value={attemptProgressLabel(outcome)}
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
          outcome.last_status_code
            ? `HTTP ${outcome.last_status_code}`
            : pruned
              ? 'Unknown — detail reclaimed'
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
 * This is where the routing model stops being an abstraction: one publish, one
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
  const siblings = useEventDeliveries(projectId, delivery.event_id);
  // A delivery row has no endpoint NAME. It is joined from the endpoint list,
  // and a sibling whose endpoint is off the first page falls back to its id.
  const endpoints = useEndpoints(projectId);
  const endpointNames = new Map(
    (endpoints.data?.rows ?? []).map((endpoint) => [endpoint.id, endpoint.name]),
  );

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
        was published once and routed to one delivery per matching subscription. Each has its
        own retry chain, and replaying one does not touch the others.
      </p>

      <Async
        query={siblings}
        isEmpty={(page) => page.rows.length === 0}
        empty={<EmptyState title="No sibling deliveries" />}
      >
        {(page) => (
          <ul className="flex flex-col gap-1.5">
            {page.rows.map((row) => {
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
                    <span className="text-xs font-medium text-ink">
                      {endpointNames.get(row.endpoint_id) ?? truncateId(row.endpoint_id)}
                    </span>
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
  // `http_status` / `error_message`, not `status_code` / `error`.
  const kind = classifyFailure(attempt.http_status, attempt.error_message);

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
            {attempt.http_status === null ? failureKindLabel(kind) : outcome.label}
          </Badge>
          {kind === 'http_permanent' && <Badge tone="danger">not retried</Badge>}
        </span>
      }
      actions={
        <span className="flex items-center gap-3 text-2xs text-ink-subtle">
          <span className="tabular">
            {/* Null while the attempt is still in flight — there is no duration yet. */}
            {attempt.duration_ms === null ? 'in flight' : formatDuration(attempt.duration_ms)}
          </span>
          <span title={formatTimestamp(attempt.started_at)}>
            {formatRelativeTime(attempt.started_at)}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 p-3">
        {attempt.error_message && (
          <p className="overflow-x-auto rounded border border-danger/25 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs text-danger">
            {attempt.error_code && (
              <span className="mr-1.5 font-semibold opacity-80">{attempt.error_code}</span>
            )}
            {attempt.error_message}
          </p>
        )}
        {attempt.http_status === null && (
          <p className="text-2xs leading-relaxed text-ink-subtle">
            No HTTP response was received, so there is no status code and no response body — the
            request failed before the endpoint could answer.
          </p>
        )}
        {attempt.trace_id && (
          <p className="text-2xs text-ink-subtle">
            <span className="mr-1.5 font-semibold">trace</span>
            <code className="select-all font-mono">{attempt.trace_id}</code>
            <span className="ml-1.5">— look it up in your tracing backend; only sampled attempts carry one.</span>
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
        {/*
          A body can be absent for two different reasons and the page must not
          collapse them: nothing was returned, or the bytes were offloaded and
          the row carries only a location. `response_size` is the count on the
          wire, so a large body that is not inline still reports its size.
        */}
        {attempt.http_status !== null && !attempt.response_body && (
          <p className="text-xs text-ink-subtle">
            {attempt.response_body_location
              ? `The response body was not returned inline. ${
                  attempt.response_size === null
                    ? 'It is held in object storage.'
                    : `${attempt.response_size} bytes are held in object storage.`
                }`
              : 'No response body was returned.'}
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * The attempt history, embedded-first.
 *
 * `attempts_truncated` is read rather than assumed away. When it is true the
 * paged route supplies the rest and the panel says the list was truncated
 * before the extra page lands, so nobody reads a partial history as a whole one
 * in the seconds between.
 */
export function AttemptHistory({
  embedded,
  paged,
  truncated,
  total,
  delivery,
}: {
  embedded: DeliveryAttempt[];
  paged?: DeliveryAttempt[];
  truncated: boolean;
  total: number;
  /** For `attempts_pruned_at` — read BEFORE the array, per the DTO. */
  delivery: Pick<Delivery, 'attempts_pruned_at' | 'attempt_count'>;
}) {
  const rows = paged ?? embedded;
  const history = attemptHistoryState(delivery, rows);

  if (history.kind === 'pruned') {
    return <PrunedAttempts prunedAt={history.prunedAt} attemptCount={history.attemptCount} />;
  }

  if (history.kind === 'none') {
    return (
      <EmptyState
        title="No attempts yet"
        description="This delivery is queued and the first request has not been made. Attempts appear here as soon as a worker picks it up."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {history.prunedAt && (
        <p className="rounded-md border border-line bg-raised px-3 py-1.5 text-2xs text-ink-muted">
          Retention reclaimed part of this history on {formatTimestamp(history.prunedAt)}; what is
          below is what survived.
        </p>
      )}
      {truncated && paged === undefined && (
        <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-1.5 text-2xs text-warn">
          This delivery has more attempts than the detail response carries. Loading the full
          history — what is below is not all of it.
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {/* Newest first: in an incident you want the last thing that happened. */}
        {[...rows]
          .sort((a, b) => b.attempt_number - a.attempt_number)
          .map((attempt) => (
            <li key={attempt.id}>
              <AttemptCard attempt={attempt} total={total} />
            </li>
          ))}
      </ol>
    </div>
  );
}

/**
 * The reclaimed state, said out loud.
 *
 * "We tried five times and the detail was removed on this date" is a
 * different sentence from "no attempts yet", and on the page whose whole job
 * is "what happened to this delivery" the two must never share a rendering.
 * The count and the outcome are still the record; only the bytes are gone.
 */
export function PrunedAttempts({
  prunedAt,
  attemptCount,
}: {
  prunedAt: string;
  attemptCount: number;
}) {
  const made = attemptCount === 1 ? '1 attempt was made' : `${attemptCount} attempts were made`;
  return (
    <section
      data-testid="attempts-pruned"
      aria-label="Attempt history reclaimed"
      className="rounded-lg border border-line bg-raised/60 px-4 py-3.5"
    >
      <h3 className="text-xs font-semibold text-ink">
        {attemptCount === 0
          ? 'The attempt detail was reclaimed by retention'
          : `${made}; the detail was reclaimed by retention`}
      </h3>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">
        The per-attempt record — request and response headers, bodies, status codes and timings —
        was removed on{' '}
        <span className="font-medium text-ink" title={prunedAt}>
          {formatTimestamp(prunedAt)}
        </span>{' '}
        ({formatRelativeTime(prunedAt)}). Attempts carry the bytes and are kept for a shorter
        window than this summary row, which is why the count survives and the detail does not.
      </p>
      <p className="mt-1.5 text-2xs text-ink-subtle">
        This is not a delivery that was never tried. The status, the attempt count and the last
        error above are still the record of what happened.
      </p>
    </section>
  );
}

/**
 * The request, as far as the API can describe it — and an honest statement of
 * where it cannot.
 *
 * `DeliveryDetailDto` carries NEITHER the request headers NOR the payload. The
 * page used to render `delivery.request_headers` and `delivery.payload`, and
 * both were the mock's invention. What does exist is per-ATTEMPT
 * `request_headers` (the signature changes every attempt, so this is the more
 * accurate place for them anyway) and the payload on the EVENT, one link away.
 */
function RequestTab({
  delivery,
  orgId,
  projectId,
}: {
  delivery: DeliveryDetail;
  orgId: string;
  projectId: string;
}) {
  const latest = [...delivery.attempts].sort(
    (a, b) => b.attempt_number - a.attempt_number,
  )[0];

  return (
    <div className="flex flex-col gap-3">
      {latest?.request_headers ? (
        <>
          <p className="text-2xs leading-relaxed text-ink-subtle">
            Headers sent on attempt #{latest.attempt_number}. The signature is recomputed per
            attempt, so earlier attempts carry different <code className="font-mono">
              Webhook-Signature
            </code>{' '}
            and <code className="font-mono">Webhook-Timestamp</code> values — open an attempt above
            to see its own.
          </p>
          <CodeBlock value={latest.request_headers} label="request headers" />
        </>
      ) : (
        <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-muted">
          {delivery.attempts_pruned_at
            ? `The request headers were reclaimed with the attempt detail on ${formatTimestamp(delivery.attempts_pruned_at)}.`
            : 'No attempt has recorded its request headers yet.'}
        </p>
      )}

      <div className="rounded-md border border-line bg-raised px-3 py-2.5">
        <h3 className="text-xs font-semibold text-ink">The body is on the event</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          A delivery does not carry the payload — it is published once on the event and every
          delivery for that event sends the same bytes, so it is stored once.{' '}
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/events/${delivery.event.id}`}
            className="font-medium text-accent hover:underline"
          >
            Open {delivery.event.event_type} →
          </Link>
        </p>
      </div>
    </div>
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
