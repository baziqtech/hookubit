import { Injectable, Logger } from '@nestjs/common';
import { MemberRole } from '@prisma/client';
import { SessionUser } from '../auth/session.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { Permission, permissionsForRole, permissionsUnderSuspension } from './permissions';
import {
  ORGANIZATION_PARAMS,
  PROJECT_PARAMS,
  RequestContext,
  ResolvedOrganization,
  ResolvedProject,
  TenantAnchorKind,
  TenantRequest,
  TenantSpec,
} from './tenant-context';

/**
 * What an anchor lookup produces: the tenant coordinates of some resource,
 * established by walking the ownership chain in the database rather than by
 * believing anything the client said.
 */
interface TenantCoordinates {
  organizationId: string;
  projectId: string | null;
}

/**
 * NOT-FOUND vs FORBIDDEN - the policy for the whole control plane.
 *
 * **404 `not_found`** whenever the caller is outside the tenant that owns the
 * resource. That covers: no membership in the organization, a project that
 * belongs to a different organization than the route's, an endpoint/event/
 * delivery under someone else's project, and a resource that genuinely does not
 * exist. All four are one answer, because a 403 on a resource in another tenant
 * is an existence oracle: `/v1/endpoints/ep_01...` answering 403 rather than 404
 * confirms that id is real and lets an attacker enumerate a competitor's
 * infrastructure without ever being authorised for any of it.
 *
 * **403 `forbidden`** only once membership in the resolved tenant is proven and
 * the caller's ROLE is what falls short - a developer attempting `members.write`
 * inside their own organization. They already know the organization exists; they
 * are in it. Hiding the reason there produces bad UX and discloses nothing.
 *
 * This matches the ingest path, where an API key presented against another
 * project's id answers 404 (`internal/ingest/handler.go`,
 * `TestKeyForAnotherProjectIsNotFound`), so the two planes cannot be played off
 * against each other to distinguish "wrong tenant" from "does not exist".
 *
 * Corollary for Phase 2: never `findUnique({ where: { id } })` and then check
 * ownership - by then you have already decided to answer differently for a real
 * id. Query with the tenant predicate in the WHERE clause, which is what
 * `ScopedRepository` does.
 */
const CROSS_TENANT = 'not_found' as const;

