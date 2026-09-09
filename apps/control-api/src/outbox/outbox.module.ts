import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OutboxController } from './outbox.controller';
import { OutboxService } from './outbox.service';

/**
 * Imports `OrganizationsModule` for `TenantTransactionRunner`: a requeue is a
 * read-then-write over the row's status plus a second write to the event plus an
 * audit row, and all four have to be one SERIALIZABLE transaction. Without it,
 * two operators requeueing the same parked row during an incident both read
 * `failed` and both file an audit entry claiming they did it.
 * (The runner belongs on `TenantScopeFactory` in `src/authz`; see the PLACEMENT
 * note in `organizations/tenant-transaction.ts`.)
 *
 * A separate module rather than routes bolted onto `EventsModule`, because the
 * outbox is a different resource with a different lifecycle: `events` is the
 * durable record of what was published, `event_outbox` is the router's work
 * queue for it. They are related the way a delivery is related to an event, and
 * `DeliveriesModule` is separate for the same reason.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [OutboxController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
