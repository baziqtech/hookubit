import {
  ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { AppError } from '../common/errors';
import { Permission } from './permissions';
import {
  PERMISSIONS_METADATA,
  RequestContext,
  TENANT_SPEC_METADATA,
  TenantAnchorKind,
  TenantRequest,
  TenantSpec,
} from './tenant-context';
import { TenantGuard } from './tenant.guard';

/**
 * Declare what a handler needs. All listed permissions are required (AND).
 *
 * Usable on a class to set a controller-wide default; a handler-level
 * declaration overrides it rather than adding to it.
 */
export const RequirePermission = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_METADATA, permissions);

/**
 * For resource-addressed routes where the tenant is not in the path - e.g.
 * `/v1/deliveries/:deliveryId`. The resolver walks the ownership chain from
 * that id (delivery -> endpoint -> project -> organization) and checks
 * membership at the top of it.
 *
 * Not needed - and not wanted - on routes already nested under `:orgId` or
 * `:projectId`.
 */
export const ResolveTenantFrom = (
  kind: TenantAnchorKind,
  param: string,
): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_SPEC_METADATA, { from: 'anchor', kind, param } satisfies TenantSpec);

/**
 * The one decorator a Phase 2 controller should reach for.
 *
 * Mounts `SessionGuard` then `TenantGuard` - in that order, because tenant
 * resolution needs an authenticated user - and records the permissions the
 * handler needs. Guard order in `@UseGuards` is execution order in Nest, and
 * getting it wrong here is exactly the kind of mistake this layer exists to
 * make impossible to make by accident.
 *
 *     @Get()
 *     @Authorized('endpoints.read')
 *     list(@Tenant() ctx: RequestContext) { ... }
 *
 * With no arguments it still resolves and enforces the tenant; it just does not
 * demand a particular permission beyond membership.
 */
export const Authorized = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(SessionGuard, TenantGuard), RequirePermission(...permissions));

/**
 * The request's tenant context. Fails closed: a handler that forgot
 * `@Authorized()` gets a 401 rather than an undefined it might have ignored.
 */
export const Tenant = createParamDecorator<unknown, ExecutionContext, RequestContext>(
  (_data, context) => {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    if (!request.tenantContext) {
      throw new AppError('unauthenticated', 'Authentication required.');
    }
    return request.tenantContext;
  },
);
