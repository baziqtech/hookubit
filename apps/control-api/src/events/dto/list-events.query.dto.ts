import { ApiPropertyOptional } from '@nestjs/swagger';
import { EventStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

export const EVENT_STATUSES = ['received', 'processing', 'processed', 'failed'] as const;

/**
 * The shortest `idempotency_key` fragment this API will search for.
 *
 * The search is `ILIKE '%fragment%'`, which cannot use a b-tree index and is a
 * scan of every event the other filters left. A one- or two-character fragment
 * matches most of the table, so it is both the most expensive query anyone can
 * write here and the least useful answer they can get. Three is enough for a
 * fragment of a real key to be selective.
 */
export const MIN_IDEMPOTENCY_KEY_SEARCH = 3;

/**
 * Filters that help at 2am, and what each one costs.
 *
 * `events` is the largest table in the system. The indexes that exist
 * (schema.prisma, `model Event`):
 *
 *   events_project_id_created_at_idx             (project_id, created_at DESC)
 *   events_project_id_event_type_created_at_idx  (project_id, event_type, created_at DESC)
 *   events_organization_id_created_at_idx        (organization_id, created_at DESC)
 *
 * The default order is `created_at DESC`, the trailing column of all three, so
 * the two common shapes - "this project, newest first" and "this project, this
 * event type, newest first" - are index-ordered scans with no sort step.
 *
 * `status` and `idempotency_key` have no index and are documented as such
 * below. That is a deliberate call rather than an oversight: `status` has four
 * values and is `processed` for essentially every row, so an index on it would
 * be read once and maintained on every insert into the busiest table here, and
 * a substring search cannot use a b-tree at all. Both are refinements of a
 * range the indexed filters already narrowed, which is how they should be used
 * - hence the explicit advice in each description rather than a silent
 * sequential scan.
 */
export class ListEventsQueryDto {
  @ApiPropertyOptional({
    description:
      'Exact event type, e.g. `payment.settled`. INDEX-SUPPORTED: cheap at any volume, and ' +
      'with the default newest-first order it needs no sort step. No wildcards or prefixes - ' +
      'a partial type never matches.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  event_type?: string;

  @ApiPropertyOptional({
    enum: EVENT_STATUSES,
    description:
      'Ingest/routing state, NOT a delivery outcome. **NOT INDEX-SUPPORTED**: a filter applied ' +
      'to whatever the project and date predicates selected. Pair it with a date range.',
  })
  @IsOptional()
  @IsEnum(EVENT_STATUSES)
  status?: EventStatus;

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
    description: 'Exclusive upper bound on `created_at`. INDEX-SUPPORTED, and non-overlapping.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  created_before?: Date;

  @ApiPropertyOptional({
    minLength: MIN_IDEMPOTENCY_KEY_SEARCH,
    description:
      'Case-insensitive substring of the producer-supplied idempotency key - the free-text ' +
      'search for "the producer says they sent order 41f9, did we get it?". ' +
      '**NOT INDEX-SUPPORTED**: `ILIKE \'%fragment%\'` cannot use a b-tree, so this is a scan ' +
      `of every event the other filters left. Minimum ${MIN_IDEMPOTENCY_KEY_SEARCH} characters, ` +
      'and always pair it with a date range on a busy project.',
  })
  @IsOptional()
  @IsString()
  @MinLength(MIN_IDEMPOTENCY_KEY_SEARCH)
  @MaxLength(255)
  idempotency_key?: string;

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
