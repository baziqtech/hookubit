import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
// PrismaModule is deliberately NOT `@Global()` - a module that wants the raw,
// unscoped client has to say so here, which is where the review question "why
// is this talking to Prisma instead of TenantScopeFactory?" gets asked. The
// answer for this one is in EndpointAutoDisableService's docblock: the sweep has
// no request, no user and no tenant, so there is no RequestContext to build a
// TenantScope from.
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { AutoDisableScheduler } from './auto-disable.scheduler';
import { EndpointAutoDisableService } from './endpoint-auto-disable.service';

/**
 * Periodic reconciliation the control plane owns.
 *
 * NO CONTROLLERS, on purpose. Everything here acts on its own timer, and the
 * customer-facing half of each job is a route that already exists: the endpoint
 * auto-disable is undone by `POST /v1/projects/:projectId/endpoints/:endpointId/enable`
 * and explained by `GET /v1/organizations/:orgId/audit-logs`. Adding a
 * "re-enable an auto-disabled endpoint" route would be a second way to do the
 * same thing with its own permissions to keep in step.
 *
 * The retention sweep that prunes the delivery ledger is deliberately NOT here:
 * it is bulk SQL over the two largest tables in the system with no tenancy and
 * no audit trail, which belongs to the data plane's scheduler role
 * (services/data-plane/internal/retention). The split is the same one the whole
 * system uses - configuration and the customer-visible record here, rows there.
 */
@Module({
  imports: [AuthzModule, PrismaModule],
  providers: [EndpointAutoDisableService, AutoDisableScheduler],
  exports: [EndpointAutoDisableService],
})
export class MaintenanceModule {}
