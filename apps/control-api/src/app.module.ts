import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { AuthzModule } from './authz/authz.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { CommonModule } from './common/common.module';
import { resolveRequestId } from './common/request-id';
import { validateEnv } from './config/env.schema';
import { EndpointSecretsModule } from './endpoint-secrets/endpoint-secrets.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { EndpointsModule } from './endpoints/endpoints.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { MembersModule } from './members/members.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OutboxModule } from './outbox/outbox.module';
import { ProjectsModule } from './projects/projects.module';
import { RateLimitsModule } from './rate-limits/rate-limits.module';
import { RetryPoliciesModule } from './retry-policies/retry-policies.module';
import { WebhookSubscriptionsModule } from './webhook-subscriptions/webhook-subscriptions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env', '../../.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // A client-supplied x-request-id is honoured only if it looks like an
        // id (FIX 7). It was previously taken verbatim, so anything a caller
        // typed - a log-injection payload, a 40KB string, a fake JSON fragment -
        // became a first-class `req.id` field in centralised logging and came
        // back in a response header and in every error body. Nothing downstream
        // parses it, so the cheapest correct answer is to refuse anything that
        // is not an id and mint one instead.
        genReqId: (req, res) => {
          const id = resolveRequestId(req.headers['x-request-id']);
          res.setHeader('x-request-id', id);
          return id;
        },
        // Never log secrets (engineering rule 12).
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.secret',
            'res.headers["set-cookie"]',
          ],
          remove: true,
        },
        transport:
          process.env.APP_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    PrismaModule,
    CommonModule,
    HealthModule,
    AuthModule,
    // Tenant resolution + RBAC. Global, so every Phase 2 controller can use
    // @Authorized() without importing anything (ARCHITECTURE.md 10).
    AuthzModule,
    // Phase 2 tenant resources. Ordered along the ownership chain -
    // organization -> project -> endpoint - so the dependency direction is
    // legible; Nest itself does not care about the order.
    OrganizationsModule,
    MembersModule,
    ProjectsModule,
    ApiKeysModule,
    EndpointsModule,
    EndpointSecretsModule,
    WebhookSubscriptionsModule,
    RetryPoliciesModule,
    RateLimitsModule,
    // The operator surface. ARCHITECTURE.md is blunt that this is what people
    // pay for: answering "what happened to this event?" without reaching for
    // psql. It reads the rows the Go router and worker write.
    EventsModule,
    DeliveriesModule,
    // The recovery surface for events the router could not fan out. Without it
    // a parked outbox row - an event already answered 202 Accepted - is
    // invisible to this API and recoverable only by hand-written SQL.
    OutboxModule,
    AuditModule,
    AnalyticsModule,
    // Periodic reconciliation with no routes of its own. It switches off
    // endpoints whose circuit breaker has been open past the window, so a dead
    // endpoint stops accruing a delivery row per matching event for ever, and
    // it files the audit entry that tells the customer why. The re-enable is
    // the endpoints module's existing `POST .../enable`.
    MaintenanceModule,
    // Still to come: admin (platform staff, above organization owner - it needs
    // an authorization concept the tenant matrix deliberately does not have).
  ],
})
export class AppModule {}
