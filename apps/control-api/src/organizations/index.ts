export { OrganizationsModule } from './organizations.module';
export { OrganizationsService } from './organizations.service';
export {
  MAX_TRANSACTION_ATTEMPTS,
  TENANT_TRANSACTION_ISOLATION,
  TenantTransactionRunner,
  isSerializationFailure,
  type TenantAudit,
} from './tenant-transaction';
export { UserDirectory, type UserIdentity } from './user-directory';
export {
  Principal,
  USER_SCOPE_METADATA,
  UserScope,
  UserScopeFactory,
  UserScopeGuard,
  UserScoped,
  contextForNewMembership,
  type CreatedMembership,
  type InvitationState,
  type MembershipSummary,
  type UserPrincipal,
  type UserScopedRequest,
} from './user-scope';
export * from './dto';
