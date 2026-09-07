import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

/**
 * Read-only access to `audit_logs`.
 *
 * Imports nothing. `TenantScopeFactory` comes from the global `AuthzModule`,
 * and this module deliberately does NOT depend on `AuditService` - the writer -
 * because nothing here writes. A future author who needs the writer in this
 * module is about to add a route that must not exist; see the docblock on
 * `AuditLogsController`.
 */
@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditModule {}
