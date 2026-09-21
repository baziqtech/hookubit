import { DeliveryStatus, EventStatus } from '@prisma/client';

/**
 * What became of an event, as opposed to what became of one of its deliveries.
 *
 * `Event.status` is the INGEST/fan-out state and has four values. It answers
 * "did we store it and work out who wanted it?" and stops there — `processed`
 * means the fan-out committed, and says nothing at all about whether anybody
 * received anything. An events list built on it reports a project as healthy
 * while every delivery it produced is failing.
 *
 * These six are the rollup of the event's DELIVERIES, which is the question the
 * list is actually asked.
 */
export type EventRollupState =
  | 'received'
  | 'in_progress'
  | 'delivered'
  | 'partly_delivered'
  | 'all_failed'
  | 'dropped';

export interface DeliveryRollup {
  state: EventRollupState;
  total: number;
  succeeded: number;
  /** `failed` plus `exhausted`, as every other rollup in this codebase counts it. */
  failed: number;
  in_flight: number;
  cancelled: number;
}

const IN_FLIGHT: readonly DeliveryStatus[] = [
  DeliveryStatus.pending,
  DeliveryStatus.scheduled,
  DeliveryStatus.queued,
  DeliveryStatus.processing,
  DeliveryStatus.retrying,
];

/**
 * Six states from nine counts and the event's own status.
 *
 * ## `dropped` is the one that matters
 *
 * Fan-out COMPLETED and produced nothing, because no subscription matched. The
 * publisher was answered 202 and the event went nowhere, which is the single
 * most confusing thing this product can do to a newcomer — and it is invisible
 * in every other column, because there is no delivery row to be absent from.
 * It is distinguishable from `received` only by the event's own status:
 * `processed` means the router ran and found nobody; anything else means it has
 * not finished.
 *
 * ## A stuck event reads as `received`, deliberately
 *
 * An event whose fan-out parked has no deliveries and has not been processed,
 * so it lands here as `received` — indistinguishable, from this table alone,
 * from one published a second ago. Telling them apart needs `event_outbox`,
 * which is a different table and a different screen. That screen exists, and
 * the events list links to it from the notice above the table rather than
 * pretending this column can answer it.
 *
 * ## Cancelled counts towards `all_failed`
 *
 * Not because a cancellation is a failure — it is usually a paused endpoint,
 * which is somebody's deliberate choice — but because from the EVENT's point of
 * view nothing arrived, and a state called `partly_delivered` on an event where
 * nothing was delivered would be worse. The per-status counts travel with the
 * state, so the UI spells out the actual mix and nothing is lost.
 */
export function rollUp(
  eventStatus: EventStatus,
  counts: Readonly<Record<DeliveryStatus, number>>,
): DeliveryRollup {
  let total = 0;
  for (const status of Object.values(DeliveryStatus)) total += counts[status] ?? 0;

  const succeeded = counts[DeliveryStatus.succeeded] ?? 0;
  const failed = (counts[DeliveryStatus.failed] ?? 0) + (counts[DeliveryStatus.exhausted] ?? 0);
  const cancelled = counts[DeliveryStatus.cancelled] ?? 0;
  const inFlight = IN_FLIGHT.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  const base = { total, succeeded, failed, in_flight: inFlight, cancelled };

  if (total === 0) {
    return {
      ...base,
      state: eventStatus === EventStatus.processed ? 'dropped' : 'received',
    };
  }
  if (inFlight > 0) return { ...base, state: 'in_progress' };
  if (succeeded === total) return { ...base, state: 'delivered' };
  if (succeeded === 0) return { ...base, state: 'all_failed' };
  return { ...base, state: 'partly_delivered' };
}

/** Zeroed counts, for an event the grouped query returned no rows for. */
export function emptyCounts(): Record<DeliveryStatus, number> {
  const counts = {} as Record<DeliveryStatus, number>;
  for (const status of Object.values(DeliveryStatus)) counts[status] = 0;
  return counts;
}
