import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import {
  MemberRole,
  Organization,
  OrganizationMember,
  OrganizationStatus,
  Prisma,
} from '@prisma/client';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  Page,
  Permission,
  RequestContext,
  ResolvedProject,
  permissionsForRole,
  permissionsUnderSuspension,
} from '../authz';
import { AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { AppError } from '../common/errors';
// See the docblock below. This
// file is the ONE place in the module allowed to hold the unscoped client, and
// it exists precisely so no service ever does. Allowlisted by exact filename in
// .eslintrc.json; the entry goes away when this moves into src/authz.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * USER SCOPE — the missing half of the authorization layer.
 *
 * `TenantGuard` answers "which organization is this request about, and may this
 * member touch it?". It cannot answer anything for a route that names no
 * organization, and `TenantResolver.coordinatesFromParams` deliberately throws
 * `internal_error` there rather than serving an unscoped request.
 *
 * Two routes in this product legitimately name no tenant, and both are asked
 * BEFORE the caller has one:
 *
 *   GET  /v1/organizations   — "which organizations do I belong to?"
 *   POST /v1/organizations   — "make me a new one"
 *
 * plus a third, once invitations exist: redeeming an invitation, where the
 * caller is by definition not yet a member of the organization named in the
 * token.
 *
 * The tempting shortcut is `@UseGuards(SessionGuard)` and an inline
 * `where: { members: { some: { userId } } }` in the service. That is the single
 * highest-value IDOR surface in the product written by hand, once per route,
 * with nothing structural to stop the next author dropping the predicate or
 * reading the user id off the request body. So it is a named primitive instead,
 * with the same shape and the same failure posture as the tenant layer:
 *
 *  - `@UserScoped()` mounts `SessionGuard` and `UserScopeGuard` in that order —
 *    guard order is execution order in Nest and the second reads what the first
 *    produced. Like `@Authorized()` it is a single decorator, so the pair cannot
 *    be mounted wrong or half-mounted.
 *  - The principal is derived from `request.sessionUser`, i.e. from the session
 *    cookie via `SessionService.verify` — never from a param, a body field or a
 *    header. There is no code path that lets a caller state a user id.
 *  - It fails CLOSED: no `sessionUser` is 401, and `UserScope` refuses to
 *    construct without a non-empty user id rather than building a scope whose
 *    predicate is `{ userId: undefined }` — which in Prisma matches every row.
 *  - Every query below carries the principal's user id in the WHERE clause, so
 *    a membership the caller does not hold matches zero rows in PostgreSQL
 *    rather than being fetched and then checked in application code. Same
 *    argument as `ScopedRepository`.
 *  - Writes bind `user_id` to the principal. `createOwnedOrganization` and
 *    `joinOrganization` take no user id argument at all, so neither can be used
 *    to create a membership in someone else's name.
 *
 * NOT a general-purpose escape hatch. Everything reachable here is either the
 * caller's own membership graph or a row the caller is being added to. Anything
 * addressed by `:orgId`/`:projectId` belongs to `@Authorized()`, and adding a
 * method here that reads another tenant's rows would defeat the whole layer.
 *
 * PLACEMENT: this belongs in `src/authz` next to `tenant-scope.ts` — see
 * HANDOFF.md. It is here because Phase 2 modules were told not to edit
 * `src/authz`, and one reviewed move is better than four modules each inventing
 * their own membership predicate in the meantime.
 */

/** Reflector key. Distinct from `authz:permissions` on purpose — see below. */
export const USER_SCOPE_METADATA = 'authz:user-scope';

/**
 * The authenticated principal, with nothing tenant-shaped on it.
 *
 * Deliberately not `RequestContext`: there is no organization, no role and no
 * permission set, and a type that pretended otherwise would let a user-scoped
 * handler be passed to something expecting a resolved tenant.
 */
export interface UserPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface UserScopedRequest extends AuthenticatedRequest {
  /** Set by `UserScopeGuard`. Read it through the `@Principal()` decorator. */
  userPrincipal?: UserPrincipal;
}

/**
 * Builds the principal from the session and nothing else.
 *
 * It enforces no permission — there is no tenant to hold one in — and that is
 * the entire contract: "an authenticated human, acting only on their own
 * membership graph". A route that needs more than that is not user-scoped.
 */
@Injectable()
export class UserScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<UserScopedRequest>();
    const user = request.sessionUser;
    // Reachable only if someone mounted this guard without SessionGuard.
    if (!user?.userId) throw new AppError('unauthenticated', 'Authentication required.');

    request.userPrincipal = {
      userId: user.userId,
      email: user.email,
      sessionId: user.sessionId,
      ipAddress: request.ip ?? request.socket?.remoteAddress ?? null,
      userAgent: UserScopeGuard.userAgent(request),
    };
    return true;
  }

  private static userAgent(request: UserScopedRequest): string | null {
    const value = request.headers?.['user-agent'];
    return typeof value === 'string' ? value.slice(0, 512) : null;
  }
}

