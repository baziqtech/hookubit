import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { Principal, UserPrincipal, UserScoped } from '../organizations';
import { AcceptInvitationDto, AcceptedInvitationDto } from './dto';
import { MembersService } from './members.service';

/**
 * Redemption lives at `/v1/invitations`, NOT under
 * `/v1/organizations/:orgId/members`.
 *
 * The invitee is by definition not yet a member of that organization, so a
 * route nested under `:orgId` would be resolved by `TenantGuard`, fail the
 * membership check, and answer 404 - correctly. Redemption is user-scoped: the
 * organization comes out of the token, never out of the path, so there is no
 * organization id for a caller to substitute.
 *
 * A separate top-level prefix also keeps it out of Express's route table for
 * `/v1/organizations/:orgId`, where an `/organizations/invitations/...` path
 * would depend on controller registration order to avoid being captured by
 * `:orgId`.
 */
const HOUR = 60 * 60 * 1000;

@ApiTags('members')
@ApiCookieAuth('session')
@UseGuards(ThrottleGuard)
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  @Post('accept')
  @UserScoped()
  // Counted, not enforced per address - the same posture `auth.verify` and
  // `auth.reset` take, and for the same reason. This route consumes a 256-bit
  // single-use token, so guessing is not a threat rate limiting addresses;
  // behind a proxy the per-address bucket aggregates real users, and refusing
  // on it would deny service to everyone finishing an invitation rather than
  // prevent an attack. The count still makes the pressure visible to an
  // operator, and a per-subject bucket can enforce on top of it.
  @Throttle({ name: 'invitations.accept', limit: 20, windowMs: HOUR, enforcePerIp: false })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem a membership invitation',
    description:
      'Requires a session: the token proves possession of a mailbox, the session proves who ' +
      'is asking, and the two must be the same address. Single-use, and refused if the ' +
      'inviting member no longer holds the rank to grant that role. Redeeming an invitation ' +
      'you have already accepted returns the organization unchanged rather than altering ' +
      'your role.',
  })
  @ApiOkResponse({ type: AcceptedInvitationDto })
  @ApiBadRequestResponse({
    description:
      'Unknown, consumed, expired, or issued to a different address - one answer for all four.',
  })
  @ApiConflictResponse({
    description: 'The organization or the inviting member can no longer support the invitation.',
  })
  async accept(
    @Principal() principal: UserPrincipal,
    @Body() dto: AcceptInvitationDto,
  ): Promise<AcceptedInvitationDto> {
    return this.members.accept(principal, dto);
  }
}
