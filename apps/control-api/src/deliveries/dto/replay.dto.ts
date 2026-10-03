import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The body of a replay.
 *
 * `reason` is optional and goes to the audit log, nowhere else. It is not
 * written onto the delivery: `deliveries` carries no operator-note column and
 * inventing one would put free text on the hot path of the largest table in the
 * system. The audit row is where "why did somebody re-send this?" belongs, and
 * `audit_logs` already carries the actor, the address and the time.
 */
export class ReplayDeliveryDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Recorded on the audit entry for this replay. Not stored on the delivery.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * `POST /events/:id/replay`.
 *
 * With `endpoint_id`: re-deliver to that one endpoint. Without it: re-deliver
 * to every endpoint the event ORIGINALLY reached.
 *
 * "Originally reached" is read off the existing delivery rows, never by
 * re-running the subscription match. Subscriptions are mutable: re-matching a
 * three-week-old event against today's subscriptions would deliver it to
 * endpoints that were never targeted (a subscription added since) and skip ones
 * that were (a subscription narrowed or deleted since) - and the operator
 * asking for a replay is asking for what happened, not for what would happen if
 * it were published now.
 */
export class ReplayEventDto extends ReplayDeliveryDto {
  @ApiPropertyOptional({
    description:
      'One of the endpoints this event was originally routed to. Omit to replay to all of ' +
      'them. An endpoint that never received this event is refused: sending it there for the ' +
      'first time is a new delivery, not a replay.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  endpoint_id?: string;
}
