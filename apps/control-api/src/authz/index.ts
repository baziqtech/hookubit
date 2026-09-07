export {
  AuthzModule,
  assertRoutesAreGuarded,
  findUnguardedRoutes,
  type UnguardedRoute,
} from './authz.module';
export {
  Authorized,
  RequirePermission,
  ResolveTenantFrom,
  Tenant,
} from './authz.decorators';
export { TenantGuard } from './tenant.guard';
export { CROSS_TENANT_MESSAGE, TenantResolver } from './tenant-resolver.service';
export { TenantScope, TenantScopeFactory, type TenantClient } from './tenant-scope.factory';
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ScopedRepository,
  tenantPredicate,
  type AggregateArgs,
  type GroupByArgs,
  type ModelDelegate,
  type OwnedRepository,
  type Page,
  type OwnershipVerifier,
  type ScopedCreateInput,
  type ScopedUpdateInput,
  type TenantPredicate,
  type TenantScopeKind,
} from './tenant-scope';
export {
  AuditService,
  type AuditAction,
  type AuditActor,
  type AuditEntry,
} from './audit.service';
export {
  MEMBER_ROLES,
  PERMISSIONS,
  READ_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  TENANT_SCOPE_PERMISSIONS,
  assertMemberRemovalAllowed,
  assertRoleChangeAllowed,
  isPermission,
  isReadPermission,
  permissionsForRole,
  permissionsUnderSuspension,
  mayAssignRole,
  roleHasPermission,
  type Permission,
  type RoleChange,
} from './permissions';
export {
  DEFAULT_TENANT_SPEC,
  ORGANIZATION_PARAMS,
  PERMISSIONS_METADATA,
  PROJECT_PARAMS,
  TENANT_SPEC_METADATA,
  type RequestContext,
  type ResolvedOrganization,
  type ResolvedProject,
  type TenantAnchorKind,
  type TenantRequest,
  type TenantSpec,
} from './tenant-context';
