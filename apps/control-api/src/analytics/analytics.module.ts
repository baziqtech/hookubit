import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Read-only, and imports nothing.
 *
 * `AuthzModule` is `@Global`, so `TenantScopeFactory` is already injectable;
 * there is no transaction runner here because this module writes nothing and
 * no audit call because reading an aggregate of rows the caller may already
 * list one by one is not an auditable event.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
