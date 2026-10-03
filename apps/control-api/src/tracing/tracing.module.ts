import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HttpTraceMiddleware } from './http-trace.middleware';
import { TracerProviderService } from './tracer-provider.service';

/**
 * OpenTelemetry tracing for the control plane (ARCHITECTURE.md 44).
 *
 * ## Three instrumentation points, one switch
 *
 *  - `TracerProviderService` builds the SDK, or deliberately builds nothing.
 *  - `HttpTraceMiddleware` is the server span, named by route template.
 *  - `PrismaService` installs the query hook from `prisma-tracing.ts`.
 *
 * The third is wired from inside `PrismaService` rather than from here on
 * purpose. Reaching it from this module would mean importing `PrismaModule` -
 * which is not `@Global()` precisely so that "why does this module talk to the
 * unscoped client?" is a question a reviewer gets asked - and `.eslintrc.json`
 * would need a new entry granting `src/tracing/**` access to it. A
 * cross-cutting concern is not a good reason to widen that fence, and the hook
 * belongs next to the client it hooks.
 *
 * ## `@Global()`
 *
 * `TracerProviderService` has no consumers; it exists for its lifecycle hooks.
 * Global costs nothing here and means a future module that wants the tracer
 * does not have to edit this file. The middleware is bound below, not injected.
 *
 * ## Ordering
 *
 * Registered after `LoggerModule` in `app.module.ts` so pino's `genReqId` has
 * already minted `req.id` before the request reaches the middleware chain -
 * which is what lets the span and the log lines carry the same request id in
 * both directions.
 */
@Global()
@Module({
  providers: [TracerProviderService, HttpTraceMiddleware],
  exports: [TracerProviderService],
})
export class TracingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // `'*'` with a global prefix expands to `/v1/*` PLUS the routes excluded
    // from the prefix - the two health probes. The probes are dropped inside
    // the middleware instead of with `.exclude()`, because `.exclude()` paths
    // are resolved relative to the prefix these two are not under, so the
    // exclusion would quietly do nothing.
    consumer.apply(HttpTraceMiddleware).forRoutes('*');
  }
}