@Injectable()
export class TenantResolver {
  private readonly logger = new Logger(TenantResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the request's tenant context, or refuse the request.
   *
   * The order matters and is the whole security argument:
   *
   * 1. work out which organization (and project) this request is really about,
   *    from the database, never from a client-supplied body field;
   * 2. prove this user is a member of that organization;
   * 3. prove the project - if there is one - belongs to that same organization;
   * 4. only then decide what the role may do.
   *
   * Step 3 is the IDOR that ARCHITECTURE.md 8 names: `/orgs/A/projects/<B's
   * project>` passes a naive membership check on A and then happily serves B's
   * data.
   */
  async resolve(
    user: SessionUser,
    request: TenantRequest,
    spec: TenantSpec,
  ): Promise<RequestContext> {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const claimedOrganizationId = TenantResolver.firstParam(params, ORGANIZATION_PARAMS);
    const claimedProjectId = TenantResolver.firstParam(params, PROJECT_PARAMS);

    const coordinates =
      spec.from === 'anchor'
        ? await this.coordinatesFromAnchor(spec.kind, TenantResolver.requiredParam(params, spec.param))
        : await this.coordinatesFromParams(claimedOrganizationId, claimedProjectId);

    // An anchor route may ALSO carry :orgId/:projectId (a nested URL). Those are
    // claims; the anchor walked the real ownership chain, so any disagreement
    // means the client asked for someone else's resource under a path it does
    // have access to. Same answer as any other cross-tenant miss.
    if (claimedOrganizationId && claimedOrganizationId !== coordinates.organizationId) {
      throw TenantResolver.crossTenant('Resource not found.');
    }
    if (claimedProjectId && claimedProjectId !== coordinates.projectId) {
      throw TenantResolver.crossTenant('Resource not found.');
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: coordinates.organizationId,
          userId: user.userId,
        },
      },
      select: { id: true, role: true },
    });
    // No membership is indistinguishable from "no such organization" on purpose.
    if (!membership) throw TenantResolver.crossTenant('Organization not found.');

    const organization = await this.loadOrganization(coordinates.organizationId);
    const project = coordinates.projectId
      ? await this.loadProject(coordinates.projectId, organization.id)
      : null;

    return TenantResolver.buildContext({
      user,
      organization,
      project,
      membershipId: membership.id,
      role: membership.role,
      request,
    });
  }

  private async coordinatesFromParams(
    organizationId: string | null,
    projectId: string | null,
  ): Promise<TenantCoordinates> {
    if (organizationId) return { organizationId, projectId };
    if (projectId) {
      // A project-only route (`/v1/projects/:projectId/...`). The organization
      // is read off the project row and membership is then checked against it,
      // so the client's project id is a lookup key, never an authorisation
      // claim - an id belonging to another tenant simply fails the membership
      // test that follows.
      return this.coordinatesFromAnchor('project', projectId);
    }
    // Fail loudly rather than silently serving an unscoped route. A guard that
    // shrugged here would authorise the request against no tenant at all.
    throw new AppError(
      'internal_error',
      'This route is guarded by TenantGuard but names no tenant. Add :orgId or :projectId to the path, or declare @ResolveTenantFrom(...).',
    );
  }

  /**
   * Resolve tenant coordinates from a resource id, by walking ownership in the
   * database. Every branch ends at an `organization_id` that came out of a row,
   * never off the wire.
   */
  private async coordinatesFromAnchor(
    kind: TenantAnchorKind,
    id: string,
  ): Promise<TenantCoordinates> {
    switch (kind) {
      case 'organization':
        return { organizationId: id, projectId: null };

      case 'project': {
        const project = await this.prisma.project.findUnique({
          where: { id },
          select: { id: true, organizationId: true },
        });
        if (!project) throw TenantResolver.crossTenant('Project not found.');
        return { organizationId: project.organizationId, projectId: project.id };
      }

      case 'endpoint': {
        const endpoint = await this.prisma.endpoint.findUnique({
          where: { id },
          select: { projectId: true, project: { select: { organizationId: true } } },
        });
        if (!endpoint) throw TenantResolver.crossTenant('Endpoint not found.');
        return {
          organizationId: endpoint.project.organizationId,
          projectId: endpoint.projectId,
        };
      }

      case 'subscription': {
        const subscription = await this.prisma.webhookSubscription.findUnique({
          where: { id },
          select: { projectId: true, project: { select: { organizationId: true } } },
        });
        if (!subscription) throw TenantResolver.crossTenant('Subscription not found.');
        return {
          organizationId: subscription.project.organizationId,
          projectId: subscription.projectId,
        };
      }

      case 'apiKey': {
        const apiKey = await this.prisma.apiKey.findUnique({
          where: { id },
          select: { projectId: true, project: { select: { organizationId: true } } },
        });
        if (!apiKey) throw TenantResolver.crossTenant('API key not found.');
        return { organizationId: apiKey.project.organizationId, projectId: apiKey.projectId };
      }

      case 'event': {
        const event = await this.prisma.event.findUnique({
          where: { id },
          select: {
            organizationId: true,
            projectId: true,
            project: { select: { organizationId: true } },
          },
        });
        if (!event) throw TenantResolver.crossTenant('Event not found.');
        // `events.organization_id` is denormalised. The project chain is
        // authoritative; a disagreement is a data-integrity bug, and the safe
        // reading of a corrupt ownership row is "you cannot have it".
        this.assertDenormalisedAgreement(
          'event',
          id,
          event.organizationId,
          event.project.organizationId,
        );
        return { organizationId: event.project.organizationId, projectId: event.projectId };
      }

      case 'delivery': {
        // delivery -> endpoint -> project -> organization. `deliveries` carries
        // organization_id and project_id for query performance, but they are
        // copies; the chain is what actually owns the row.
        const delivery = await this.prisma.delivery.findUnique({
          where: { id },
          select: {
            organizationId: true,
            projectId: true,
            endpoint: {
              select: { projectId: true, project: { select: { organizationId: true } } },
            },
          },
        });
        if (!delivery) throw TenantResolver.crossTenant('Delivery not found.');
        this.assertDenormalisedAgreement(
          'delivery',
          id,
          delivery.organizationId,
          delivery.endpoint.project.organizationId,
        );
        this.assertDenormalisedAgreement(
          'delivery',
          id,
          delivery.projectId,
          delivery.endpoint.projectId,
        );
        return {
          organizationId: delivery.endpoint.project.organizationId,
          projectId: delivery.endpoint.projectId,
        };
      }
    }
  }

  private assertDenormalisedAgreement(
    resource: string,
    id: string,
    denormalised: string,
    authoritative: string,
  ): void {
    if (denormalised === authoritative) return;
    this.logger.error(
      `Tenant ownership mismatch on ${resource} ${id}: denormalised column says ${denormalised}, ownership chain says ${authoritative}. Refusing the request.`,
    );
    throw TenantResolver.crossTenant('Resource not found.');
  }

  private async loadOrganization(id: string): Promise<ResolvedOrganization> {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, status: true },
    });
    // Membership already matched, so this is either a race with a hard delete or
    // a dangling member row. Either way there is nothing to act on.
    if (!organization) throw TenantResolver.crossTenant('Organization not found.');
    if (organization.status === 'deleted') {
      throw TenantResolver.crossTenant('Organization not found.');
    }
    return organization;
  }

  private async loadProject(id: string, organizationId: string): Promise<ResolvedProject> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        environment: true,
        status: true,
      },
    });
    if (!project) throw TenantResolver.crossTenant('Project not found.');
    // THE cross-tenant check. Without it, `/v1/organizations/A/projects/<B's
    // project>` passes the membership test on A and then serves B's endpoints,
    // events and deliveries.
    if (project.organizationId !== organizationId) {
      throw TenantResolver.crossTenant('Project not found.');
    }
    if (project.status === 'deleted') throw TenantResolver.crossTenant('Project not found.');
    return project;
  }

  private static buildContext(input: {
    user: SessionUser;
    organization: ResolvedOrganization;
    project: ResolvedProject | null;
    membershipId: string;
    role: MemberRole;
    request: TenantRequest;
  }): RequestContext {
    const suspended =
      input.organization.status === 'suspended' || input.project?.status === 'suspended';
    const granted = permissionsForRole(input.role);
    const permissions = suspended ? permissionsUnderSuspension(granted) : granted;

    const context: RequestContext = {
      user: input.user,
      organization: input.organization,
      membershipId: input.membershipId,
      role: input.role,
      permissions,
      project: input.project,
      ipAddress: TenantResolver.clientIp(input.request),
      userAgent: TenantResolver.userAgent(input.request),
      has: (permission: Permission) => permissions.has(permission),
      requireProject: (): ResolvedProject => {
        if (!input.project) {
          throw new AppError(
            'internal_error',
            'This route resolved no project, but the code asked for one. Nest the route under :projectId or use an organization-scoped query.',
          );
        }
        return input.project;
      },
    };
    return context;
  }

  private static firstParam(
    params: Record<string, string | undefined>,
    names: readonly string[],
  ): string | null {
    for (const name of names) {
      const value = params[name];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  }

  private static requiredParam(
    params: Record<string, string | undefined>,
    name: string,
  ): string {
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new AppError(
        'internal_error',
        `@ResolveTenantFrom names route parameter ":${name}", which this route does not declare.`,
      );
    }
    return value;
  }

  /** See the CROSS_TENANT docblock: outside your tenant is indistinguishable from absent. */
  private static crossTenant(message: string): AppError {
    return new AppError(CROSS_TENANT, message);
  }

  private static clientIp(request: TenantRequest): string | null {
    return request.ip ?? request.socket?.remoteAddress ?? null;
  }

  private static userAgent(request: TenantRequest): string | null {
    const value = request.headers?.['user-agent'];
    return typeof value === 'string' ? value.slice(0, 512) : null;
  }
}
