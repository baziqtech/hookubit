import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
import { BooleanQuery } from '../../endpoints';

/**
 * `limit` is validated against the SAME ceiling `ScopedRepository` clamps to, so
 * a caller asking for 5000 gets a 400 that names the maximum rather than a
 * silent 200 rows.
 *
 * `is_default` uses `BooleanQuery()` from `src/endpoints`, not
 * `@Type(() => Boolean)`: the latter compiles to `Boolean(value)`, and a query
 * string only ever produces strings, so `?is_default=false` came back TRUE.
 */
export class ListRetryPoliciesQueryDto {
  @ApiPropertyOptional({ description: 'Filter to the project default, or to everything else.' })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  is_default?: boolean;

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
