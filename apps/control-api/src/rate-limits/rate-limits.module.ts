import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RateLimitsController } from './rate-limits.controller';
import { RateLimitsService } from './rate-limits.service';

/**
 * `AuthzModule` (TenantScopeFactory, AuditService) and `CommonModule`
 * (ThrottleGuard) are both `@Global`, so there is nothing to import for those.
 * `PrismaModule` is deliberately absent: this module has no business holding
 * the unscoped client, and `.eslintrc.json` enforces that.
 *
 * `OrganizationsModule` is imported for `TenantTransactionRunner` — the
 * check-then-insert against the NULLS NOT DISTINCT unique index has to be
 * atomic. It is a temporary address; the runner belongs on `TenantScopeFactory`
 * in `src/authz` (see HANDOFF.md).
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [RateLimitsController],
  providers: [RateLimitsService],
  exports: [RateLimitsService],
})
export class RateLimitsModule {}
