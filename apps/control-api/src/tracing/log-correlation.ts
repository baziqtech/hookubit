import { trace } from '@opentelemetry/api';

/**
 * The trace fields pino puts on every line of a traced request.
 *
 * ARCHITECTURE.md 63 asks for structured logs AND traces. Two systems that
 * cannot be joined are not both: the question at 02:14 is "this error line -
 * what else happened in that request?", and answering it means the log line
 * carries the ids the trace backend indexes by. `trace_id`/`span_id` are the
 * names every backend expects, so they are not namespaced like our span
 * attributes are.
 *
 * Inert by construction: with no SDK registered there is no active span and
 * this returns an empty object, so a log line on an install with no collector
 * is byte-for-byte what it was before.
 *
 * The other direction is `webhook.request_id` on the span - see
 * `http-trace.middleware.ts`. Both are needed: this one takes you from a log
 * line to the trace, that one takes you from a trace back to the log lines.
 */
export function traceLogFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}
