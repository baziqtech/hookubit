import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The body of a requeue.
 *
 * `reason` goes to the audit log and nowhere else. It is deliberately NOT
 * written onto the outbox row: `last_error` is the ROUTER's field, and the one
 * question a parked row has to keep answering is "what did the router say?".
 * Overwriting that with an operator's note would destroy the only record of why
 * the row was parked at the moment someone decides it was fine.
 */
export class RequeueOutboxDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Recorded on the audit entry for this requeue. Not written to the outbox row - `last_error` ' +
      'belongs to the router and is preserved.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * `POST /projects/:projectId/outbox/requeue` - the bulk form.
 *
 * With `event_id`: requeue only that event's parked rows. Without it: every
 * parked row in the project, oldest first, up to `MAX_REQUEUE_BATCH`.
 *
 * Oldest first is not arbitrary. The rows parked earliest are the ones whose
 * consumers have been waiting longest, and an operator who can only afford one
 * pass should be spending it on those.
 */
export class RequeueParkedDto extends RequeueOutboxDto {
  @ApiPropertyOptional({
    description:
      'Limit the requeue to one event. Omit to requeue every parked row in the project, up to the ' +
      'per-request bound.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  event_id?: string;
}
