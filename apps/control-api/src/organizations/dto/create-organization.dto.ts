import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * `organizations.slug` is GLOBALLY unique, so its pattern is fixed here rather
 * than left to whatever a caller sends: it ends up in URLs and in operator
 * tooling, and a slug containing `/`, `..` or uppercase would be a path-handling
 * problem in three places at once.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 48;
export const ORGANIZATION_NAME_MAX_LENGTH = 200;

export const SLUG_DESCRIPTION =
  'Lowercase letters, digits and single dashes. Derived from the name when omitted, ' +
  'with a random suffix if that name is taken.';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme', minLength: 2, maxLength: ORGANIZATION_NAME_MAX_LENGTH })
  @IsString()
  @Length(2, ORGANIZATION_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    example: 'acme',
    minLength: SLUG_MIN_LENGTH,
    maxLength: SLUG_MAX_LENGTH,
    description: SLUG_DESCRIPTION,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @Length(SLUG_MIN_LENGTH, SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and single dashes',
  })
  slug?: string;
}
