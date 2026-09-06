import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../authz';

/**
 * Offset paging, with the ceiling the scoped repository already enforces.
 *
 * The bound is declared here as well as in `ScopedRepository` on purpose: the
 * repository clamps silently, which is the right behaviour for a safety net but
 * the wrong behaviour for an API — a caller asking for 5000 rows should be told
 * the request was invalid, not handed 200 and left to think it got everything.
 */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
