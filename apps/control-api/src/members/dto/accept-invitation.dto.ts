import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { OrganizationDto } from '../../organizations';

/**
 * The token travels in the BODY, never in the path.
 *
 * A single-use membership grant in a URL ends up in access logs, in `Referer`
 * headers on every asset the landing page loads, and in browser history. The
 * dashboard reads it from the link's query string once and POSTs it here.
 */
export class AcceptInvitationDto {
  @ApiProperty({
    description: 'The single-use token from the invitation email.',
    minLength: 20,
    maxLength: 200,
  })
  @IsString()
  @Length(20, 200)
  token!: string;
}

export class AcceptedInvitationDto {
  @ApiProperty({
    type: OrganizationDto,
    description: 'The organization the caller has just joined, with their new role.',
  })
  organization!: OrganizationDto;
}
