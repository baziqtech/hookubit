import { ApiPropertyOptional } from '@nestjs/swagger';
import { OutboxStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
import { OUTBOX_STATUSES } from './outbox-response.dto';

/**
 * Filters for the operator's "what is stuck?" page, and what each one costs.
 *
 * The indexes on `event_outbox`:
 *
 *   event_outbox_status_available_at_idx  (status, available_at)
 *   event_outbox_ready_idx                (available_at, created_at) WHERE status IN (pending, processing)
 *   event_outbox_attention_idx            (status, created_at DESC)  WHERE status IN (failed, pending)
 *   event_outbox_event_id_idx             (event_id)
 *
 * The default order is `created_at DESC`, which is the trailing column of
 * `event_outbox_attention_idx`, so `status=failed` - the query this page exists
 * for - is an index-ordered scan with no sort.
 *
 * Note the tenant predicate itself is a join: `event_outbox` carries no
 * organization_id or project_id, so scoping goes through `events`. That is what
 * `event_outbox_event_id_idx` is for.
 */
export class ListOutboxQueryDto {
  @ApiPropertyOptional({
    enum: OUTBOX_STATUSES,
    description:
      'Exact status. **`failed` is the one to ask for**: those are the PARKED rows - events that ' +
      'were accepted and will never be delivered until someone requeues them. INDEX-SUPPORTED ' +
      '(`event_outbox_attention_idx` for `failed`/`pending`).',
  })
  @IsOptional()
  @IsEnum(OUTBOX_STATUSES)
  status?: OutboxStatus;

  @ApiPropertyOptional({
    description: 'One event. INDEX-SUPPORTED: `event_outbox_event_id_idx`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  event_id?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
