import { Module } from '@nestjs/common';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Depends on `DeliveriesModule` in one direction only, and for two things:
 * `DeliveriesService.listForEvent` (the routing listing) and
 * `DeliveryReplayService` (the replay engine).
 *
 * Deliberately NOT a second replay implementation. The invariant that a replay
 * inserts a new row carrying `replay_of_delivery_id` and never touches history
 * has to hold for both routes, and an invariant with two implementations has
 * one implementation and one liability.
 */
@Module({
  imports: [DeliveriesModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
