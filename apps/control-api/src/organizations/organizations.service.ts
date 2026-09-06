import { Injectable, Logger } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { AuditService, RequestContext, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import {
  CreateOrganizationDto,
  OrganizationDto,
  OrganizationListDto,
  PageQueryDto,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  UpdateOrganizationDto,
  toOrganizationDto,
} from './dto';
import { UserPrincipal, UserScopeFactory, contextForNewMembership } from './user-scope';

const UNIQUE_VIOLATION = 'P2002';

/**
 * How many times `create` re-runs with a fresh slug suffix before giving up.
 * The first attempt uses the bare derived slug; the rest add six random
 * characters, so exhausting five is not a case worth engineering around.
 */
const MAX_SLUG_ATTEMPTS = 5;

/**
 * Organizations (ARCHITECTURE.md 8).
 *
 * The module splits cleanly in two, and the split is the security story:
 *
 *  - `list` and `create` name no organization. They go through `UserScope`,
 *    which puts the SESSION's user id in the WHERE clause of every read and
 *    binds it to every membership it writes. See `user-scope.ts`.
 *  - `get`, `update` and `remove` are addressed by `:orgId` and go through
 *    `@Authorized()` + `TenantScopeFactory`, so a cross-tenant id is a 404 from
 *    the guard before this class is entered at all.
 *
 * Deletion is a SOFT delete. `organizations` sits at the top of the ownership
 * chain the delivery ledger hangs off, `deliveries.event_id`/`endpoint_id` are
 * `ON DELETE RESTRICT` (see HANDOFF, "Delivery ledger is no longer
 * cascade-deletable"), and the whole point of that table is to answer "did
 * finance ever receive this?" months later. There is no hard-delete path here,
 * and there should not be one.
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly users: UserScopeFactory,
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Untenanted: the caller's own membership graph
  // -------------------------------------------------------------------------

  /**
   * "Which organizations do I belong to?"
   *
   * Every row comes from `organization_members` filtered by the principal's own
   * user id. There is no parameter that could widen it, so this endpoint cannot
   * be turned into a directory of the platform's customers.
   */
  async list(principal: UserPrincipal, page: PageQueryDto): Promise<OrganizationListDto> {
    const scope = this.users.for(principal);
    const [memberships, total] = await Promise.all([
      scope.listMemberships({ take: page.limit, skip: page.offset }),
      scope.countMemberships(),
    ]);

    return {
      data: memberships.map((membership) =>
        toOrganizationDto(membership.organization, membership.role),
      ),
      total,
      limit: page.limit ?? memberships.length,
      offset: page.offset ?? 0,
    };
  }

  /**
   * Create an organization; the caller becomes its owner.
   *
   * The organization, the owner membership and the audit row are ONE
   * transaction. A half-created organization is not a partial success: it is
   * either a tenant nobody can administer (no owner membership) or a membership
   * pointing at nothing, and both need a database session to clean up.
   *
   * Slug allocation deliberately never reads another organization's row. A
   * derived slug that collides is retried with a suffix — the unique index is
   * the authority, exactly as in `AuthService.register`, because a SELECT inside
   * this transaction cannot see a concurrent uncommitted row under READ
   * COMMITTED. An explicitly requested slug is NOT retried: silently handing
   * back `acme-x7f2q` when the caller asked for `acme` is worse than a 409.
   */
  async create(principal: UserPrincipal, dto: CreateOrganizationDto): Promise<OrganizationDto> {
    const scope = this.users.for(principal);
    const name = dto.name.trim();
    const explicitSlug = dto.slug?.trim();

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = explicitSlug ?? OrganizationsService.deriveSlug(name, attempt > 0);
      try {
        const created = await scope.createOwnedOrganization({
          organization: { id: newId('organization'), name, slug },
          membershipId: newId('member'),
          andThen: async ({ organization, membership }, tx) => {
            // Built from the rows this transaction just wrote, never from the
            // request body - see `contextForNewMembership`.
            await this.audit.recordFor(
              contextForNewMembership(principal, organization, membership),
              {
                action: 'organization.created',
                resourceType: 'organization',
                resourceId: organization.id,
                metadata: { name: organization.name, slug: organization.slug, role: 'owner' },
              },
              tx,
            );
          },
        });
        return toOrganizationDto(created.organization, created.membership.role);
      } catch (err) {
        if (!OrganizationsService.isSlugCollision(err)) throw err;
        if (explicitSlug) {
          throw new AppError('conflict', 'That organization slug is already taken.');
        }
        // Derived slug lost a race, or the bare form was already held. Nothing
        // committed; go again with a fresh suffix.
        this.logger.debug(`Slug "${slug}" collided on attempt ${attempt}; retrying with a suffix.`);
      }
    }

    throw new AppError(
      'conflict',
      'Could not allocate an organization slug. Try a different name, or supply one explicitly.',
    );
  }

  // -------------------------------------------------------------------------
  // Tenant-scoped: addressed by :orgId
  // -------------------------------------------------------------------------

  /**
   * The context has already been resolved and membership proven by
   * `TenantGuard`, but the row is re-read through the scope rather than
   * assembled from `context.organization`: the context carries only the four
   * columns the resolver selects, and the client wants the timestamps too.
   */
  async get(context: RequestContext): Promise<OrganizationDto> {
    const organization = await this.scopes
      .for(context)
      .organization.requireById(context.organization.id);
    return toOrganizationDto(organization, context.role);
  }

  async update(context: RequestContext, dto: UpdateOrganizationDto): Promise<OrganizationDto> {
    const changes: { name?: string; slug?: string } = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.slug !== undefined) changes.slug = dto.slug.trim();
    if (Object.keys(changes).length === 0) {
      throw new AppError('invalid_request', 'Supply at least one of name or slug.');
    }

    const scope = this.scopes.for(context);
    let updated: Organization;
    try {
      updated = await scope.organization.updateById(context.organization.id, changes);
    } catch (err) {
      if (OrganizationsService.isSlugCollision(err)) {
        throw new AppError('conflict', 'That organization slug is already taken.');
      }
      throw err;
    }

    await this.audit.recordFor(context, {
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: updated.id,
      // Before AND after: "who renamed this?" is unanswerable from the new
      // value alone, and the audit log is where that question gets asked.
      metadata: {
        from: { name: context.organization.name, slug: context.organization.slug },
        to: { name: updated.name, slug: updated.slug },
      },
    });
    return toOrganizationDto(updated, context.role);
  }

  /**
   * Soft delete. `status = 'deleted'` and nothing else.
   *
   * Owner only. The permission matrix has no `organizations.write` — the
   * closest declared answer for the `organization` accessor is `projects.write`,
   * which `admin` holds — and letting an admin retire the tenant that owns
   * everyone else's data is a bigger grant than "may create projects". The
   * check is explicit here rather than smuggled into a permission, and the
   * matrix gap is written up in HANDOFF.md.
   *
   * `TenantResolver.loadOrganization` refuses a deleted organization, so this
   * is a one-way door through the API: every route under `:orgId` starts
   * answering 404 immediately, for every member.
   */
  async remove(context: RequestContext): Promise<void> {
    if (context.role !== 'owner') {
      throw new AppError(
        'forbidden',
        'Only an owner can delete an organization. Ask an owner to do it.',
      );
    }

    const scope = this.scopes.for(context);
    await scope.organization.updateById(context.organization.id, { status: 'deleted' });
    await this.audit.recordFor(context, {
      action: 'organization.deleted',
      resourceType: 'organization',
      resourceId: context.organization.id,
      metadata: { name: context.organization.name, slug: context.organization.slug },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * A slug from a display name. Never reads the table — see `create`.
   *
   * A name with nothing slug-safe in it ("!!!", "日本") would otherwise produce
   * an empty slug and a row nobody can address; `bootstrap` had the same bug and
   * now rejects it loudly. Here the name is already validated for length only,
   * so the fallback is a suffixed default rather than an error.
   */
  private static deriveSlug(name: string, forceSuffix: boolean): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LENGTH);

    const stem = base.length >= SLUG_MIN_LENGTH ? base : 'workspace';
    if (!forceSuffix && base.length >= SLUG_MIN_LENGTH) return stem;
    return `${stem.slice(0, SLUG_MAX_LENGTH - 7)}-${OrganizationsService.suffix()}`;
  }

  private static suffix(): string {
    return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }

  /**
   * A P2002 naming `slug`, and nothing else.
   *
   * Duck-typed rather than `instanceof PrismaClientKnownRequestError` for the
   * reason `AuthService.uniqueViolationTarget` gives: the error crosses a module
   * boundary and a duplicated `@prisma/client` in the tree silently breaks
   * instanceof. A unique violation from any OTHER index must surface as itself
   * rather than be laundered into "slug taken".
   */
  private static isSlugCollision(err: unknown): boolean {
    if (typeof err !== 'object' || err === null || !('code' in err)) return false;
    if ((err as { code?: unknown }).code !== UNIQUE_VIOLATION) return false;
    const raw = (err as { meta?: { target?: unknown } }).meta?.target;
    const target = (
      Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
    ).toLowerCase();
    return target.includes('slug');
  }
}
