import { ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
import { BooleanQuery } from '../../endpoints';

export const DELIVERY_STATUSES = [
  'pending',
  'scheduled',
  'queued',
  'processing',
  'succeeded',
  'failed',
  'retrying',
  'exhausted',
  'cancelled',
] as const;

export const DELIVERY_ORIGINS = ['original', 'replay'] as const;
export type DeliveryOrigin = (typeof DELIVERY_ORIGINS)[number];

/**
 * Filters an operator actually reaches for, and what each one costs.
 *
 * `deliveries` is one of the two largest tables in the system, so every filter
 * here is either index-supported or documented as a scan. The indexes that
 * exist (schema.prisma, `model Delivery`):
 *
 *   deliveries_project_id_status_created_at_idx  (project_id, status, created_at DESC)
 *   deliveries_endpoint_id_created_at_idx        (endpoint_id, created_at DESC)
 *   deliveries_event_id_idx                      (event_id)
 *   deliveries_status_next_attempt_at_idx        (status, next_attempt_at)   [scheduler's]
 *
 * The default order is `created_at DESC`, which is the trailing column of the
 * first two, so the common shapes - "this project, this status, newest first"
 * and "this endpoint, newest first" - are index-ordered scans with no sort.
 */
export class ListDeliveriesQueryDto {
  @ApiPropertyOptional({
    enum: DELIVERY_STATUSES,
    description:
      'Exact status. INDEX-SUPPORTED: leading columns of ' +
      '`deliveries_project_id_status_created_at_idx`.',
  })
  @IsOptional()
  @IsEnum(DELIVERY_STATUSES)
  status?: DeliveryStatus;

  @ApiPropertyOptional({
    description:
      'Everything that has failed and not recovered: `retrying`, `failed`, `exhausted`. ' +
      'INDEX-SUPPORTED (three scans of the same index). Cannot be combined with `status` - ' +
      'they would contradict each other and the API refuses rather than picking one.',
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  failing_now?: boolean;

  @ApiPropertyOptional({
    description: 'INDEX-SUPPORTED: `deliveries_endpoint_id_created_at_idx`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  endpoint_id?: string;

  @ApiPropertyOptional({
    description: 'INDEX-SUPPORTED: `deliveries_event_id_idx`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  event_id?: string;

  @ApiPropertyOptional({
    description:
      'The event type of the event this delivery came from. **NOT INDEX-SUPPORTED**: it is a ' +
      'join to `events` on a column `deliveries` does not carry, so it filters rows the ' +
      'project/status/date predicate already selected. Always combine it with a date range ' +
      'or an endpoint on a busy project.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  event_type?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive lower bound on `created_at`. INDEX-SUPPORTED.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  created_after?: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Exclusive upper bound on `created_at`. INDEX-SUPPORTED.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  created_before?: Date;

  @ApiPropertyOptional({
    enum: DELIVERY_ORIGINS,
    description:
      '`original` hides replays, `replay` shows only them. Omitted, both are returned - a ' +
      'replay is a real delivery and hiding it by default would make the ledger lie.',
  })
  @IsOptional()
  @IsIn(DELIVERY_ORIGINS)
  origin?: DeliveryOrigin;

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

/** `GET /deliveries/:id/attempts`. Paging only; the delivery is the filter. */
export class ListAttemptsQueryDto {
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
