import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
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

  @ApiPropertyOptional({
    type: [String],
    example: ['203.0.113.0/24', '198.51.100.7'],
    description:
      'Addresses permitted to PUBLISH events to this project. An EMPTY list means every address ' +
      'may, which is the default. Entries are IPv4/IPv6 addresses or CIDR blocks; a malformed ' +
      'one is REFUSED rather than dropped, because silently discarding it would lock out the ' +
      'service it was for at the moment you believed you had permitted it. ' +
      'Sending this field REPLACES the list. Publishing only: it is never consulted for reading ' +
      'the record or for signing in, so it cannot lock anyone out of the dashboard.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_ips?: string[];
}
