import { Global, INestApplication, Module, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { AuditService } from './audit.service';
import { PERMISSIONS_METADATA, TENANT_SPEC_METADATA } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { TenantScopeFactory } from './tenant-scope.factory';
import { TenantGuard } from './tenant.guard';

/**
 * Global, so `@Authorized()` works in any module without an import ceremony
 * that a new controller could forget - the safe path has to be the default one.
 *
 * `AuthModule` is re-exported because `@Authorized()` mounts `SessionGuard`
 * alongside `TenantGuard`, and Nest resolves both from the controller's module
 * context. `PrismaModule` is imported explicitly: it is no longer `@Global`,
 * because a data-layer dependency that appears in no import list is the
 * opposite of conspicuous.
 */
@Global()
@Module({
  imports: [AuthModule, PrismaModule, DiscoveryModule],
  providers: [TenantResolver, TenantGuard, TenantScopeFactory, AuditService],
  exports: [AuthModule, TenantResolver, TenantGuard, TenantScopeFactory, AuditService],
})
export class AuthzModule {}

/** One offending handler, in a form a human can go and fix. */
export interface UnguardedRoute {
  controller: string;
  handler: string;
  reason: string;
}

/**
 * BOOT ASSERTION: no route may declare authorization metadata without the guard
 * that enforces it.
 *
 * `@RequirePermission(...)` and `@ResolveTenantFrom(...)` are bare
 * `SetMetadata`. They enforce nothing on their own - they are what the guard
 * reads - but they are exported next to `@Authorized` and read as enforcement
 * verbs. A controller carrying `@RequirePermission('api-keys.read')` and no
 * `@Authorized()`/`@UseGuards(TenantGuard)` serves the route unauthenticated to
 * anyone, and nothing at build, boot or test time noticed: the metadata is
 * present, correct, and never read.
 *
 * So it is checked once, at startup, over every registered controller. It fails
 * the deploy rather than one request, which is the only place a mistake like
 * this is cheap.
 *
 * Known limit: a `TenantGuard` registered globally via `APP_GUARD` is not
 * visible in per-route `__guards__` metadata, so it would be reported here.
 * That is deliberate - this layer mounts guards per route on purpose, and a
 * global tenant guard would try to resolve a tenant for `/health` and `/auth`.
 */
export function findUnguardedRoutes(app: INestApplication): UnguardedRoute[] {
  const discovery = app.get(DiscoveryService, { strict: false });
  const scanner = new MetadataScanner();
  const offenders: UnguardedRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerType = wrapper.metatype as Type<unknown> | undefined;
    if (!instance || !controllerType) continue;

    const prototype = Object.getPrototypeOf(instance) as object;
    const guardedClass = hasTenantGuard(controllerType);

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (instance as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;

      const declaresPermissions =
        Reflect.getMetadata(PERMISSIONS_METADATA, handler) !== undefined ||
        Reflect.getMetadata(PERMISSIONS_METADATA, controllerType) !== undefined;
      const declaresTenantSpec =
        Reflect.getMetadata(TENANT_SPEC_METADATA, handler) !== undefined ||
        Reflect.getMetadata(TENANT_SPEC_METADATA, controllerType) !== undefined;
      if (!declaresPermissions && !declaresTenantSpec) continue;

      if (guardedClass || hasTenantGuard(handler)) continue;
      offenders.push({
        controller: controllerType.name,
        handler: methodName,
        reason: declaresPermissions
          ? '@RequirePermission is declared but TenantGuard is not mounted'
          : '@ResolveTenantFrom is declared but TenantGuard is not mounted',
      });
    }
  }
  return offenders;
}

function hasTenantGuard(target: object): boolean {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  if (!Array.isArray(guards)) return false;
  return guards.some((guard) => guard === TenantGuard || guard instanceof TenantGuard);
}

/** Call from `bootstrap()` before `listen()`. Throws, loudly, with the list. */
export function assertRoutesAreGuarded(app: INestApplication): void {
  const offenders = findUnguardedRoutes(app);
  if (offenders.length === 0) return;
  const detail = offenders
    .map((offender) => `  - ${offender.controller}.${offender.handler}: ${offender.reason}`)
    .join('\n');
  throw new Error(
    `Authorization metadata without an enforcing guard on ${offenders.length} route(s). ` +
      `These routes serve unauthenticated. Replace the bare decorator with @Authorized(...):\n${detail}`,
  );
}
