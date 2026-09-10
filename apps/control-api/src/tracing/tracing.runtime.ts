import { Tracer, trace } from '@opentelemetry/api';

export const TRACER_NAME = '@hookubit/control-api';
export const TRACER_VERSION = '0.1.0';

/**
 * One process-wide "is tracing actually on?" flag.
 *
 * ## Why a module-level flag rather than an injected setting
 *
 * Two of the three instrumentation points cannot reach the Nest injector at the
 * moment they need the answer. The Prisma `$use` hook is installed on a client
 * that must not learn about `ConfigService` (it is the unscoped client, and its
 * dependency list is deliberately empty), and `withSpan` is called from plain
 * functions. Threading a provider through both would mean either making
 * `PrismaService` config-aware or making every caller pass a tracer - and the
 * value being threaded is a single boolean that is written once at boot and
 * never again.
 *
 * The rule that keeps this honest: `TracerProviderService` is the ONLY writer,
 * it writes exactly once during `onModuleInit`, and it writes `false` again on
 * shutdown. Everything else reads.
 *
 * ## Why it is checked at all
 *
 * `trace.getTracer(...).startSpan()` with no SDK registered returns a
 * non-recording span, so the code would be *correct* without the flag. It would
 * also allocate a span object and run every attribute call for every database
 * query of every request on an install that has never configured a collector -
 * which is the overwhelmingly common case for a self-hosted deployment. The
 * flag makes "no collector configured" cost one boolean read.
 */
const state = { enabled: false };

/** Only `TracerProviderService` may call this. */
export function setTracingEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function isTracingEnabled(): boolean {
  return state.enabled;
}

/**
 * Not memoised on purpose. After `NodeTracerProvider.register()` the global
 * provider resolves this from its own cache, so the call is cheap; memoising
 * would pin the first-resolved delegate, and a suite that registers a provider,
 * shuts it down and registers another would then write spans into the dead one.
 */
export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}
