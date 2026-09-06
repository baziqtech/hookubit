import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemberRole, OrganizationMember, Prisma } from '@prisma/client';
import {
  AuditService,
  MEMBER_ROLES,
  RequestContext,
  TenantScopeFactory,
  assertMemberRemovalAllowed,
  assertRoleChangeAllowed,
  mayAssignRole,
} from '../authz';
import { TokenService } from '../auth/token.service';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import {
  PageQueryDto,
  TenantTransactionRunner,
  UserDirectory,
  UserPrincipal,
  UserScopeFactory,
  contextForNewMembership,
  toOrganizationDto,
} from '../organizations';
import {
  AcceptInvitationDto,
  AcceptedInvitationDto,
  InvitationAcceptedDto,
  InviteMemberDto,
  MemberDto,
  MemberListDto,
  UpdateMemberRoleDto,
  toMemberDto,
} from './dto';
import { INVITATION_MAILER, InvitationMailer } from './invitation-mailer.port';

/**
 * The single sentence every failed redemption gets. Wrong token, consumed
 * token, expired token, token issued for a different address: one answer, for
 * the same reason `TokenService.consume` returns one null.
 */
const INVALID_INVITATION = 'This invitation is invalid or has expired.';

/** What an `invitation` row in `user_tokens.metadata` carries. */
interface InvitationMetadata {
  organizationId: string;
  role: MemberRole;
  invitedByMembershipId: string;
  invitedByUserId: string;
}

