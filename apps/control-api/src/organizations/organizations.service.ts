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
  SLUG_PATTERN,
  UpdateOrganizationDto,
  toOrganizationDto,
} from './dto';
import { TenantTransactionRunner } from './tenant-transaction';
import { UserPrincipal, UserScopeFactory, contextForNewMembership } from './user-scope';

const UNIQUE_VIOLATION = 'P2002';

/**
 * How many times `create` re-runs with a fresh slug suffix before giving up.
 * The first attempt uses the bare derived slug; the rest add six random
 * characters, so exhausting five is not a case worth engineering around.
 */
const MAX_SLUG_ATTEMPTS = 5;

/**
 * How many live organizations one account may OWN.
 *
 * `POST /v1/organizations` is an authenticated but untenanted write into a
 * GLOBALLY unique slug namespace: there is no tenant to charge it to, no quota
 * behind it, and squatting the namespace costs an attacker one session and a
 * loop. The route is throttled per address and per session as well, but a rate
 * limit bounds the RATE and this bounds the TOTAL - a patient script defeats
 * only the first.
 *
 * Ten is a working number, not a product decision: it is well above what a real
 * account does and well below what a script wants. It belongs in the plan
 * limits when billing lands - see HANDOFF.md.
 */
export const MAX_ORGANIZATIONS_PER_USER = 10;

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
    private readonly transactions: TenantTransactionRunner,
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
    // A `Page`, not a bare array: `listMemberships` is bounded whether or not
    // the caller named a limit, and the page carries `hasMore` so a truncated
    // read is a fact rather than a silence.
    //
    // The second read - `countMemberships` - is gone with `total`. It was a
    // COUNT on every request, taken at a different instant from the rows, whose
    // only use was letting a client infer what `hasMore` already states exactly.
    const memberships = await scope.listMemberships({ take: page.limit, skip: page.offset });

    return {
      data: memberships.rows.map((membership) =>
        toOrganizationDto(membership.organization, membership.role),
      ),
      has_more: memberships.hasMore,
      next_offset: memberships.nextSkip,
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

    // Checked before the write and deliberately NOT inside the transaction: two
    // simultaneous creates could take one account to eleven, which is a rounding
    // error against a bound whose job is to stop an unbounded loop. Serialising
    // every organization creation on the platform to make 10 exact would be a
    // much worse trade.
    const owned = await scope.countOwnedOrganizations();
    if (owned >= MAX_ORGANIZATIONS_PER_USER) {
      // `limit_exceeded`, not `conflict`. Two lines below, a taken slug raises a
      // genuine `conflict`; before this code existed a client had to tell a
      // ceiling from a collision by reading the sentence, which breaks the first
      // time someone rewords it. The details are the contract.
      throw new AppError(
        'limit_exceeded',
        `You already own ${MAX_ORGANIZATIONS_PER_USER} organizations, which is the limit. Delete one, or ask to have the limit raised.`,
        { limit: MAX_ORGANIZATIONS_PER_USER, current: owned, resource: 'organizations' },
      );
    }

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
   * Soft delete: the organization AND every project under it, in one
   * transaction.
   *
   * Owner only. The permission matrix has no `organizations.write` — the
   * closest declared answer for the `organization` accessor is `projects.write`,
   * which `admin` holds — and letting an admin retire the tenant that owns
   * everyone else's data is a bigger grant than "may create projects". The
   * check is explicit here rather than smuggled into a permission, and the
   * matrix gap is written up in HANDOFF.md.
   *
   * ## Why the projects go too
   *
   * Setting `organizations.status = 'deleted'` alone stopped the CONTROL plane
   * and nothing else, and the two halves failed in opposite directions:
   *
   *  - The data plane never reads `organizations`. `findAPIKeySQL`
   *    (services/data-plane/internal/ingest/store.go) joins `api_keys` to
   *    `projects`, and handler.go gates on `key.ProjectStatus != "active"`. So
   *    every `wk_live_`/`wk_test_` key kept authenticating after deletion and
   *    events kept being ingested and stored, indefinitely.
   *  - `TenantResolver.loadOrganization` DOES refuse a deleted organization, so
   *    every route under `/v1/organizations/:orgId` and
   *    `/v1/projects/:projectId` answered 404 for every member. They could not
   *    list projects, delete them, or revoke a key to stop the ingest. There is
   *    no undelete; recovery was a psql session.
   *
   * Soft-deleting the projects makes the gate the data plane ALREADY has fire.
   * No Go change is needed, and it is the same one-way door either way: this
   * cascade is why the button is owner-only.
   *
   * Still no hard delete anywhere: `deliveries.event_id`/`endpoint_id` are
   * `ON DELETE RESTRICT` and the ledger has to answer "did finance ever receive
   * this?" months later. Members are untouched for the same reason - the audit
   * trail names them.
   */
  async remove(context: RequestContext): Promise<void> {
    if (context.role !== 'owner') {
      throw new AppError(
        'forbidden',
        'Only an owner can delete an organization. Ask an owner to do it.',
      );
    }

    await this.transactions.run(context, async (scope, audit) => {
      // Projects first: if anything fails, the transaction rolls back and the
      // organization is still administrable. The predicate is stated rather
      // than omitted because `ScopedRepository.updateMany` requires one - an
      // empty `where` reads as innocuous and rewrites every row in the tenant -
      // and it is the exact form that docblock names.
      const projects = await scope.projects.updateMany(
        { status: { not: 'deleted' } },
        { status: 'deleted' },
      );
      await scope.organization.updateById(context.organization.id, { status: 'deleted' });
      await audit.record({
        action: 'organization.deleted',
        resourceType: 'organization',
        resourceId: context.organization.id,
        metadata: {
          name: context.organization.name,
          slug: context.organization.slug,
          // The operator question this answers at 2am: "why did that project's
          // ingest stop?" - because this happened, and to how many.
          projects_deleted: projects,
        },
      });
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
   *
   * The `.slice()` used to come AFTER the edge-hyphen strip and the result was
   * never re-tested, so a name whose 48th character landed on a separator
   * ("A very long company name ... and Partners") wrote `...-and-` - a slug that
   * violates `SLUG_PATTERN`, which is the pattern this module's own DTO
   * declares. It was accepted on create and then REJECTED with a 400 if an owner
   * PATCHed the same value back, which is the worst shape a validation
   * disagreement can take. `projects/slug.ts` already got this right: strip
   * trailing hyphens after the slice, re-test the pattern, and treat a failure
   * as "nothing usable survived" rather than writing it.
   */
  private static deriveSlug(name: string, forceSuffix: boolean): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LENGTH)
      // The slice can cut mid-separator; this is what stops `acme-` being
      // written. Leading hyphens cannot survive the strip above.
      .replace(/-+$/g, '');

    const usable = base.length >= SLUG_MIN_LENGTH && SLUG_PATTERN.test(base);
    const stem = usable ? base : 'workspace';
    if (!forceSuffix && usable) return stem;
    // The suffixed form is re-tested too: `stem` is pattern-clean and the slice
    // for the suffix can land on a hyphen just as easily.
    const head = stem.slice(0, SLUG_MAX_LENGTH - 7).replace(/-+$/g, '') || 'workspace';
    return `${head}-${OrganizationsService.suffix()}`;
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
