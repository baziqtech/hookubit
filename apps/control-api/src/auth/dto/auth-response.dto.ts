import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthUserDto {
  @ApiProperty({ example: 'usr_01J...' })
  id!: string;

  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiProperty({ description: 'False until the verification token is presented.' })
  email_verified!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    example: '2026-09-08T14:20:00.000Z',
    description:
      'ISO-8601 instant at which the user finished OR skipped the product tour; null if ' +
      'neither. Carried on every response that returns a user - session, login, verify-email - ' +
      'so the client never needs a second request to decide whether to show the tour. ' +
      'Set by POST /v1/auth/onboarding-completed.',
  })
  onboarding_completed_at!: string | null;
}

export class SessionResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class AcknowledgedDto {
  @ApiProperty({
    example: 'accepted',
    description:
      'Deliberately uninformative: password reset and verification responses must not reveal whether an account exists.',
  })
  status!: 'accepted' | 'ok';
}
