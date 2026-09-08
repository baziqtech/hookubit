import type { Delivery, DeliveryAttempt, DeliveryStatus, EventStatus } from '../types/api';

/**
 * Delivery status derivation.
 *
 * The nine delivery states (ARCHITECTURE.md 19) are what the data plane
 * writes. The dashboard has to answer a different question — "is this done,
 * is it coming back, and does a human need to act?" — so that reduction lives
 * here, once, as pure functions rather than as conditionals scattered through
 * JSX. This is the module the tests care about.
 */

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

/** Coarse bucket a human actually reasons about. */
export type StatusPhase = 'waiting' | 'in_flight' | 'succeeded' | 'failing' | 'dead';

interface StatusMeta {
  label: string;
  tone: StatusTone;
  phase: StatusPhase;
  /** No further transition will happen without operator action. */
  terminal: boolean;
}

const DELIVERY_STATUS_META: Record<DeliveryStatus, StatusMeta> = {
  pending: { label: 'Pending', tone: 'neutral', phase: 'waiting', terminal: false },
  scheduled: { label: 'Scheduled', tone: 'neutral', phase: 'waiting', terminal: false },
  queued: { label: 'Queued', tone: 'neutral', phase: 'waiting', terminal: false },
  processing: { label: 'Processing', tone: 'info', phase: 'in_flight', terminal: false },
  succeeded: { label: 'Succeeded', tone: 'ok', phase: 'succeeded', terminal: true },
  // `failed` is one failed attempt with retries still to come; `exhausted` is
  // the end of the chain. Conflating them is the classic operator-surface bug.
  failed: { label: 'Failed', tone: 'danger', phase: 'failing', terminal: false },
  retrying: { label: 'Retrying', tone: 'warn', phase: 'failing', terminal: false },
  exhausted: { label: 'Exhausted', tone: 'danger', phase: 'dead', terminal: true },
  cancelled: { label: 'Cancelled', tone: 'neutral', phase: 'dead', terminal: true },
};

const EVENT_STATUS_META: Record<EventStatus, StatusMeta> = {
  received: { label: 'Received', tone: 'neutral', phase: 'waiting', terminal: false },
  processing: { label: 'Processing', tone: 'info', phase: 'in_flight', terminal: false },
  processed: { label: 'Processed', tone: 'ok', phase: 'succeeded', terminal: true },
  failed: { label: 'Failed', tone: 'danger', phase: 'dead', terminal: true },
};

export function deliveryStatusMeta(status: DeliveryStatus): StatusMeta {
  return DELIVERY_STATUS_META[status];
}

export function eventStatusMeta(status: EventStatus): StatusMeta {
  return EVENT_STATUS_META[status];
}

export function isTerminal(status: DeliveryStatus): boolean {
  return DELIVERY_STATUS_META[status].terminal;
}

/**
 * Replay is offered when the chain has stopped and did not succeed. Replaying
 * a live delivery would duplicate work the data plane is already doing, and
 * replaying a success is almost always an accident.
 */
export function canReplay(delivery: Pick<Delivery, 'status'>): boolean {
  return delivery.status === 'exhausted' || delivery.status === 'cancelled';
}

/** Attempts remaining in the chain; never negative, even on bad data. */
export function attemptsRemaining(
  delivery: Pick<Delivery, 'status' | 'attempt_count' | 'max_attempts'>,
): number {
  if (isTerminal(delivery.status)) return 0;
  return Math.max(0, delivery.max_attempts - delivery.attempt_count);
}

/** "Attempt 3 of 8" — reads the same everywhere it appears. */
export function attemptProgressLabel(
  delivery: Pick<Delivery, 'attempt_count' | 'max_attempts'>,
): string {
  return `Attempt ${delivery.attempt_count} of ${delivery.max_attempts}`;
}

/**
 * The one-line answer to "what happened to this delivery?", which is the
 * question the operator surface exists to answer (CLAUDE.md, "The hard part").
 */
export function describeDelivery(
  delivery: Pick<
    Delivery,
    'status' | 'attempt_count' | 'max_attempts' | 'last_status_code' | 'last_error'
  >,
): string {
  const { status, last_status_code: code, last_error: error } = delivery;

  switch (status) {
    case 'succeeded':
      return code
        ? `Delivered with HTTP ${code} after ${plural(delivery.attempt_count, 'attempt')}`
        : 'Delivered';
    case 'exhausted':
      return `Gave up after ${plural(delivery.attempt_count, 'attempt')}${describeCause(code, error)}`;
    case 'retrying':
      return `Retrying, ${plural(attemptsRemaining(delivery), 'attempt')} left${describeCause(code, error)}`;
    case 'failed':
      return `Attempt ${delivery.attempt_count} failed${describeCause(code, error)}`;
    case 'cancelled':
      return 'Cancelled before delivery';
    case 'processing':
      return 'Request in flight';
    case 'queued':
      return 'Queued for a worker';
    case 'scheduled':
      return 'Scheduled for a later attempt';
    case 'pending':
      return 'Awaiting dispatch';
  }
}

