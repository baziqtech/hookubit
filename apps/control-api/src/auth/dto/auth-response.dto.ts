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
