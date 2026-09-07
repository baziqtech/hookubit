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

/**
 * The canonical list envelope - `{ data, has_more, next_offset }` - and nothing
 * else. See `OrganizationListDto` for why `total`, `limit` and `offset` are
 * gone: a `total` is a second COUNT per request, taken at a different instant
 * from the rows, that a client paging on `has_more` never needed.
 */
export class MemberListDto {
  @ApiProperty({ type: [MemberDto] })
  data!: MemberDto[];

  @ApiProperty({
    description: 'True when more members exist in this organization than the page carries.',
    example: false,
  })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pass back as `offset` to fetch the next page. NULL - never absent, never 0 - on the ' +
      'last page.',
    example: null,
  })
  next_offset!: number | null;
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
