import { Module } from '@nestjs/common';
import { EndpointSecretsController } from './endpoint-secrets.controller';
import { EndpointSecretsService } from './endpoint-secrets.service';

/**
 * `AuthzModule` (TenantScopeFactory, AuditService) and `CommonModule`
 * (CryptoService) are both `@Global`, so there is nothing to import.
 * `PrismaModule` is deliberately absent: this module has no business holding the
 * unscoped client, and `.eslintrc.json` enforces that.
 *
 * The service is exported because `EndpointsService` mints the version 1 secret
 * as part of creating an endpoint - see the signing invariant in
 * `endpoint-secrets.service.ts`.
 */
@Module({
  controllers: [EndpointSecretsController],
  providers: [EndpointSecretsService],
  exports: [EndpointSecretsService],
})
export class EndpointSecretsModule {}
