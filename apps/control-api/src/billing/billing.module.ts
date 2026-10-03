import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Metered volume, and nothing else.
 *
 * There is no payment provider, no invoice and no price here, and this module
 * deliberately does not pretend otherwise — `billable: false` travels on the
 * wire so the dashboard renders a sentence rather than an empty invoice table.
 * The numbers it does return are real, which is what makes the distinction
 * worth drawing.
 */
@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
