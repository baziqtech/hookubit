import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RetryPoliciesController } from './retry-policies.controller';
import { RetryPoliciesService } from './retry-policies.service';

/**
 * `AuthzModule` (TenantScopeFactory, AuditService) and `CommonModule`
 * (ThrottleGuard) are both `@Global`, so there is nothing to import for those.
 * `PrismaModule` is deliberately absent: this module has no business holding
 * the unscoped client, and `.eslintrc.json` enforces that.
 *
 * `OrganizationsModule` is imported for one export: `TenantTransactionRunner`,
 * which is how the default-policy invariant gets a SERIALIZABLE transaction
 * without injecting `PrismaService`. It is a temporary address — the runner
 * belongs on `TenantScopeFactory` in `src/authz` (see HANDOFF.md), and this
 * import should become `AuthzModule` when it moves.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [RetryPoliciesController],
  providers: [RetryPoliciesService],
  exports: [RetryPoliciesService],
})
export class RetryPoliciesModule {}
