import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { BillingModule } from './billing/billing.module';
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
import { NotificationDestinationsModule } from './notification-destinations/notification-destinations.module';
import { RateLimitsModule } from './rate-limits/rate-limits.module';
import { RetryPoliciesModule } from './retry-policies/retry-policies.module';
import { traceLogFields } from './tracing/log-correlation';
import { TracingModule } from './tracing/tracing.module';
import { WebhookSubscriptionsModule } from './webhook-subscriptions/webhook-subscriptions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // TWO files, and each entry has exactly one job. Both are resolved
      // against the process CWD, which is `apps/control-api` in every way this
      // service is actually started: `pnpm --filter @hookubit/control-api
      // start:dev` and `jest` both run from the package directory, and
      // systemd's WorkingDirectory is `<deploy>/current/apps/control-api`. So
      // the same two relative paths mean the same two things in development and
      // in production, which is the point.
      //
      //   '.env'        this service's OWN variables - the ones only the
      //                 control plane reads (JWT_SECRET, SESSION_SECRET,
      //                 CORS_ORIGINS, TRUST_PROXY_HOPS, SMTP_*, ...).
      //                 apps/control-api/.env in development; in production a
      //                 Deployer shared_files symlink to shared/apps/control-api/.env.
      //   '../../.env'  the COMMON variables both planes must agree on
      //                 (APP_ENV, DATABASE_URL, ENCRYPTION_KEY*, REDIS_URL,
      //                 LOG_LEVEL, OTEL_*). The repository root in development;
      //                 the release root in production, where Deployer symlinks
      //                 shared/.env. They are not duplicated into this
      //                 service's file on purpose: an ENCRYPTION_KEY that
      //                 drifts between the two planes means the control API
      //                 writes endpoint secrets the Go worker cannot decrypt,
      //                 and each process validates its own config happily.
      //
      // ORDER IS SIGNIFICANT and this one is deliberate. @nestjs/config's
      // loadEnvFile does `config = Object.assign(dotenv.parse(file), config)`
      // walking the array, so what is already accumulated wins - EARLIER
      // entries beat later ones. Service-specific therefore overrides common,
      // which is also how systemd resolves it (later EnvironmentFile= wins, and
      // the units list common first). Real environment variables beat both.
      //
      // '.env.local' was the first entry until it was removed: it was the only
      // reference to that filename anywhere in the repository, so it was a
      // lookup that could never succeed and a third name for operators to
      // wonder about.
      envFilePath: ['.env', '../../.env'],
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
        // Log <-> trace correlation (ARCHITECTURE.md 63 asks for both, and two
        // systems that cannot be joined are not both). Inert when tracing is
        // off; see tracing/log-correlation.ts.
        customProps: traceLogFields,
        transport:
          process.env.APP_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    // OpenTelemetry (ARCHITECTURE.md 44). Registered next to LoggerModule
    // because the two are one feature: the span carries pino's request id and
    // pino's lines carry the span's trace id. The relative order of the two
    // does not matter - the middleware reads `req.id` when the response
    // finishes, by which time pino has long since minted it, and pino's own
    // completion line is emitted inside the request's async context either way
    // (asserted in tracing/log-correlation.spec.ts).
    TracingModule,
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
    NotificationDestinationsModule,
    // The operator surface. ARCHITECTURE.md is blunt that this is what people
    // pay for: answering "what happened to this event?" without reaching for
    // psql. It reads the rows the Go router and worker write.
    EventsModule,
    DeliveriesModule,
    // The recovery surface for events the router could not route. Without it
    // a parked outbox row - an event already answered 202 Accepted - is
    // invisible to this API and recoverable only by hand-written SQL.
    OutboxModule,
    AuditModule,
    AnalyticsModule,
    BillingModule,
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