/**
 * The one decorator an untenanted route should carry.
 *
 * It does NOT set `authz:permissions` or `authz:tenant-spec`. That matters:
 * `assertRoutesAreGuarded` fails the boot for a route that declares
 * authorization metadata without `TenantGuard`, and a user-scoped route
 * genuinely has no tenant to resolve. Using its own key keeps the two
 * assertions from fighting, and because the guards are mounted by this
 * decorator itself there is no way to declare the metadata without the
 * enforcement — the failure mode that assertion exists to catch.
 */
export const UserScoped = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(SessionGuard, UserScopeGuard), SetMetadata(USER_SCOPE_METADATA, true));

/**
 * The request's principal. Fails closed, exactly like `@Tenant()`: a handler
 * that forgot `@UserScoped()` gets a 401 rather than an `undefined` it might
 * have destructured into an unfiltered query.
 */
export const Principal = createParamDecorator<unknown, ExecutionContext, UserPrincipal>(
  (_data, context) => {
    const request = context.switchToHttp().getRequest<UserScopedRequest>();
    if (!request.userPrincipal) {
      throw new AppError('unauthenticated', 'Authentication required.');
    }
    return request.userPrincipal;
  },
);

/** One row of "an organization I belong to". */
export interface MembershipSummary {
  membershipId: string;
  role: MemberRole;
  organization: Organization;
}

export interface CreatedMembership {
  organization: Organization;
  membership: OrganizationMember;
}

/**
 * What `joinOrganization` found, handed to the caller's `verify` callback so
 * the POLICY decision stays in the service and only the READS live here.
 */
export interface InvitationState {
  organization: Organization;
  /** The membership that issued the invitation, if it still exists here. */
  inviter: OrganizationMember | null;
  /** The principal's existing membership, if they are already in. */
  existing: OrganizationMember | null;
}

/** The slice of the client this scope uses. Narrow on purpose. */
type UserScopeClient = PrismaService;

export class UserScope {
  private constructor(
    private readonly client: UserScopeClient,
    readonly principal: UserPrincipal,
  ) {}

  /**
   * Fails closed on a principal with no user id. Prisma treats
   * `{ userId: undefined }` as "no filter", so an empty principal would turn
   * every query below into a full-table read; refusing to construct is the only
   * safe answer.
   */
  static create(client: UserScopeClient, principal: UserPrincipal): UserScope {
    if (!principal || typeof principal.userId !== 'string' || principal.userId.length === 0) {
      throw new AppError(
        'internal_error',
        'UserScope requires an authenticated principal. Mount @UserScoped() on the route.',
      );
    }
    return new UserScope(client, principal);
  }

  /**
   * Organizations the principal is a member of. The user id is in the WHERE
   * clause, so this cannot return anything else.
   *
   * Soft-deleted organizations are excluded here rather than filtered in the
   * handler: `TenantResolver.loadOrganization` already refuses them, so a row
   * returned by this listing that then 404s on click would be a bug the API
   * shipped to the dashboard.
   */
  async listMemberships(options?: { take?: number; skip?: number }): Promise<Page<MembershipSummary>> {
    const take = UserScope.pageSize(options?.take);
    const skip = UserScope.offset(options?.skip) ?? 0;
    // take + 1: the same probe `ScopedRepository.findPage` uses. A bounded read
    // that returns a bare array cannot tell its caller whether the bound was
    // reached, and this listing is bounded whether or not the caller said so.
    const rows = await this.client.organizationMember.findMany({
      where: this.predicate(),
      select: { id: true, role: true, organization: true },
      // Membership ids are ULIDs, so this is join order without depending on a
      // column the test fakes do not populate.
      orderBy: { id: 'asc' },
      take: take + 1,
      skip,
    });
    const hasMore = rows.length > take;
    return {
      rows: (hasMore ? rows.slice(0, take) : rows).map((row) => ({
        membershipId: row.id,
        role: row.role,
        organization: row.organization,
      })),
      hasMore,
      nextSkip: hasMore ? skip + take : null,
    };
  }