function describeCause(code: number | null, error: string | null): string {
  if (code) return ` — HTTP ${code}`;
  if (error) return ` — ${error}`;
  return '';
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Whether a response code would be retried, mirroring the data plane's rule so
 * the dashboard never claims a retry that will not happen: 408/429/5xx retry,
 * every other 4xx is permanent (docs/API.md, "Outbound delivery").
 */
export function isRetryableStatusCode(code: number | null): boolean {
  if (code === null) return true; // transport failure, no response at all
  if (code >= 500) return true;
  return code === 408 || code === 429;
}

export function attemptOutcome(attempt: DeliveryAttempt): {
  label: string;
  tone: StatusTone;
} {
  if (attempt.status_code === null) {
    return { label: attempt.error ?? 'No response', tone: 'danger' };
  }
  if (attempt.status_code >= 200 && attempt.status_code < 300) {
    return { label: `${attempt.status_code}`, tone: 'ok' };
  }
  return {
    label: `${attempt.status_code}`,
    tone: isRetryableStatusCode(attempt.status_code) ? 'warn' : 'danger',
  };
}

/**
 * Roll a set of deliveries up into the health line shown on an event row.
 * Counts are derived rather than trusted so a stale denormalised counter can
 * never make the UI disagree with the delivery list beneath it.
 */
export function summarizeDeliveries(deliveries: Pick<Delivery, 'status'>[]): {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  exhausted: number;
} {
  const summary = { total: deliveries.length, succeeded: 0, failed: 0, pending: 0, exhausted: 0 };

  for (const { status } of deliveries) {
    const { phase } = DELIVERY_STATUS_META[status];
    if (phase === 'succeeded') summary.succeeded += 1;
    else if (status === 'exhausted') summary.exhausted += 1;
    else if (phase === 'dead') summary.failed += 1;
    else if (phase === 'failing') summary.failed += 1;
    else summary.pending += 1;
  }
  return summary;
}

/** Worst status in a set, so an event row leads with the thing that needs attention. */
export function worstStatus(statuses: DeliveryStatus[]): DeliveryStatus | null {
  const severity: DeliveryStatus[] = [
    'exhausted',
    'failed',
    'retrying',
    'cancelled',
    'pending',
    'scheduled',
    'queued',
    'processing',
    'succeeded',
  ];
  for (const candidate of severity) {
    if (statuses.includes(candidate)) return candidate;
  }
  return null;
}

/* ── Diagnosis ────────────────────────────────────────────────────────────── */

/**
 * Why an attempt failed, at the level of detail that changes what you do next.
 *
 * The distinction that matters most is `transport` versus the HTTP kinds. A
 * transport failure — DNS, TLS, connect timeout — carries NO STATUS CODE AT
 * ALL, because there was never a response. A UI that renders "HTTP null" or
 * quietly shows an empty cell for those is useless in exactly the incident
 * where it is needed, and the mock fixtures include DNS and TLS failures
 * specifically so this path cannot go untested.
 */
export type FailureKind = 'none' | 'transport' | 'http_retryable' | 'http_permanent';

export function classifyFailure(code: number | null, error: string | null): FailureKind {
  if (code === null) return error ? 'transport' : 'none';
  if (code >= 200 && code < 300) return 'none';
  return isRetryableStatusCode(code) ? 'http_retryable' : 'http_permanent';
}

/** A short, plain-English name for the failure — the column heading version. */
export function failureKindLabel(kind: FailureKind): string {
  switch (kind) {
    case 'transport':
      return 'No HTTP response';
    case 'http_retryable':
      return 'Temporary HTTP failure';
    case 'http_permanent':
      return 'Permanent HTTP failure';
    case 'none':
      return 'No failure';
  }
}

/**
 * What the failure means, in a sentence an operator can act on.
 *
 * The transport case names the three usual culprits, because "i/o timeout"
 * alone does not tell someone whose problem it is — and in practice it is
 * nearly always the consumer's DNS, firewall or certificate rather than ours.
 */
export function explainFailure(kind: FailureKind, code: number | null): string {
  switch (kind) {
    case 'transport':
      return 'The request never reached an HTTP server, so there is no status code — the name did not resolve, the connection was refused or timed out, or the TLS handshake failed. Check DNS, firewall rules and the certificate on the receiving host.';
    case 'http_retryable':
      return `The endpoint answered ${code}. Codes 408, 429 and 5xx are treated as temporary, so this delivery is retried with exponential backoff.`;
    case 'http_permanent':
      return `The endpoint answered ${code}. Every 4xx other than 408 and 429 is treated as permanent — retrying would produce the same answer — so the chain stops here. A 401 or 403 usually means signature verification is failing on the consumer.`;
    case 'none':
      return 'The endpoint accepted the delivery.';
  }
}

/** One plain-English sentence per delivery state, for the glossary. */
export const DELIVERY_STATUS_SENTENCE: Record<DeliveryStatus, string> = {
  pending: 'Created, but not yet handed to the queue.',
  scheduled: 'Waiting for a specific time before its next attempt — usually a retry backoff.',
  queued: 'Waiting for a free worker. No request has been made yet.',
  processing: 'A request is in flight to the endpoint right now.',
  succeeded: 'The endpoint answered 2xx. Nothing further will happen.',
  failed: 'The latest attempt failed and more attempts remain. It will be retried.',
  retrying: 'A previous attempt failed and the next one is already scheduled.',
  exhausted: 'Every attempt was used and none succeeded. Nothing further will happen without a replay.',
  cancelled: 'Stopped before it finished — the endpoint was deleted, or an operator cancelled it.',
};

export interface DeliveryDiagnosis {
  /** The one-line answer, for the top of the page. */
  headline: string;
  kind: FailureKind;
  /** What the failure means and who is likely to own it. */
  explanation: string;
  /** What happens next, stated definitively. */
  next: string;
  tone: StatusTone;
}

/**
 * "What happened to this delivery, and what happens now?" as one value.
 *
 * This is the question the operator surface exists to answer, so it is derived
 * once, here, rather than assembled out of conditionals in JSX where the
 * exhausted case and the permanent-4xx case would inevitably drift apart.
 */
export function diagnoseDelivery(
  delivery: Pick<
    Delivery,
    'status' | 'attempt_count' | 'max_attempts' | 'last_status_code' | 'last_error' | 'terminal'
  >,
): DeliveryDiagnosis {
  const kind = classifyFailure(delivery.last_status_code, delivery.last_error);
  const meta = deliveryStatusMeta(delivery.status);
  const explanation = explainFailure(kind, delivery.last_status_code);

  switch (delivery.status) {
    case 'succeeded':
      return {
        headline: `Delivered after ${plural(delivery.attempt_count, 'attempt')}.`,
        kind: 'none',
        explanation: 'The endpoint answered 2xx.',
        next: 'Nothing further. This delivery is complete.',
        tone: 'ok',
      };
    case 'exhausted':
      return {
        headline: `Gave up after all ${delivery.max_attempts} attempts.`,
        kind,
        explanation,
        next: 'No further attempt will be made. Replay it once the endpoint is fixed — only this endpoint is retried, not the others on the same event.',
        tone: 'danger',
      };
    case 'cancelled':
      return {
        headline: 'Cancelled before it completed.',
        kind,
        explanation:
          'The chain was stopped deliberately — the endpoint was deleted or disabled, or an operator cancelled it.',
        next: 'No further attempt will be made. Replay it if it should still be delivered.',
        tone: 'neutral',
      };
    case 'retrying':
    case 'scheduled':
      return {
        headline: `Attempt ${delivery.attempt_count} failed. ${plural(attemptsRemaining(delivery), 'attempt')} left.`,
        kind,
        explanation,
        next: 'Another attempt is scheduled. If every remaining attempt fails, the delivery becomes exhausted and stops.',
        tone: 'warn',
      };
    case 'failed':
      return {
        headline: `Attempt ${delivery.attempt_count} failed.`,
        kind,
        explanation,
        next:
          kind === 'http_permanent'
            ? 'This response is not retried. The chain will not continue on its own.'
            : 'A retry is expected shortly.',
        tone: 'danger',
      };
    case 'processing':
      return {
        headline: 'A request is in flight right now.',
        kind: 'none',
        explanation: 'The endpoint has been called and has not answered yet.',
        next: `The result lands as attempt ${delivery.attempt_count} of ${delivery.max_attempts}.`,
        tone: meta.tone,
      };
    default:
      return {
        headline: describeDelivery(delivery),
        kind: 'none',
        explanation: 'No attempt has been made yet.',
        next: 'The first attempt happens as soon as a worker picks it up.',
        tone: meta.tone,
      };
  }
}
