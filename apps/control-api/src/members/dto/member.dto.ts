import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemberRole, OrganizationMember } from '@prisma/client';
import { UserIdentity } from '../../organizations';

/**
 * A membership, with just enough identity attached to be useful.
 *
 * `email` and `name` come from `users`, which is not tenant-owned — the ids are
 * resolved through `UserDirectory` AFTER the member rows came out of a
 * tenant-scoped query, so nothing here is reachable for a user outside the
 * organization. See the rules in `user-directory.ts`.
 *
 * Nullable rather than optional when the user row is missing: a membership
 * whose user has been deleted is a data-integrity problem an operator needs to
 * SEE in the members list, not one the API should hide by dropping the row.
 */
export class MemberDto {
  @ApiProperty({ example: 'mem_01J...' })
  id!: string;

  @ApiProperty({ example: 'usr_01J...' })
  user_id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'ada@example.com' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiProperty({ enum: ['owner', 'admin', 'developer', 'viewer', 'billing'] })
  role!: MemberRole;

  @ApiProperty({ description: 'True when the account has been disabled platform-wide.' })
  disabled!: boolean;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class MemberListDto {
  @ApiProperty({ type: [MemberDto] })
  data!: MemberDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

export function toMemberDto(
  member: OrganizationMember,
  identity: UserIdentity | undefined,
): MemberDto {
  return {
    id: member.id,
    user_id: member.userId,
    email: identity?.email ?? null,
    name: identity?.name ?? null,
    role: member.role,
    disabled: identity?.disabledAt != null,
    created_at: member.createdAt.toISOString(),
  };
}