  async countMemberships(): Promise<number> {
    return this.client.organizationMember.count({ where: this.predicate() });
  }

  /**
   * How many live organizations this principal OWNS.
   *
   * `POST /v1/organizations` mints a row in a globally unique slug namespace
   * with no tenant to charge it to, so the per-user cap is the only quantity
   * bound on it. Owner-only rather than all memberships: being invited into
   * fifty organizations is somebody else's decision and must not stop you
   * creating your own.
   */
  async countOwnedOrganizations(): Promise<number> {
    return this.client.organizationMember.count({
      where: { ...this.predicate(), role: 'owner' },
    });
  }

  /**
   * Create an organization with the principal as its owner, atomically.
   *
   * There is no `userId` parameter, and there is no way to add one: the owner
   * membership is written for `principal.userId` or not at all. `andThen` runs
   * inside the same transaction so the audit row commits with the organization
   * it describes, or neither lands (ARCHITECTURE.md 49, and `AuditService`'s
   * own docblock).
   *
   * A `slug` collision surfaces as Prisma's P2002 to the caller, which retries
   * with a fresh suffix. That is the same shape `AuthService.register` uses and
   * for the same reason: the SELECT that would "check first" runs inside this
   * transaction and under READ COMMITTED cannot see a concurrent uncommitted
   * row, so the unique index is the only real authority. It also means this
   * scope never has to read another organization's row to answer "is that slug
   * free?" — which would be exactly the cross-tenant read it exists to prevent.
   */
  async createOwnedOrganization(input: {
    organization: { id: string; name: string; slug: string };
    membershipId: string;
    andThen?: (created: CreatedMembership, tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<CreatedMembership> {
    return this.client.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          id: input.organization.id,
          name: input.organization.name,
          slug: input.organization.slug,
        },
      });
      const membership = await tx.organizationMember.create({
        data: {
          id: input.membershipId,
          organizationId: organization.id,
          userId: this.principal.userId,
          role: 'owner',
        },
      });
      const created: CreatedMembership = { organization, membership };
      if (input.andThen) await input.andThen(created, tx);
      return created;
    });
  }

  /**
   * Redeem an invitation: add the principal to an organization they are not yet
   * in.
   *
   * This is the one place a membership is created for an organization the
   * caller has no access to, so every guard rail is here rather than in the
   * caller:
   *
   *  - the user id is the principal's, never an argument;
   *  - the organization, the inviting membership and any existing membership
   *    are all read INSIDE the transaction that writes, so the role the
   *    invitation claims is re-checked against the inviter's rank as it stands
   *    at redemption time, not as it stood when the mail was sent;
   *  - `verify` is the caller's policy hook and runs against those freshly read
   *    rows. It throws to refuse.
   *
   * An existing membership is returned unchanged rather than overwritten: a
   * replayed invitation must never be able to change a role that somebody has
   * since adjusted.
   *
   * That "already a member" branch also has to survive a RACE, which is what
   * the catch below is for. Two invitations to the same address, redeemed at
   * the same moment, both read `existing === null` under READ COMMITTED and both
   * INSERT; `@@unique([organizationId, userId])` rejects the loser with P2002
   * and the invitee got a 500 for an operation that had in fact succeeded. The
   * re-read happens OUTSIDE the transaction on purpose: a failed statement
   * aborts a PostgreSQL transaction, so `tx` is unusable by then.
   */
  async joinOrganization(input: {
    organizationId: string;
    invitedByMembershipId: string;
    membershipId: string;
    role: MemberRole;
    verify: (state: InvitationState) => void;
    andThen?: (created: CreatedMembership, tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<CreatedMembership> {
    try {
      return await this.join(input);
    } catch (err) {
      if (!UserScope.isMembershipCollision(err)) throw err;
      // Someone else's redemption for this same account landed first. Report
      // what is true: they are a member, at the role the winner wrote. No audit
      // row here - the transaction that actually created the membership filed
      // one.
      const settled = await this.readMembership(input.organizationId);
      if (!settled) throw err;
      return settled;
    }
  }

  private async join(input: {
    organizationId: string;
    invitedByMembershipId: string;
    membershipId: string;
    role: MemberRole;
    verify: (state: InvitationState) => void;
    andThen?: (created: CreatedMembership, tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<CreatedMembership> {
    return this.client.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
      });
      if (!organization) {
        throw new AppError('invalid_request', 'This invitation is invalid or has expired.');
      }

      const inviterRow = await tx.organizationMember.findUnique({
        where: { id: input.invitedByMembershipId },
      });
      // A membership row from another organization is no evidence about this
      // one; treat it as absent rather than as an inviter.
      const inviter =
        inviterRow && inviterRow.organizationId === organization.id ? inviterRow : null;

      const existing = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: this.principal.userId,
          },
        },
      });

      input.verify({ organization, inviter, existing });

      if (existing) return { organization, membership: existing };

      const membership = await tx.organizationMember.create({
        data: {
          id: input.membershipId,
          organizationId: organization.id,
          userId: this.principal.userId,
          role: input.role,
        },
      });
      const created: CreatedMembership = { organization, membership };
      if (input.andThen) await input.andThen(created, tx);
      return created;
    });
  }

  /**
   * The principal's membership of one organization, with the organization row.
   * Still bound to `principal.userId`, so this reads nobody else's membership.
   */
  private async readMembership(organizationId: string): Promise<CreatedMembership | null> {
    const membership = await this.client.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: this.principal.userId },
      },
    });
    if (!membership) return null;
    const organization = await this.client.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization) return null;
    return { organization, membership };
  }

  /**
   * A P2002 on `organization_members (organization_id, user_id)`, and nothing
   * else. Duck-typed and matched by index for the reason
   * `projects/unique-violation.ts` states at length: a bare `code === 'P2002'`
   * would launder a collision on some other index into "you are already a
   * member", which is a false statement about a request that failed for a
   * different reason.
   */
  private static isMembershipCollision(err: unknown): boolean {
    if (typeof err !== 'object' || err === null || !('code' in err)) return false;
    if ((err as { code?: unknown }).code !== 'P2002') return false;
    const raw = (err as { meta?: { target?: unknown } }).meta?.target;
    const target = (
      Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
    ).toLowerCase();
    return target.includes('organization_id') || target.includes('organizationid');
  }

  /** The predicate, built once. Never assembled by a caller. */
  private predicate(): Prisma.OrganizationMemberWhereInput {
    return {
      userId: this.principal.userId,
      organization: { status: { not: 'deleted' } },
    };
  }

  private static pageSize(take?: number): number {
    if (take === undefined || !Number.isFinite(take)) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.max(1, Math.floor(take)), MAX_PAGE_SIZE);
  }

  private static offset(skip?: number): number | undefined {
    if (skip === undefined || !Number.isFinite(skip)) return undefined;
    return Math.max(0, Math.floor(skip));
  }
}

