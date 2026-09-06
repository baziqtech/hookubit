import { ApiProperty } from '@nestjs/swagger';
import { MemberRole } from '@prisma/client';
import { IsEmail, IsIn, IsString, MaxLength } from 'class-validator';
import { MEMBER_ROLES } from '../../authz';

/**
 * Invite by ADDRESS, never by user id.
 *
 * A `user_id` field here would be the whole vulnerability: `users` is not
 * tenant-owned, so there is no scoped repository to validate an id against, and
 * an admin could paste any id on the platform and have a membership appear
 * silently in a stranger's account. Membership is created only when the invitee
 * presents the token from their own mailbox, from their own session — see
 * `MembersService.accept`.
 */
export class InviteMemberDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    enum: MEMBER_ROLES,
    description:
      'Must be a role the caller may assign: never above their own rank. An admin cannot ' +
      'invite an owner.',
  })
  @IsString()
  @IsIn([...MEMBER_ROLES])
  role!: MemberRole;
}

export class InvitationAcceptedDto {
  @ApiProperty({
    example: 'accepted',
    description:
      'Deliberately uninformative. The response is identical whether the address is already ' +
      'a member, has an account, or has none - anything else would let a member enumerate ' +
      'the platform.',
  })
  status!: 'accepted';
}
