import { ApiProperty } from '@nestjs/swagger';
import { EventOutbox, OutboxStatus } from '@prisma/client';

/** ISO-8601, or null. One helper so the nullable timestamps read the same. */
function iso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

export const OUTBOX_STATUSES = ['pending', 'processing', 'processed', 'failed'] as const;

/**
 * One `event_outbox` row: the router's record of what it still owes an event.
 *
 * This resource exists because of a gap, and the gap is worth stating on the
 * type. An event that has been answered `202 Accepted` is durable, but the
 * fan-out that turns it into deliveries can fail - and when the router gives up,
 * it PARKS the row (`status: failed`) and marks the event `failed`. Until this
 * module existed, `event_outbox` had no reference anywhere in the control plane:
 * a parked row was invisible to the API and to the dashboard, and the only way
 * to put one back was hand-written SQL against production.
 *
 * Nothing here is derived or recomputed. Every field is what the data plane
 * wrote, so the answer to "why is this stuck?" is the row itself.
 */
export class OutboxEntryDto {
  @ApiProperty({ description: 'Outbox row id (`obx_...`).' })
  id!: string;

  @ApiProperty({ description: 'The event this row fans out.' })
  event_id!: string;

  @ApiProperty({
    description:
      'What the row asks the router to do. `event.created` is the only type the router handles; ' +
      'anything else is parked on sight rather than re-claimed forever.',
  })
  type!: string;

  @ApiProperty({
    enum: OUTBOX_STATUSES,
    description:
      '`pending` is queued (possibly mid-fan-out, see `fan_out_cursor`); `processing` is leased ' +
      'by a router right now; `processed` is done; **`failed` is PARKED** - the router gave up, ' +
      'the event will never be delivered, and it stays that way until someone requeues it.',
  })
  status!: OutboxStatus;

  @ApiProperty({
    description:
      'Total times a router has picked this row up. Monotonic, and NOT the bound that parks it - ' +
      'see `unaccounted_attempts`. A high number here with a low one there is a row that keeps ' +
      'failing in ways the router understood and recorded, which is a database or configuration ' +
      'problem rather than a poisoned event.',
  })
  attempts!: number;

  @ApiProperty({
    description:
      'Claims that ended with the router writing nothing at all - a crash, an OOM, a lease left ' +
      'to lapse. THIS is the bound that parks a row (`ROUTER_MAX_OUTBOX_ATTEMPTS`), because it is ' +
      'the only counter that means "this row keeps killing the process". A failure the router ' +
      'observed and recorded hands its increment back.',
  })
  unaccounted_attempts!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The last error the router recorded, verbatim and truncated to 1000 characters. On a parked ' +
      'row this is why it was parked, and it is preserved through a requeue so the history is not ' +
      'erased by the recovery.',
  })
  last_error!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the current run of recorded failures began; null when the row is not failing. Recorded ' +
      'failures are bounded by elapsed TIME rather than by a count, because no count distinguishes ' +
      '"the database was unavailable for twenty minutes" from "this row errors every time".',
  })
  failing_since!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Resume point for a fan-out too wide for one transaction: the subscription id the last ' +
      'committed batch stopped at. Non-null on a `pending` row means the fan-out is PARTLY done - ' +
      'some endpoints already have their delivery, the rest are still owed one. It is kept through ' +
      'a requeue, so recovery resumes rather than re-walking work that already committed.',
  })
  fan_out_cursor!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When this row next becomes claimable. In the future while it is backing off.',
  })
  available_at!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The router replica holding the lease, if any. Useful when one replica misbehaves.',
  })
  locked_by!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  locked_until!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the row left the queue, whether it succeeded or was parked.',
  })
  processed_at!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at!: string;
}

export function toOutboxEntryDto(row: EventOutbox): OutboxEntryDto {
  return {
    id: row.id,
    event_id: row.eventId,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    unaccounted_attempts: row.unaccountedAttempts,
    last_error: row.lastError ?? null,
    failing_since: iso(row.failingSince),
    fan_out_cursor: row.fanOutCursor ?? null,
    available_at: new Date(row.availableAt).toISOString(),
    locked_by: row.lockedBy ?? null,
    locked_until: iso(row.lockedUntil),
    processed_at: iso(row.processedAt),
    created_at: new Date(row.createdAt).toISOString(),
  };
}

/** The canonical list envelope. See `audit/list-envelope.contract.spec.ts`. */
export class OutboxEntryListDto {
  @ApiProperty({ type: [OutboxEntryDto] })
  data!: OutboxEntryDto[];

  @ApiProperty({ description: 'More rows match than this page carries.' })
  has_more!: boolean;

  @ApiProperty({ type: Number, nullable: true, description: '`offset` for the next page.' })
  next_offset!: number | null;
}

/** What a bulk requeue did. */
export class RequeueResultDto {
  @ApiProperty({ description: 'Parked rows returned to the queue by this request.' })
  requeued!: number;

  @ApiProperty({
    description:
      'More parked rows matched than this request was allowed to requeue. Call again until it is ' +
      'false; the bound is per request, not per incident.',
  })
  has_more!: boolean;

  @ApiProperty({
    type: [OutboxEntryDto],
    description: 'The rows as they now stand, back in the queue.',
  })
  data!: OutboxEntryDto[];
}
