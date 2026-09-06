import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from '../slug';
import { PROJECT_NAME_MAX_LENGTH } from './create-project.dto';

/**
 * `environment` is DELIBERATELY ABSENT, and its absence is the enforcement.
 *
 * The global `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted:
 * true`, so a body carrying `environment` is refused with `invalid_request`
 * before this DTO ever reaches the controller. `ProjectsService.update` also
 * checks for the key explicitly, so the rule still holds for a caller that
 * arrives without the pipe (a test, the CLI, compiled JS) and the message it
 * gets explains WHY rather than reading as a typo.
 *
 * `status` is absent for the same reason: soft delete is `DELETE`, which is
 * audited as `project.deleted`. A `status: 'deleted'` slipped through a PATCH
 * would be audited as an edit.
 */
export class UpdateProjectDto {
  @ApiPropertyOptional({ example: 'Payments', maxLength: PROJECT_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Length(1, PROJECT_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    example: 'payments',
    minLength: SLUG_MIN_LENGTH,
    maxLength: SLUG_MAX_LENGTH,
    description: 'Unique within the organization; a collision answers 409 `conflict`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @Length(SLUG_MIN_LENGTH, SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase alphanumeric segments separated by single hyphens',
  })
  slug?: string;
}
