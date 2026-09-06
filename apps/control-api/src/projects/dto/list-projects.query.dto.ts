import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';

export class ListProjectsQueryDto {
  @ApiPropertyOptional({
    enum: ProjectStatus,
    enumName: 'ProjectStatus',
    description:
      'Defaults to everything except `deleted`. Pass `deleted` explicitly to see soft-deleted ' +
      'projects - they still hold their slug, so this is how you find out why a create 409d.',
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

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
