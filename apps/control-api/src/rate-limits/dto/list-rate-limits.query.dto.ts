import { ApiPropertyOptional } from '@nestjs/swagger';
import { RateLimitScope } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
import { RATE_LIMIT_SCOPES } from '../rate-limit-limits';

/**
 * `limit` is validated against the SAME ceiling `ScopedRepository` clamps to, so
 * a caller asking for 5000 gets a 400 that names the maximum rather than a
 * silent 200 rows.
 */
export class ListRateLimitsQueryDto {
  @ApiPropertyOptional({ enum: RATE_LIMIT_SCOPES })
  @IsOptional()
  @IsIn(RATE_LIMIT_SCOPES)
  scope?: RateLimitScope;

  @ApiPropertyOptional({
    maxLength: 64,
    description: 'Filter to the policies covering one specific resource.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resource_id?: string;

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
