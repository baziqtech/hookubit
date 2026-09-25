import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhookSubscriptionsController } from './webhook-subscriptions.controller';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';

/**
 * `AuthzModule` (TenantScopeFactory, AuditService) and `CommonModule`
 * (ThrottleGuard) are both `@Global`, so there is nothing to import for those.
 * `ConfigService` comes from the global `ConfigModule` in `app.module.ts`.
 * `PrismaModule` is deliberately absent: this module has no business holding the
 * unscoped client, and `.eslintrc.json` enforces that.
 *
 * `OrganizationsModule` is imported for one export: `TenantTransactionRunner`,
 * which is how `create` counts and inserts inside one SERIALIZABLE transaction
 * without injecting `PrismaService`. Same temporary address as
 * `EndpointSecretsModule` uses it from - the runner belongs on
 * `TenantScopeFactory` in `src/authz` (see HANDOFF.md), and this import becomes
 * `AuthzModule` when it moves.
 *
 * The service is exported because the events/routing module will need to read
 * the subscriptions matching an event, and that read must go through this
 * module rather than through a second opinion about what a filter means.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [WebhookSubscriptionsController],
  providers: [WebhookSubscriptionsService],
  exports: [WebhookSubscriptionsService],
})
export class WebhookSubscriptionsModule {}
