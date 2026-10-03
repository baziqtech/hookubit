import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment, Prisma, Project, ProjectStatus } from '@prisma/client';
import {
  AuditService,
  MAX_PAGE_SIZE,
  RequestContext,
  ScopedUpdateInput,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
import { DELIVERABLE_ENDPOINT_WHERE } from '../endpoints/deliverable';
import { normaliseAllowedIps } from './allowed-ips';
import { ProjectTemplateService, type TemplateResult } from './project-template.service';
import { newId } from '../common/ids';
import {
  CreateProjectDto,
  CreatedProjectDto,
  ListProjectsQueryDto,
  ProjectDto,
  ProjectListDto,
  UpdateProjectDto,
  toProjectDto,
} from './dto';
import { withCrossTenantNotFound } from './not-found';
import { PROJECTS_PER_ORGANIZATION, maxProjectsPerOrganization } from './project-limits';
import { slugFromName } from './slug';
import { isUniqueViolationOn, uniqueViolationTarget } from './unique-violation';

type ProjectUpdate = ScopedUpdateInput<Prisma.ProjectUncheckedUpdateManyInput>;

/**
 * Projects: the unit of tenancy everything below an organization hangs off.
 *
 * Two invariants this service exists to hold, both of which are cheap now and
 * unfixable later:
 *
 * **`environment` is immutable.** A project's environment decides which API
 * keys authenticate against it (`wk_live_` vs `wk_test_`, re-checked by the Go
 * ingest path on every request) and which traffic its endpoints receive. A flip
 * from `test` to `live` would not migrate anything - it would silently
 * invalidate every key under the project and start routing production traffic
 * at endpoints that were configured as throwaways. There is no safe version of
 * that operation, so it is not offered; create a second project instead.
 *
 * **Deletion is soft.** `status = 'deleted'`, never `DELETE`. The delivery
 * ledger under a project is the record of what we promised a customer we would
 * send, and `deliveries.endpoint_id` is `ON DELETE RESTRICT` precisely so it
 * cannot be erased by a cascade from up here (HANDOFF: "Delivery ledger is no
 * longer cascade-deletable"). `TenantResolver` treats a deleted project as
 * absent, so it disappears from this API immediately; the data plane refuses
 * its API keys because `ProjectStatus != active` (`internal/ingest/handler.go`).
 *
 * Every query goes through `TenantScopeFactory`, so no method here names an
 * organization id and none of them can be pointed at another tenant's row.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly templates: ProjectTemplateService,
  ) {}

  /**
   * One page, plus `has_more`.
   *
   * `findMany` is no longer honest for a list endpoint: it returns a bare array,
   * and now throws outright when the result overflows the default page and no
   * `take` was given. `findPage` returns the page AND whether the bound was
   * reached, which is the only way a caller can tell a full page from a complete
   * result - see `ProjectListDto`.
   */
  async list(context: RequestContext, query: ListProjectsQueryDto): Promise<ProjectListDto> {
    // Soft-deleted projects are excluded unless asked for by name. They are
    // still listable on purpose: a deleted project keeps its slug, so this is
    // the only way a customer can find out why a create just 409'd.
    const where: Prisma.ProjectWhereInput = query.status
      ? { status: query.status }
      : { status: { not: ProjectStatus.deleted } };

    const scope = this.scopes.for(context);
    const page = await scope.projects.findPage({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });

    // ONE grouped query for the whole page, never one per project. See
    // `activeEndpointCounts`.
    const active = await ProjectsService.activeEndpointCounts(
      scope,
      page.rows.map((project) => project.id),
    );

    return {
      // A project absent from the rollup has no deliverable endpoints, which is
      // a real zero: `groupBy` returns no group for a project with no matching
      // rows, so the map is sparse by construction and not by failure.
      data: page.rows.map((project) => toProjectDto(project, active.get(project.id) ?? 0)),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async get(context: RequestContext, projectId: string): Promise<ProjectDto> {
    const scope = this.scopes.for(context);
    // requireById, not findUnique-then-check: the tenant predicate is in the
    // WHERE clause, so another organization's id matches zero rows and answers
    // the same 404 as an id that never existed.
    const project = await withCrossTenantNotFound(scope.projects.requireById(projectId));
    // AFTER the project is proved to be in this tenant, so a cross-tenant id
    // costs a 404 and not a count.
    return toProjectDto(project, await ProjectsService.activeEndpointCount(scope, project.id));
  }

  async create(context: RequestContext, dto: CreateProjectDto): Promise<CreatedProjectDto> {
    const name = dto.name.trim();
    const slug = dto.slug ?? slugFromName(name);
    if (!slug) {
      throw new AppError(
        'invalid_request',
        'Could not derive a slug from that name. Supply "slug" explicitly (lowercase letters, digits and hyphens).',
      );
    }
    const environment = dto.environment ?? Environment.test;
    await this.assertBelowCeiling(context);
    const id = newId('project');

    let project: Project;
    try {
      project = await this.scopes.for(context).projects.create({ id, name, slug, environment });
    } catch (err) {
      throw this.translateSlugCollision(err, slug);
    }

    /*
     * The copy runs AFTER the project exists and is NOT rolled back with it.
     *
     * A project that exists with nothing in it is a recoverable state — copy
     * again, or start from empty. A create that rolled back because one
     * subscription pointed at a deleted endpoint would lose the project and
     * explain nothing. So a copy failure is recorded and reported; the project
     * survives, and `copied` says what actually landed.
     */
    let copied: TemplateResult | null = null;
    let copyError: string | null = null;
    if (dto.copy_from_project_id) {
      try {
        copied = await this.templates.copy(context, dto.copy_from_project_id, project.id);
      } catch (err) {
        copyError = err instanceof Error ? err.message : 'The copy failed.';
        this.logger.error(`Copying into ${project.id} failed: ${copyError}`);
      }
    }

    await this.audit.recordFor(context, {
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      metadata: {
        name,
        slug,
        environment,
        ...(dto.copy_from_project_id
          ? { copied_from: dto.copy_from_project_id, copied: copied ?? 'failed' }
          : {}),
      },
    });

    /*
     * Counted rather than assumed to be 0.
     *
     * A project created from empty has no endpoints, and a copy deliberately
     * lands every endpoint PAUSED and secretless, so this is 0 in both cases
     * today - which is exactly why hardcoding it would be a fact that stops
     * being true the first time the copy rules change, in a response nobody
     * would think to re-read.
     */
    const active = await ProjectsService.activeEndpointCount(
      this.scopes.for(context),
      project.id,
    );
    return { ...toProjectDto(project, active), copied, copy_error: copyError };
  }

  async update(
    context: RequestContext,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectDto> {
    ProjectsService.assertEnvironmentNotSupplied(dto);
    ProjectsService.assertStatusNotSupplied(dto);

    // Built field by field rather than spread, so a property that is not one
    // of the three writable ones cannot reach the database even if it survives
    // validation.
    const data: ProjectUpdate = {};
    const changed: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      changed.name = data.name;
    }
    if (dto.slug !== undefined) {
      data.slug = dto.slug;
      changed.slug = dto.slug;
    }
    if (dto.allowed_ips !== undefined) {
      // REPLACES the list. A merge would make removing an address impossible
      // through this route, and an allowlist you cannot shrink is not a
      // security control.
      data.allowedIps = normaliseAllowedIps(dto.allowed_ips);
      /*
       * The audit entry records the COUNT and whether the list went from empty
       * to non-empty, not the addresses.
       *
       * The transition is the event worth being able to find later: an empty
       * list accepts everything, so adding the first entry is the moment every
       * other address in the world started being refused — including, quite
       * often, the customer's own second service. The addresses themselves are
       * on the project and do not need a second copy in a table with a longer
       * retention.
       */
      changed.allowed_ips_count = data.allowedIps.length;
      changed.allowed_ips_now_enforcing = data.allowedIps.length > 0;
    }
    if (Object.keys(data).length === 0) {
      throw new AppError(
        'invalid_request',
        'Supply at least one of "name", "slug" or "allowed_ips".',
      );
    }

    let project: Project;
    try {
      project = await withCrossTenantNotFound(
        this.scopes.for(context).projects.updateById(projectId, data),
      );
    } catch (err) {
      throw this.translateSlugCollision(err, dto.slug);
    }

    await this.audit.recordFor(context, {
      action: 'project.updated',
      resourceType: 'project',
      resourceId: project.id,
      metadata: changed,
    });
    return toProjectDto(
      project,
      await ProjectsService.activeEndpointCount(this.scopes.for(context), project.id),
    );
  }

  /**
   * Soft delete. The row, its endpoints, its API keys and its entire delivery
   * history stay exactly where they are; only the status changes.
   *
   * The project's API keys are deliberately NOT revoked here. The ingest path
   * already refuses every key whose project is not `active`, so revoking would
   * add a second, weaker copy of the same rule - and it would be the copy that
   * has to be undone by hand if the deletion turns out to be a mistake.
   */
  async remove(context: RequestContext, projectId: string): Promise<ProjectDto> {
    const project = await withCrossTenantNotFound(
      this.scopes.for(context).projects.updateById(projectId, { status: ProjectStatus.deleted }),
    );

    await this.audit.recordFor(context, {
      action: 'project.deleted',
      resourceType: 'project',
      resourceId: project.id,
      metadata: { slug: project.slug, soft_delete: true },
    });
    /*
     * Deliberately still the real count, on a project that is now deleted.
     *
     * Deleting a project does not touch its endpoints - that is what makes an
     * accidental delete recoverable - so the honest answer is "these N endpoints
     * are still configured to deliver, and the project they are in no longer
     * accepts events". Zeroing it here would report a state no row is in, and
     * the client already has `status` in the same body to read it with.
     */
    return toProjectDto(
      project,
      await ProjectsService.activeEndpointCount(this.scopes.for(context), project.id),
    );
  }

  /**
   * How many endpoints in each of these projects would actually be delivered to,
   * in ONE query for the whole page.
   *
   * ## Why this is not an N+1
   *
   * The Usage screen already spends two throttled analytics requests per
   * project. A third per-project round trip - or a `count` per row inside the
   * list handler, which is the same thing wearing a repository - is what makes a
   * 50-project page 50 extra statements. `groupBy(['projectId'])` over
   * `projectId IN (<the page>)` is one statement whose cost does not grow with
   * the page, on the index `endpoints` already has (`endpoints_project_id_idx`).
   *
   * ## Why it counts in the database
   *
   * `MAX_ENDPOINTS_PER_PROJECT` is 500 and `MAX_PAGE_SIZE` is 200, so counting
   * by fetching rows would be both a truncated answer and up to 100,000 rows
   * pulled out of PostgreSQL to produce a handful of integers.
   *
   * ## Why one grouped query is enough
   *
   * `by: ['projectId']` produces AT MOST one group per project id, and the ids
   * come from a page that `ScopedRepository.findPage` has already clamped to
   * `MAX_PAGE_SIZE` - so the rollup can never be the silently-sliced kind
   * `ScopedRepository.groupBy` warns about. That clamp is the whole argument, so
   * it is asserted rather than assumed: a future caller handing this more ids
   * than a page can hold gets a loud error instead of a quietly missing count.
   *
   * The predicate is `scope.endpoints`' own, so an id belonging to another
   * tenant contributes nothing even if it is passed in - and passing one is not
   * reachable, because the ids come from a tenant-scoped page of projects.
   */
  private static async activeEndpointCounts(
    scope: TenantScope,
    projectIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    // No ids, no statement: an `IN ()` over an empty page is a round trip that
    // can only answer nothing.
    if (projectIds.length === 0) return counts;
    if (projectIds.length > MAX_PAGE_SIZE) {
      throw new AppError(
        'internal_error',
        `activeEndpointCounts was given ${projectIds.length} project ids, more than the ${MAX_PAGE_SIZE}-group ceiling one grouped query can return, so some projects would silently report 0 active endpoints. Page the callers' projects first.`,
      );
    }

    const groups = await scope.endpoints.groupBy({
      by: ['projectId'],
      where: {
        ...DELIVERABLE_ENDPOINT_WHERE,
        projectId: { in: [...projectIds] },
      } satisfies Prisma.EndpointWhereInput,
      _count: { _all: true },
      take: MAX_PAGE_SIZE,
    });

    for (const group of groups) {
      const projectId = group.projectId;
      if (typeof projectId !== 'string') continue;
      counts.set(projectId, (group._count as { _all?: number } | undefined)?._all ?? 0);
    }
    return counts;
  }

  /**
   * The same count for one project, for the routes that return a single one.
   *
   * A `count`, not a `groupBy` of one: it is the same predicate and the same
   * index, and `count` says what it does. The caller must have proved the
   * project is in this tenant first - the scope's predicate would refuse a
   * foreign id anyway, but a count of zero and a 404 are different answers and
   * the 404 is the one a cross-tenant id deserves.
   */
  private static async activeEndpointCount(scope: TenantScope, projectId: string): Promise<number> {
    return scope.endpoints.count({ ...DELIVERABLE_ENDPOINT_WHERE, projectId });
  }

  /**
   * The per-organization ceiling.
   *
   * DELETED PROJECTS DO NOT COUNT. A soft-deleted project keeps its slug and its
   * whole delivery ledger forever (that is the point of the soft delete), so
   * counting them would make the ceiling a ratchet: a tenant that had created
   * and deleted a hundred projects could never create another one and there
   * would be no operation available to them that freed a slot. `DELETE` is that
   * operation.
   *
   * This is a ceiling, not an invariant. Two concurrent creates can both read
   * `existing = ceiling - 1` and both insert, so the true bound is
   * `ceiling + concurrent writers`. Holding it exactly would need a serializable
   * transaction or a counter row on `organizations`, and paying for either on
   * every create to stop a tenant reaching 101 instead of 100 is the wrong
   * trade - the limit exists to stop runaway automation, and runaway automation
   * is stopped at 100-ish just as well as at 100. HANDOFF.md records the exact
   * form a hard limit would take if one is ever needed.
   */
  private async assertBelowCeiling(context: RequestContext): Promise<void> {
    const ceiling = maxProjectsPerOrganization(this.config);
    const existing = await this.scopes
      .for(context)
      .projects.count({ status: { not: ProjectStatus.deleted } });
    if (existing < ceiling) return;

    // `limit_exceeded`, not `conflict`: a duplicate slug on this same route is a
    // genuine `conflict`, and until this code existed the two were one 409 that
    // a client could only tell apart by matching on the message text.
    throw new AppError(
      'limit_exceeded',
      `This organization already has ${existing} projects, which is its limit of ${ceiling}. Delete a project you no longer need, or ask an operator to raise ${PROJECTS_PER_ORGANIZATION.env}.`,
      { limit: ceiling, current: existing, resource: 'projects' },
    );
  }

  /**
   * Turn a P2002 into the truth, or rethrow.
   *
   * `projects` has exactly one unique index the caller can collide with -
   * `(organization_id, slug)` - and it is entirely within their own
   * organization, so naming the slug back to them discloses nothing across a
   * tenant boundary. Anything else is rethrown: the auth module's version of
   * this function matched on the error CODE and reported every unique violation
   * as "email already exists", which sent people looking in the wrong place for
   * a slug race.
   */
  private translateSlugCollision(err: unknown, slug?: string): unknown {
    if (isUniqueViolationOn(err, 'slug')) {
      return new AppError(
        'conflict',
        slug
          ? `A project with the slug "${slug}" already exists in this organization. Deleted projects keep their slug; list with ?status=deleted to check.`
          : 'A project with that slug already exists in this organization.',
        { field: 'slug', value: slug },
      );
    }
    const target = uniqueViolationTarget(err);
    if (target !== null) {
      // A unique index we do not model. Do not launder it into a 409 the caller
      // cannot act on; let it 500 with a stack trace and a log line naming it.
      this.logger.error(`Unhandled unique violation on projects; meta.target="${target}"`);
    }
    return err;
  }

  /**
   * The immutability rule, enforced in code and not only in the DTO.
   *
   * The global ValidationPipe (`forbidNonWhitelisted`) already refuses an
   * `environment` key, but that is configuration in main.ts and this is the
   * business rule; a caller that reaches the service another way still gets a
   * message that explains itself instead of a silently ignored field.
   */
  private static assertEnvironmentNotSupplied(dto: UpdateProjectDto): void {
    if (!Object.prototype.hasOwnProperty.call(dto, 'environment')) return;
    throw new AppError(
      'invalid_request',
      "A project's environment is fixed at creation. Changing it would re-scope every API key and endpoint under the project without migrating anything. Create a new project instead.",
      { field: 'environment' },
    );
  }

  private static assertStatusNotSupplied(dto: UpdateProjectDto): void {
    if (!Object.prototype.hasOwnProperty.call(dto, 'status')) return;
    throw new AppError(
      'invalid_request',
      'Project status is not editable here. Use DELETE to soft-delete a project.',
      { field: 'status' },
    );
  }
}
