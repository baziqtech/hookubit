import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export const API_KEY_NAME_MAX_LENGTH = 200;
export const API_KEY_MAX_SCOPES = 32;
/** One scope string; the longest permission in the matrix is well under this. */
export const API_KEY_SCOPE_MAX_LENGTH = 64;

export class CreateApiKeyDto {
  @ApiProperty({
    example: 'Payments ingest (production)',
    maxLength: API_KEY_NAME_MAX_LENGTH,
    description: 'How an operator will recognise this key in the list. Shown in audit entries.',
  })
  @IsString()
  @Length(1, API_KEY_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2027-01-01T00:00:00.000Z',
    description:
      'Must be in the future. The key stops authenticating at this instant with no further ' +
      'action; omit for a key that only revocation ends.',
  })
  @IsOptional()
  @IsISO8601()
  @MaxLength(64)
  expires_at?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['events.read'],
    description:
      'Control-plane permissions this key may hold. Each must be a real permission AND one the ' +
      'caller holds themselves - a key cannot be minted with more authority than the person ' +
      'minting it. Defaults to none, which is what an ingest-only key wants.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(API_KEY_MAX_SCOPES)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(API_KEY_SCOPE_MAX_LENGTH, { each: true })
  scopes?: string[];
}
