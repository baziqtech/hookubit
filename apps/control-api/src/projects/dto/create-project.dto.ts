import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Environment } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from '../slug';

export const PROJECT_NAME_MAX_LENGTH = 200;

export class CreateProjectDto {
  @ApiProperty({ example: 'Payments', maxLength: PROJECT_NAME_MAX_LENGTH })
  @IsString()
  @Length(1, PROJECT_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    example: 'payments',
    minLength: SLUG_MIN_LENGTH,
    maxLength: SLUG_MAX_LENGTH,
    description:
      'Lowercase letters, digits and single hyphens. Unique within the organization. ' +
      'Derived from `name` when omitted; a supplied slug is validated, never rewritten.',
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
    enum: Environment,
    enumName: 'Environment',
    default: Environment.test,
    description:
      'CANNOT BE CHANGED LATER. Defaults to `test`, so a project is never created live by ' +
      'omission. API keys minted here must carry the matching prefix (wk_test_/wk_live_) and ' +
      'the ingest path re-checks the pair on every request.',
  })
  @IsOptional()
  @IsEnum(Environment)
  environment?: Environment;
}
