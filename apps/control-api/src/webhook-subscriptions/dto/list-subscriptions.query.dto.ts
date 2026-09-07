import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
// The one sanctioned boolean-query idiom. `@Type(() => Boolean)` compiles to
// `Boolean(value)` and Express hands query parameters over as strings, so
// `?enabled=false` would parse as TRUE - the caller getting the exact opposite
// of what they asked for, with a 200. See the docblock on `BooleanQuery`.
import { BooleanQuery } from '../../endpoints';

export class ListSubscriptionsQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Only subscriptions bound to this endpoint. The id is resolved through the tenant scope ' +
      'first, so an endpoint belonging to another customer answers 404 rather than an empty ' +
      'list - the same answer an id that does not exist gets.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  endpoint_id?: string;

  @ApiPropertyOptional({
    description: 'Filter by operator intent. Omit to see both enabled and disabled.',
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  enabled?: boolean;

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
