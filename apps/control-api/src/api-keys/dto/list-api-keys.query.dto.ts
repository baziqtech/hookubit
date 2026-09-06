import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

/**
 * No status filter on purpose. `status` is derived from two timestamps at read
 * time (see `api-key-state.ts`), so a filter would have to be evaluated in
 * application code after paging - which silently returns short pages - or as a
 * `now()` comparison in SQL that disagrees with the derivation by a request's
 * worth of clock. Revoked and expired keys are listed WITH their status instead;
 * that is what "visibly distinguishable" needs, and hiding a revoked key is the
 * opposite of what an operator auditing credentials wants.
 */
export class ListApiKeysQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Page size. Clamped to ${MAX_PAGE_SIZE} by the repository regardless.`,
  })
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
