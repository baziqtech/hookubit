import { context, isSpanContextValid, propagation, trace } from '@opentelemetry/api';
import { isTracingEnabled } from '../tracing';

/**
 * A W3C `traceparent` is fixed-width: `00-` + 32 hex + `-` + 16 hex + `-` + 2
 * hex. Anything else is not one, whatever a propagator returned.
 */
export const TRACEPARENT_LENGTH = 55;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * The active span's W3C `traceparent`, or null.
 *
 * This is what the control plane may write to `deliveries.trace_context`,
 * and the rules are the ones the data plane's router follows for the same
 * column (services/data-plane/internal/tracing): the value is the CURRENT
 * span's, serialised by the registered propagator - never assembled by hand,
 * never copied from a request header - and it is absent rather than invented.
 *
 * Null in three cases, and none of them is an error:
 *
 *  - tracing is off (no collector configured), which is the common case for a
 *    self-hosted install and costs one boolean read here;
 *  - tracing is on but nothing is active - a caller outside any request, or a
 *    test that did not open a span;
 *  - the propagator produced nothing usable, which means no propagator is
 *    registered; the SDK registers the W3C one, so this is a misconfiguration
 *    the trace backend will show, not one this column should paper over.
 *
 * The sampled flag travels in the last two hex digits and is deliberately NOT
 * consulted: the worker's sampler reads it when it opens the next stage, and
 * deciding here would make two components disagree about one bit.
 */
export function currentTraceparent(): string | null {
  if (!isTracingEnabled()) return null;

  const active = context.active();
  const span = trace.getSpan(active);
  if (!span || !isSpanContextValid(span.spanContext())) return null;

  const carrier: Record<string, string> = {};
  propagation.inject(active, carrier);
  const header = carrier['traceparent'];
  return typeof header === 'string' && TRACEPARENT.test(header) ? header : null;
}
