import { ApiProperty } from '@nestjs/swagger';
import { MemberRole } from '@prisma/client';
import { IsIn, IsString } from 'class-validator';
import { MEMBER_ROLES } from '../../authz';

/**
 * Role, and nothing else.
 *
 * `user_id` is absent on purpose. `OrganizationMemberUncheckedUpdateManyInput`
 * still accepts it, so a DTO that carried one and was spread into the scoped
 * repository would let a caller re-point an existing membership at another
 * account - a silent, audited-as-a-role-change takeover. The only column this
 * module ever writes on an existing membership is `role`.
 */
export class UpdateMemberRoleDto {
  @ApiProperty({
    enum: MEMBER_ROLES,
    description:
      'Enforced by the role lattice: never your own membership, never a role above your own ' +
      'rank, never someone who outranks you, and never the last owner.',
  })
  @IsString()
  @IsIn([...MEMBER_ROLES])
  role!: MemberRole;
}
