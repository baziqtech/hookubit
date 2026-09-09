import { Span, SpanKind, SpanOptions, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { isTracingEnabled, tracer } from './tracing.runtime';

/**
 * Runs `work` inside a span, or just runs it.
 *
 * For work that has no HTTP request behind it - the periodic sweeps. Without
 * this, the database spans those jobs produce are parentless one-span traces
 * with no clue what asked for them; with it, a sweep is one trace whose
 * children are its queries.
 *
 * The contract that makes it safe to sprinkle: with tracing off it is exactly
 * `work()` - no span object, no context switch, no allocation - and it NEVER
 * alters what `work` returns or throws. A span is a description of the work,
 * not a participant in it.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  work: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) return work(undefined);

  const span = tracer().startSpan(name, { kind: SpanKind.INTERNAL, ...options });
  try {
    return await context.with(trace.setSpan(context.active(), span), () => work(span));
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(ATTR_ERROR_TYPE, err instanceof Error ? err.name : 'unknown');
    throw err;
  } finally {
    span.end();
  }
}
