import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveryReplayService } from './delivery-replay.service';

/**
 * Imports `OrganizationsModule` for `TenantTransactionRunner` - replay is a
 * multi-row write plus an audit row and must be one SERIALIZABLE transaction.
 * (The runner belongs on `TenantScopeFactory` in `src/authz`; see the PLACEMENT
 * note in `organizations/tenant-transaction.ts`.)
 *
 * Exports both services: `EventsModule` reuses `DeliveriesService.listForEvent`
 * for "did finance ever receive this?" and `DeliveryReplayService` for
 * event-level replay, so there is exactly ONE implementation of the invariant
 * that a replay never touches history.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, DeliveryReplayService],
  exports: [DeliveriesService, DeliveryReplayService],
})
export class DeliveriesModule {}