@Injectable()
export class UserScopeFactory {
  constructor(private readonly prisma: PrismaService) {}

  for(principal: UserPrincipal): UserScope {
    return UserScope.create(this.prisma, principal);
  }
}

/**
 * A `RequestContext` for a membership that was created microseconds ago.
 *
 * `AuditService.recordFor` takes a resolved tenant context precisely so a
 * caller cannot choose the organization or the actor it files a row against —
 * `write` is private for that reason. Organization creation and invitation
 * acceptance both produce a privileged fact that must be audited and have no
 * resolved context, because the membership the resolver would have read did not
 * exist when the request started.
 *
 * Every field here comes out of rows written in the same transaction, or off
 * the session. Nothing comes from the request body, so this cannot be used to
 * forge an actor or an organization — the same guarantee `TenantResolver`
 * gives, established a different way.
 */
export function contextForNewMembership(
  principal: UserPrincipal,
  organization: Organization,
  membership: OrganizationMember,
): RequestContext {
  const granted = permissionsForRole(membership.role);
  const permissions =
    organization.status === ('suspended' satisfies OrganizationStatus)
      ? permissionsUnderSuspension(granted)
      : granted;

  return {
    user: {
      userId: principal.userId,
      email: principal.email,
      sessionId: principal.sessionId,
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
    },
    membershipId: membership.id,
    role: membership.role,
    permissions,
    project: null,
    ipAddress: principal.ipAddress,
    userAgent: principal.userAgent,
    has: (permission: Permission): boolean => permissions.has(permission),
    requireProject: (): ResolvedProject => {
      throw new AppError(
        'internal_error',
        'This context was built for a newly created membership and names no project.',
      );
    },
  };
}
