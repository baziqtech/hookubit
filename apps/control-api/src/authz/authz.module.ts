import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { TenantResolver } from './tenant-resolver.service';
import { TenantScopeFactory } from './tenant-scope.factory';
import { TenantGuard } from './tenant.guard';

/**
 * Global, so `@Authorized()` works in any module without an import ceremony
 * that a new controller could forget - the safe path has to be the default one.
 *
 * `AuthModule` is re-exported because `@Authorized()` mounts `SessionGuard`
 * alongside `TenantGuard`, and Nest resolves both from the controller's module
 * context.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantResolver, TenantGuard, TenantScopeFactory, AuditService],
  exports: [AuthModule, TenantResolver, TenantGuard, TenantScopeFactory, AuditService],
})
export class AuthzModule {}
