import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  SLUG_DESCRIPTION,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from './create-organization.dto';

/**
 * Name and slug only.
 *
 * `status` is deliberately absent. Suspension is a platform/billing decision,
 * not a self-service one — a customer could otherwise un-suspend their own
 * unpaid organization — and deletion has its own route so it can be
 * owner-gated and audited as the distinct, destructive fact that it is.
 */
export class UpdateOrganizationDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: ORGANIZATION_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Length(2, ORGANIZATION_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
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
