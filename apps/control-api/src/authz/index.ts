export { AuthzModule } from './authz.module';
export {
  Authorized,
  RequirePermission,
  ResolveTenantFrom,
  Tenant,
} from './authz.decorators';
export { TenantGuard } from './tenant.guard';
export { TenantResolver } from './tenant-resolver.service';
export { TenantScope, TenantScopeFactory, type TenantClient } from './tenant-scope.factory';
export {
  ScopedRepository,
  tenantPredicate,
  type ModelDelegate,
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
  isPermission,
  isReadPermission,
  permissionsForRole,
  permissionsUnderSuspension,
  roleHasPermission,
  type Permission,
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
