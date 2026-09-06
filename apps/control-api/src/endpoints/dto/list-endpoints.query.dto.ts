import { ApiPropertyOptional } from '@nestjs/swagger';
import { EndpointStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

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
  @Type(() => Boolean)
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
