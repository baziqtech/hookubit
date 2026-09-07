import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

/** Long enough for any id or action this platform writes, short enough to bound the WHERE. */
const MAX_FILTER_LENGTH = 128;

/**
 * The filters an investigator actually reaches for at 2am: WHO did it, WHAT
 * they did, to WHICH row, and WHEN.
 *
 * ## Index support, stated per filter
 *
 * `audit_logs` carries two indexes:
 *
 *     (organization_id, created_at DESC)
 *     (organization_id, action, created_at DESC)
 *
 * - `created_after` / `created_before` — INDEX-SUPPORTED by the first. This is
 *   the filter that bounds the work, and it is why the date range is documented
 *   first rather than last.
 * - `action` — INDEX-SUPPORTED by the second, which also carries the ordering,
 *   so an action filter with a date range is an index range scan.
 * - `user_id`, `resource_type`, `resource_id` — **NOT INDEXED. Each is a filter
 *   applied over the rows the organization/date range already selected**, i.e.
 *   a scan within that window. On a busy organization with no date range that
 *   is the whole tenant's history. Combine them with `created_after`; the route
 *   is throttled precisely because they exist. Adding an index for them is a
 *   `schema.prisma` change and is deliberately not smuggled in here.
 *
 * ## What is deliberately NOT a filter
 *
 * There is no search over `metadata`. `AuditService` redacts metadata by key
 * name at write time, and a predicate over the stored value would turn this
 * route into an oracle: a caller who can ask "does any row have metadata
 * matching X" can test candidate values against rows whose value was replaced
 * with `[redacted]`, and recover by search what the redaction removed. The
 * redaction is a backstop rather than a guarantee, which is exactly why the
 * read path must not chip at it.
 */
export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({
    maxLength: MAX_FILTER_LENGTH,
    example: 'usr_01J...',
    description:
      'Only rows attributed to this user. NOT INDEXED - a scan within the organization and ' +
      'date range. An id from another organization is not an error and not a leak: the tenant ' +
      'predicate is ANDed in, so it simply matches nothing.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILTER_LENGTH)
  user_id?: string;

  @ApiPropertyOptional({
    maxLength: MAX_FILTER_LENGTH,
    example: 'endpoint.created',
    description:
      'Exact match on the action, e.g. `api_key.revoked`. Index-supported. Actions are ' +
      '`<resource>.<verb>` in the past tense and are not a closed set, so an unknown value ' +
      'returns an empty page rather than a 400.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILTER_LENGTH)
  action?: string;

  @ApiPropertyOptional({
    maxLength: MAX_FILTER_LENGTH,
    example: 'endpoint',
    description: 'e.g. `endpoint`, `api_key`, `member`. NOT INDEXED - a scan (see the class doc).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILTER_LENGTH)
  resource_type?: string;

  @ApiPropertyOptional({
    maxLength: MAX_FILTER_LENGTH,
    example: 'ep_01J...',
    description:
      'Everything that ever happened to one row - the "what happened to this endpoint?" ' +
      'question. NOT INDEXED - a scan (see the class doc); pair it with `created_after`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILTER_LENGTH)
  resource_id?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-09-01T00:00:00.000Z',
    description: 'Inclusive lower bound on `created_at`. Index-supported.',
  })
  @IsOptional()
  @IsISO8601()
  created_after?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-09-07T00:00:00.000Z',
    description: 'Inclusive upper bound on `created_at`. Index-supported.',
  })
  @IsOptional()
  @IsISO8601()
  created_before?: string;

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