/**
 * Memberships and invitations (ARCHITECTURE.md 10, 49).
 *
 * ## The lattice is enforced HERE, on every path
 *
 * `assertRoleChangeAllowed` and friends are advisory: nothing in
 * `ScopedRepository` routes `members` through them, `role` is an ordinary
 * writable scalar on `OrganizationMemberUncheckedUpdateManyInput`, and there is
 * no `assertMemberCreationAllowed` at all. Three escalation paths follow
 * directly from that, and all three are closed in this class rather than left
 * to a caller remembering:
 *
 *  1. **Creation.** `scope.members.create({ userId, role: 'owner' })` mints an
 *     owner with no check whatsoever. This service NEVER calls
 *     `members.create`. The only membership-creating path is
 *     `UserScope.joinOrganization`, reached from `accept`, which binds
 *     `user_id` to the redeeming session and re-checks the inviter's rank
 *     inside the writing transaction.
 *  2. **Role assignment.** `updateById(id, { role })` skips the lattice
 *     entirely. `changeRole` below is the only method in this module that
 *     writes `role`, and it calls `assertRoleChangeAllowed` first, every time.
 *     `invite` gates the role a second time at issue with `mayAssignRole`, so
 *     an admin cannot even put `owner` into a token.
 *  3. **Arbitrary user ids.** `users` is not tenant-owned, so there is no
 *     sibling repository for `ScopedRepository` to validate `userId` against
 *     and an admin could add any account on the platform to their organization
 *     without consent. No route in this module accepts a user id. Membership
 *     requires the invitee to present a single-use token from their own mailbox
 *     while holding their own session.
 *
 * The authz-side fixes that would make these structural rather than
 * conventional - reserving `role`/`userId` as unwritable on the members
 * repository, and an `assertMemberCreationAllowed` next to the other two - are
 * written up in HANDOFF.md.
 *
 * ## Owner counting is transactional
 *
 * `RoleChange.ownerCount`'s own docblock: "Count it inside the same transaction
 * as the update, or two concurrent demotions each see two owners and leave
 * zero." An organization with no owner cannot be recovered through the API, so
 * `changeRole` and `remove` both run through `TenantTransactionRunner`: the
 * count, the lattice check, the write and the audit row are one transaction.
 *
 * ## Invitations never confirm an address
 *
 * `invite` answers 202 whether the address is already a member, already has an
 * account, or is unknown. The auth module pays for that posture on every route
 * it has (uniform login errors, a 202 registration, silent forgot-password);
 * an invite endpoint that 409'd on "already a member" would be a membership
 * oracle for any developer-turned-admin and would make the rest of that work
 * pointless. The address owner is told instead - they are entitled to know.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly transactions: TenantTransactionRunner,
    private readonly users: UserScopeFactory,
    private readonly directory: UserDirectory,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(INVITATION_MAILER) private readonly mailer: InvitationMailer,
  ) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * The member rows come out of the tenant-scoped repository, so the ids handed
   * to `UserDirectory` are already proven to be inside this organization - the
   * precondition that directory's docblock states.
   */
  async list(context: RequestContext, page: PageQueryDto): Promise<MemberListDto> {
    const scope = this.scopes.for(context);
    const [members, total] = await Promise.all([
      scope.members.findMany({ orderBy: { id: 'asc' }, take: page.limit, skip: page.offset }),
      scope.members.count(),
    ]);
    const identities = await this.directory.byIds(members.map((member) => member.userId));

    return {
      data: members.map((member) => toMemberDto(member, identities.get(member.userId))),
      total,
      limit: page.limit ?? members.length,
      offset: page.offset ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Invite
  // -------------------------------------------------------------------------

  /**
   * Issue an invitation. Always 202.
   *
   * The role is gated at ISSUE as well as at redemption: `mayAssignRole` is the
   * creation-side lattice check that `authz/permissions.ts` does not yet
   * export, so an admin cannot mint an owner-shaped token and cannot hand out a
   * role above their own rank. `members.write` has already been checked by
   * `@Authorized`; this is the second axis.
   *
   * Both branches send mail and both swallow transport failures. That is not
   * laziness: if a mailer error escaped, a degraded SMTP transport would answer
   * 500 for an address that is already a member and 202 for one that is not -
   * the exact oracle the uniform 202 exists to close (HANDOFF, FIX 3).
   */
  async invite(context: RequestContext, dto: InviteMemberDto): Promise<InvitationAcceptedDto> {
    MembersService.assertMayAssign(context.role, dto.role);

    const email = dto.email.trim().toLowerCase();
    const scope = this.scopes.for(context);

    const identity = await this.directory.findByEmail(email);
    const existing = identity
      ? await scope.members.findFirst({ where: { userId: identity.id } })
      : null;

    if (existing) {
      // Not an error the caller may observe. The address owner is told; the
      // caller gets the same 202 as every other outcome.
      await this.audit.recordFor(context, {
        action: 'member.invite_ignored',
        resourceType: 'member',
        resourceId: existing.id,
        metadata: { email, reason: 'already_a_member', requested_role: dto.role },
      });
      await this.safely('already-a-member notice', () =>
        this.mailer.sendAlreadyMemberNotice(email, context.organization.name),
      );
      return { status: 'accepted' };
    }

    const metadata: InvitationMetadata = {
      organizationId: context.organization.id,
      role: dto.role,
      invitedByMembershipId: context.membershipId,
      invitedByUserId: context.user.userId,
    };

    // Audited BEFORE the mail: "who invited this person" must be answerable
    // even if the transport was down, and it is the record the redemption below
    // is checked against.
    await this.audit.recordFor(context, {
      action: 'member.invited',
      resourceType: 'member',
      resourceId: null,
      metadata: { email, role: dto.role },
    });

    await this.safely('invitation', async () => {
      const issued = await this.tokens.issue({
        type: 'invitation',
        email,
        // Not linked to a user row even when one exists: the token proves the
        // address, and `accept` re-checks it against the redeeming session.
        userId: null,
        metadata: metadata as unknown as Prisma.InputJsonValue,
      });
      await this.mailer.sendInvitation({
        email,
        organizationName: context.organization.name,
        invitedByEmail: context.user.email,
        role: dto.role,
        rawToken: issued.raw,
      });
    });

    return { status: 'accepted' };
  }

  // -------------------------------------------------------------------------
  // Role change
  // -------------------------------------------------------------------------

  /**
   * The ONLY path in this module that writes `organization_members.role`.
   *
   * Everything the lattice needs is read inside the transaction that writes:
   * the target's current role (via the tenant-scoped repository, so a
   * cross-tenant id is a 404 and not a 403) and the live owner count.
   */
  async changeRole(
    context: RequestContext,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ): Promise<MemberDto> {
    const updated = await this.transactions.run(context, async (scope, tx) => {
      const target = await scope.members.requireById(memberId);
      const ownerCount = await scope.members.count({ role: 'owner' });

      assertRoleChangeAllowed({
        actorRole: context.role,
        actorMembershipId: context.membershipId,
        targetMembershipId: target.id,
        currentRole: target.role,
        nextRole: dto.role,
        ownerCount,
      });

      // A no-op is allowed but not recorded: an audit trail full of
      // "changed developer to developer" is a trail nobody reads.
      if (target.role === dto.role) return target;

      const changed = await scope.members.updateById(memberId, { role: dto.role });
      await this.audit.recordFor(
        context,
        {
          action: 'member.role_changed',
          resourceType: 'member',
          resourceId: changed.id,
          metadata: { user_id: changed.userId, from: target.role, to: changed.role },
        },
        tx,
      );
      return changed;
    });

    return this.withIdentity(updated);
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  /**
   * Remove a membership. A hard DELETE, and deliberately so: nothing in the
   * delivery ledger hangs off `organization_members` - `audit_logs` references
   * `users` and `organizations`, not the membership - so the append-only
   * argument that makes endpoints and projects soft-deletable does not apply.
   * The audit row naming the removed user survives regardless.
   */
  async remove(context: RequestContext, memberId: string): Promise<void> {
    await this.transactions.run(context, async (scope, tx) => {
      const target = await scope.members.requireById(memberId);
      const ownerCount = await scope.members.count({ role: 'owner' });

      assertMemberRemovalAllowed({
        actorRole: context.role,
        actorMembershipId: context.membershipId,
        targetMembershipId: target.id,
        currentRole: target.role,
        ownerCount,
      });

      await scope.members.deleteById(memberId);
      await this.audit.recordFor(
        context,
        {
          action: 'member.removed',
          resourceType: 'member',
          resourceId: target.id,
          metadata: { user_id: target.userId, role: target.role },
        },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Redemption
  // -------------------------------------------------------------------------

  /**
   * Redeem an invitation. User-scoped: the caller is not a member of the target
   * organization yet, so there is no tenant to resolve and `@Authorized()`
   * would - correctly - answer 404.
   *
   * Three things are proved before a row is written, and the last two happen
   * inside the writing transaction:
   *
   *  1. the token is live, unconsumed and unexpired (`TokenService.consume`, a
   *     conditional UPDATE, so two concurrent redemptions race in PostgreSQL
   *     and exactly one wins);
   *  2. it was issued to the address on the redeeming SESSION - a leaked link
   *     is not enough on its own;
   *  3. the membership that issued it still exists in that organization and
   *     still outranks the role being granted. An admin who invited someone as
   *     an admin and was since demoted cannot have that invitation land.
   *
   * Known trade-off: consumption happens before the checks in (3), so a
   * redemption refused there burns the token and the inviter must re-issue.
   * Consuming afterwards would mean a token that can be presented repeatedly
   * while any check fails, which is the worse direction for a credential that
   * grants membership.
   */
  async accept(
    principal: UserPrincipal,
    dto: AcceptInvitationDto,
  ): Promise<AcceptedInvitationDto> {
    const record = await this.tokens.consume(dto.token, 'invitation');
    if (!record) throw new AppError('invalid_request', INVALID_INVITATION);

    const metadata = MembersService.parseInvitation(record.metadata);
    if (!metadata) {
      this.logger.error(
        `Invitation token ${record.id} carries unusable metadata; refusing to redeem it.`,
      );
      throw new AppError('invalid_request', INVALID_INVITATION);
    }

    // The token proves possession of a mailbox; the session proves who is
    // asking. They have to be the same person, or an intercepted link is a
    // complete account-free path into someone else's organization.
    if (record.email.toLowerCase() !== principal.email.trim().toLowerCase()) {
      throw new AppError('invalid_request', INVALID_INVITATION);
    }

    const created = await this.users.for(principal).joinOrganization({
      organizationId: metadata.organizationId,
      invitedByMembershipId: metadata.invitedByMembershipId,
      membershipId: newId('member'),
      role: metadata.role,
      verify: ({ organization, inviter, existing }) => {
        if (existing) return;
        if (organization.status !== 'active') {
          throw new AppError(
            'conflict',
            'That organization is not accepting new members right now.',
          );
        }
        if (!inviter) {
          throw new AppError(
            'conflict',
            'The member who invited you is no longer part of that organization. Ask for a new invitation.',
          );
        }
        // The creation-side lattice check, re-run against the inviter's rank as
        // it stands NOW. Without this, an invitation issued by an owner who has
        // since been demoted to viewer would still mint an owner.
        if (!mayAssignRole(inviter.role, metadata.role)) {
          throw new AppError(
            'conflict',
            'The member who invited you can no longer grant that role. Ask for a new invitation.',
          );
        }
      },
      andThen: async ({ organization, membership }, tx) => {
        await this.audit.recordFor(
          contextForNewMembership(principal, organization, membership),
          {
            action: 'member.joined',
            resourceType: 'member',
            resourceId: membership.id,
            metadata: {
              user_id: membership.userId,
              role: membership.role,
              invited_by_membership_id: metadata.invitedByMembershipId,
              invited_by_user_id: metadata.invitedByUserId,
            },
          },
          tx,
        );
      },
    });

    return {
      organization: toOrganizationDto(created.organization, created.membership.role),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The creation-side half of the role lattice.
   *
   * `assertRoleChangeAllowed` covers updates and `assertMemberRemovalAllowed`
   * covers removals; nothing covers "may you bring someone in AT this role",
   * which is the same escalation by another door. `mayAssignRole` already
   * encodes both conditions (holds `members.write`, and the target role is not
   * ranked above the actor's), so this is the missing assertion rather than a
   * new rule. It belongs beside the other two - see HANDOFF.md.
   */
  private static assertMayAssign(actorRole: MemberRole, targetRole: MemberRole): void {
    if (!mayAssignRole(actorRole, targetRole)) {
      throw new AppError('forbidden', `You may not assign the role "${targetRole}".`);
    }
  }

  private async withIdentity(member: OrganizationMember): Promise<MemberDto> {
    const identities = await this.directory.byIds([member.userId]);
    return toMemberDto(member, identities.get(member.userId));
  }

  /**
   * Metadata comes back out of our own database, but it is still parsed rather
   * than cast: a hand-edited row, or a token written by an older version of
   * this code, must not become an unchecked `MemberRole` on its way into a
   * membership INSERT.
   */
  private static parseInvitation(value: unknown): InvitationMetadata | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const organizationId = raw.organizationId;
    const role = raw.role;
    const invitedByMembershipId = raw.invitedByMembershipId;
    const invitedByUserId = raw.invitedByUserId;

    if (typeof organizationId !== 'string' || organizationId.length === 0) return null;
    if (typeof invitedByMembershipId !== 'string' || invitedByMembershipId.length === 0) return null;
    if (typeof invitedByUserId !== 'string' || invitedByUserId.length === 0) return null;
    if (typeof role !== 'string' || !MEMBER_ROLES.includes(role as MemberRole)) return null;

    return {
      organizationId,
      role: role as MemberRole,
      invitedByMembershipId,
      invitedByUserId,
    };
  }

  /**
   * Mail is best-effort, for the reason `invite` gives. The failure is logged
   * with the organization id only - never the token, never the address, both of
   * which are exactly what an attacker reading logs would want.
   */
  private async safely(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.logger.error(
        `Failed to deliver a member ${what}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}
