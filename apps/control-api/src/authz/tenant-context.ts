import { Environment, MemberRole, OrganizationStatus, ProjectStatus } from '@prisma/client';
import { AuthenticatedRequest } from '../auth/session.guard';
import { SessionUser } from '../auth/session.service';
import { Permission } from './permissions';

export interface ResolvedOrganization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
}

export interface ResolvedProject {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  environment: Environment;
  status: ProjectStatus;
}

/**
 * The authenticated principal PLUS the tenant it is acting inside.
 *
 * `SessionUser` answers "who is this?". It cannot answer "which organization's
 * data may this request touch?", and a controller that has to work that out for
 * itself is a controller that will one day forget. Everything a handler or a
 * service needs to scope a query is on this object, and it is only ever built by
 * `TenantResolver` - never from client input.
 */
export interface RequestContext {
  readonly user: SessionUser;
  readonly organization: ResolvedOrganization;
  /** `organization_members.id` for this user in this organization. */
  readonly membershipId: string;
  readonly role: MemberRole;
  /**
   * What this role may do here, already narrowed for a suspended tenant. Use
   * `has()` rather than re-deriving from `role`.
   */
  readonly permissions: ReadonlySet<Permission>;
  /** Null on organization-level routes that name no project. */
  readonly project: ResolvedProject | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  has(permission: Permission): boolean;
  /** The resolved project, or a loud programming error. Never returns null. */
  requireProject(): ResolvedProject;
}

/**
 * Reflector metadata keys. They live here, next to the types they carry, so
 * `tenant.guard.ts` and `authz.decorators.ts` can both reach them without
 * importing each other.
 */
export const PERMISSIONS_METADATA = 'authz:permissions';
export const TENANT_SPEC_METADATA = 'authz:tenant-spec';

/** Where the guard should look to work out which tenant this request is about. */
export type TenantAnchorKind =
  | 'organization'
  | 'project'
  | 'endpoint'
  | 'subscription'
  | 'apiKey'
  | 'event'
  | 'delivery';

/**
 * Resolution strategy for a route.
 *
 * `params` (the default) reads `:orgId` / `:organizationId` and `:projectId`
 * straight off the route. `anchor` is for resource-addressed routes such as
 * `/v1/deliveries/:deliveryId`, where the tenant is a property of the resource
 * rather than of the path: the resolver walks delivery -> endpoint -> project ->
 * organization and checks membership at the end of that chain.
 */
export type TenantSpec =
  | { readonly from: 'params' }
  | { readonly from: 'anchor'; readonly kind: TenantAnchorKind; readonly param: string };

export const DEFAULT_TENANT_SPEC: TenantSpec = { from: 'params' };

/**
 * Route parameter names the resolver recognises.
 *
 * Deliberately NOT `:id`. A bare `:id` is ambiguous - on
 * `/v1/organizations/:id` it is an organization, on `/v1/endpoints/:id` it is
 * an endpoint - and a resolver that guessed would eventually guess wrong in the
 * direction that grants access. Name the parameter for what it holds, or
 * declare an anchor explicitly.
 */
export const ORGANIZATION_PARAMS: readonly string[] = ['orgId', 'organizationId'];
export const PROJECT_PARAMS: readonly string[] = ['projectId'];

export interface TenantRequest extends AuthenticatedRequest {
  /** Set by TenantGuard. Read it through the `@Tenant()` param decorator. */
  tenantContext?: RequestContext;
}
