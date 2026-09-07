import { ApiPropertyOptional } from '@nestjs/swagger';
import { EndpointStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

/**
 * The idiom for a boolean query parameter. Use this one; do not reach for
 * `@Type(() => Boolean)`.
 *
 * `@Type(() => Boolean)` compiles to `Boolean(value)`, and a query string only
 * ever produces strings: `Boolean('false')` is `true`, and so is
 * `Boolean('0')`. `?include_deleted=false` therefore turned soft-deleted rows
 * ON - the caller got the opposite of what they asked for, with a 200. Only
 * `''` came out false, by accident.
 *
 * So the string is compared, not coerced. `true`/`1` are true, anything else
 * present is false, and an absent parameter stays `undefined` so `@IsOptional`
 * still means optional rather than "defaulted to false by the transformer".
 *
 * This is the FIRST boolean query parameter in the codebase; the eight modules
 * still to come should import this rather than re-deriving it.
 */
export const BooleanQuery = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === undefined || value === null || value === ''
      ? undefined
      : value === true || value === 'true' || value === '1',
  );

/**
 * `limit` is validated against the SAME ceiling `ScopedRepository` clamps to.
 * The repository clamping silently is the right last line of defence, but a
 * caller asking for 5000 and getting 200 with no explanation is a support
 * ticket; this turns it into a 400 that says what the maximum is.
 */
export class ListEndpointsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'paused', 'disabled', 'deleted'] })
  @IsOptional()
  @IsEnum(['active', 'paused', 'disabled', 'deleted'])
  status?: EndpointStatus;

  @ApiPropertyOptional({
    description:
      'Include soft-deleted endpoints. Deleted rows are kept forever because the delivery ' +
      'ledger references them; they are hidden from the default listing, not erased.',
    default: false,
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  include_deleted?: boolean;

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
