import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment, Prisma, Project, ProjectStatus } from '@prisma/client';
import { AuditService, RequestContext, ScopedUpdateInput, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { normaliseAllowedIps } from './allowed-ips';
import { newId } from '../common/ids';
import {
  CreateProjectDto,
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

    const page = await this.scopes.for(context).projects.findPage({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toProjectDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async get(context: RequestContext, projectId: string): Promise<ProjectDto> {
    // requireById, not findUnique-then-check: the tenant predicate is in the
    // WHERE clause, so another organization's id matches zero rows and answers
    // the same 404 as an id that never existed.
    return toProjectDto(
      await withCrossTenantNotFound(this.scopes.for(context).projects.requireById(projectId)),
    );
  }

  async create(context: RequestContext, dto: CreateProjectDto): Promise<ProjectDto> {
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

    await this.audit.recordFor(context, {
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      metadata: { name, slug, environment },
    });
    return toProjectDto(project);
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
    return toProjectDto(project);
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
    return toProjectDto(project);
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
