import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { TenantTransactionRunner } from './tenant-transaction';
import { UserDirectory } from './user-directory';
import { UserScopeFactory, UserScopeGuard } from './user-scope';

/**
 * Organizations, plus the three primitives the authorization layer does not
 * provide yet.
 *
 * `UserScopeFactory`, `UserDirectory` and `TenantTransactionRunner` are
 * exported because the members module needs all three and they must not be
 * re-invented there: two implementations of "the caller's own membership
 * graph" is one more than can be reviewed. They belong in `src/authz` — see
 * HANDOFF.md — and this export list is what should disappear when they move.
 *
 * `PrismaModule` is imported explicitly because it is no longer `@Global`, and
 * `AuthModule` because `@UserScoped()` mounts `SessionGuard`. Nest resolves
 * both from this module's context.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    UserScopeGuard,
    UserScopeFactory,
    UserDirectory,
    TenantTransactionRunner,
  ],
  exports: [UserScopeGuard, UserScopeFactory, UserDirectory, TenantTransactionRunner],
})
export class OrganizationsModule {}
