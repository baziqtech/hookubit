import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { PageQueryDto } from '../organizations';
import {
  InvitationAcceptedDto,
  InviteMemberDto,
  MemberDto,
  MemberListDto,
  UpdateMemberRoleDto,
} from './dto';
import { MembersService } from './members.service';

/**
 * Thin: parse, delegate, shape. The role lattice, the transaction boundary and
 * the enumeration posture all live in `MembersService`.
 *
 * `:memberId` IS read here, unlike `:orgId` on the organizations controller.
 * The difference matters: `:orgId` is a tenancy claim that `TenantGuard` has
 * already resolved independently, so re-reading it would be trusting client
 * input for tenancy. `:memberId` names a row WITHIN the already-resolved
 * tenant, and it is resolved through `scope.members.requireById`, which ANDs
 * the tenant predicate into the WHERE clause - a member id from another
 * organization matches zero rows and answers 404, never 403.
 *
 * `POST` is throttled, and it is the one route here that needs it: it is an
 * outbound-mail primitive. The invitation carries an attacker-chosen
 * organization name (up to 200 characters), goes to any address the caller
 * names, and leaves from the platform's own sending domain - i.e. a member with
 * `members.write` had an unlimited, reputable-domain mail cannon. The limit is
 * charged per address AND per recipient, so neither one caller nor one victim
 * mailbox can be used without bound.
 */
const HOUR = 60 * 60 * 1000;

@ApiTags('members')
@ApiCookieAuth('session')
@UseGuards(ThrottleGuard)
@Controller('organizations/:orgId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @Authorized('members.read')
  @ApiOperation({ summary: 'List the members of an organization' })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiOkResponse({ type: MemberListDto })
  @ApiNotFoundResponse({ description: 'Absent, or the caller is not a member. Same answer.' })
  async list(
    @Tenant() context: RequestContext,
    @Query() page: PageQueryDto,
  ): Promise<MemberListDto> {
    return this.members.list(context, page);
  }

  @Post()
  @Authorized('members.write')
  // `byBodyField: 'email'` is the important half: it caps how many invitations
  // one MAILBOX can be sent, across every caller and organization on the
  // platform. The address is hashed before it becomes a bucket key.
  @Throttle({ name: 'members.invite', limit: 20, windowMs: HOUR, byBodyField: 'email' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Invite someone to the organization',
    description:
      'Always 202, whether the address is already a member, already has an account, or is ' +
      'unknown - anything else would let a member enumerate the platform. No membership is ' +
      'created here: the invitee redeems a single-use token from their own mailbox at ' +
      'POST /v1/invitations/accept. 403 if the requested role is above the caller\'s own rank.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiAcceptedResponse({ type: InvitationAcceptedDto })
  @ApiForbiddenResponse({ description: 'The caller may not assign that role.' })
  async invite(
    @Tenant() context: RequestContext,
    @Body() dto: InviteMemberDto,
  ): Promise<InvitationAcceptedDto> {
    return this.members.invite(context, dto);
  }

  @Patch(':memberId')
  @Authorized('members.write')
  @ApiOperation({
    summary: "Change a member's role",
    description:
      'Enforced by the role lattice: never your own membership, never a role above your own ' +
      'rank, never a member who outranks you, and never the last owner. The owner count is ' +
      'taken inside the same transaction as the write.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiParam({ name: 'memberId', example: 'mem_01J...' })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse({ description: 'The lattice refused the change.' })
  @ApiConflictResponse({ description: 'The change would leave the organization with no owner.' })
  async changeRole(
    @Tenant() context: RequestContext,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleDto,
  ): Promise<MemberDto> {
    return this.members.changeRole(context, memberId, dto);
  }

  @Delete(':memberId')
  @Authorized('members.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member',
    description:
      'Removal is a role change to "no role", so the same lattice applies - including the ' +
      'last-owner rule.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiParam({ name: 'memberId', example: 'mem_01J...' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'The lattice refused the removal.' })
  @ApiConflictResponse({ description: 'The removal would leave the organization with no owner.' })
  async remove(
    @Tenant() context: RequestContext,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    await this.members.remove(context, memberId);
  }
}
