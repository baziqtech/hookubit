import { Badge } from '../../components';
import type { StatusTone } from '../../lib/delivery-status';
import type { OutboxStatus } from '../../types/api';

/**
 * The four outbox states, labelled for an operator rather than for the router.
 *
 * `failed` is the one that matters and it is NOT labelled "failed": a delivery
 * that failed will be retried, an outbox row that "failed" never will. It is
 * PARKED, and the word is chosen so the two cannot be confused in a table that
 * sits one click from the deliveries list.
 */
const META: Record<OutboxStatus, { label: string; tone: StatusTone; pulse?: boolean }> = {
  pending: { label: 'Queued', tone: 'neutral' },
  processing: { label: 'Fanning out', tone: 'info', pulse: true },
  processed: { label: 'Fanned out', tone: 'ok' },
  failed: { label: 'Parked', tone: 'danger' },
};

export const OUTBOX_STATUS_SENTENCE: Record<OutboxStatus, string> = {
  pending: 'Waiting for a router to claim it — possibly in a backoff, possibly mid-fan-out.',
  processing: 'A router holds the lease and is writing delivery rows right now.',
  processed: 'Fan-out completed. Every matching subscription has its delivery row.',
  failed:
    'Parked. The router gave up; the publisher was told 202 and nothing will be delivered until someone requeues it.',
};

export function outboxStatusLabel(status: OutboxStatus): string {
  return META[status].label;
}

export function OutboxStatusBadge({ status }: { status: OutboxStatus }) {
  const meta = META[status];
  return (
    <Badge tone={meta.tone} dot pulse={meta.pulse}>
      {meta.label}
    </Badge>
  );
}
