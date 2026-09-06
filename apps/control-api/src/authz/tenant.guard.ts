import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/errors';
import { Permission } from './permissions';
import {
  DEFAULT_TENANT_SPEC,
  PERMISSIONS_METADATA,
  RequestContext,
  TENANT_SPEC_METADATA,
  TenantRequest,
  TenantSpec,
} from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';

/**
 * Tenant resolution and permission enforcement, in one place
 * (ARCHITECTURE.md 10: "Do not scatter authorization logic throughout
 * controllers").
 *
 * Mounted AFTER `SessionGuard`, never instead of it - authentication ("is this
 * a live session for an enabled account?") and authorization ("may that account
 * touch this tenant?") stay separable, and `SessionGuard` is still the only
 * thing that reads the cookie. `@Authorized()` mounts the pair in the right
 * order so a caller cannot get it wrong.
 *
 * It fails closed in every direction:
 *
 * - no `req.sessionUser` (someone mounted this guard alone) -> 401;
 * - a route with no `:orgId`/`:projectId` and no `@ResolveTenantFrom` -> 500,
 *   loudly, in the developer's face, rather than a request authorised against
 *   no tenant at all;
 * - no membership, or a project owned by another organization -> 404;
 * - membership but the wrong role -> 403.
 *
 * The last two are the deliberate policy - see the CROSS_TENANT docblock in
 * `tenant-resolver.service.ts`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();

    const user = request.sessionUser;
    if (!user) {
      // Reachable only if a controller mounted TenantGuard without SessionGuard.
      throw new AppError('unauthenticated', 'Authentication required.');
    }

    const spec =
      this.reflector.getAllAndOverride<TenantSpec | undefined>(TENANT_SPEC_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_TENANT_SPEC;

    // Handler metadata OVERRIDES class metadata; it does not merge. A
    // controller-wide `@RequirePermission('endpoints.read')` with a
    // `@RequirePermission('endpoints.write')` on one method means that method
    // needs write and nothing else. `@RequirePermission()` with no arguments on
    // a handler therefore clears a class-level requirement - that is the
    // "member of this tenant, any role" escape hatch, and it is deliberately
    // something you have to type.
    const required =
      this.reflector.getAllAndOverride<readonly Permission[] | undefined>(PERMISSIONS_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const tenantContext = await this.resolver.resolve(user, request, spec);
    request.tenantContext = tenantContext;

    // AND, not OR. Every listed permission must be held.
    const missing = required.filter((permission) => !tenantContext.permissions.has(permission));
    if (missing.length > 0) {
      throw TenantGuard.forbidden(tenantContext, missing);
    }

    return true;
  }

  /**
   * 403, not 404: membership in this organization is already proven, so the
   * caller knows it exists and telling them which permission they lack costs
   * nothing and saves a support ticket. The role is echoed because the usual
   * cause is "I am a viewer and expected to be an admin".
   */
  private static forbidden(context: RequestContext, missing: readonly Permission[]): AppError {
    const suspended =
      context.organization.status === 'suspended' || context.project?.status === 'suspended';
    const message = suspended
      ? 'This tenant is suspended; only read access and billing changes are permitted.'
      : `Your role (${context.role}) does not grant ${missing.join(', ')}.`;
    return new AppError('forbidden', message, {
      required_permissions: [...missing],
      role: context.role,
    });
  }
}
