import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EndpointSecretsController } from './endpoint-secrets.controller';
import { EndpointSecretsService } from './endpoint-secrets.service';

/**
 * `AuthzModule` (TenantScopeFactory, AuditService) and `CommonModule`
 * (CryptoService, ThrottleGuard) are both `@Global`, so there is nothing to
 * import for those. `PrismaModule` is deliberately absent: this module has no
 * business holding the unscoped client, and `.eslintrc.json` enforces that.
 *
 * `OrganizationsModule` is imported for one export: `TenantTransactionRunner`,
 * which is how `rotate` and `revoke` get a transaction and a row lock without
 * injecting `PrismaService`. It is a temporary address - the runner belongs on
 * `TenantScopeFactory` in `src/authz` (see HANDOFF.md), and this import should
 * become `AuthzModule` when it moves.
 *
 * The service is exported because `EndpointsService` mints the version 1 secret
 * as part of creating an endpoint - see the signing invariant in
 * `endpoint-secrets.service.ts`.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [EndpointSecretsController],
  providers: [EndpointSecretsService],
  exports: [EndpointSecretsService],
})
export class EndpointSecretsModule {}
