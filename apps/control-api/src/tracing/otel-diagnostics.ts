import { DiagLogFunction, DiagLogger } from '@opentelemetry/api';

/** The slice of Nest's `Logger` this needs. Keeps the unit test dependency-free. */
export interface DiagSink {
  warn(message: string): void;
  error(message: string): void;
}

export const DEFAULT_DIAG_THROTTLE_MS = 60_000;

/**
 * OpenTelemetry's internal diagnostics, made safe to leave switched on.
 *
 * ## The problem this solves
 *
 * With no diag logger, a collector that is down is COMPLETELY silent - the
 * batch processor drops spans and nobody finds out until someone goes looking
 * for a trace that was never recorded. That is the "control that lies" shape
 * this codebase keeps fixing.
 *
 * With the obvious diag logger, a collector that is down writes an export
 * failure every scheduled delay - by default every five seconds, for ever -
 * into the same log stream an operator is trying to read during the incident
 * that took the collector down. Observability that shouts over the incident it
 * is meant to help with is worse than silence.
 *
 * So: report each distinct failure once, then at most once a minute, and count
 * what was suppressed so the log line stays honest about the volume. Only
 * `error` and `warn` are wired; `info`, `debug` and `verbose` are dropped,
 * because the SDK is chatty at those levels and none of it is actionable here.
 */
export function createThrottledDiagLogger(
  sink: DiagSink,
  throttleMs: number = DEFAULT_DIAG_THROTTLE_MS,
  now: () => number = Date.now,
): DiagLogger {
  const lastLoggedAt = new Map<string, number>();
  const suppressed = new Map<string, number>();

  const emit =
    (level: 'warn' | 'error'): DiagLogFunction =>
    (message, ...args) => {
      // Keyed on the message only. The arguments of an export failure carry the
      // attempt number and the error object, so keying on them would make every
      // repeat "distinct" and defeat the whole thing.
      const key = `${level}:${message}`;
      const at = now();
      const last = lastLoggedAt.get(key);

      if (last !== undefined && at - last < throttleMs) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return;
      }

      const hidden = suppressed.get(key) ?? 0;
      lastLoggedAt.set(key, at);
      suppressed.delete(key);

      const detail = args.length > 0 ? ` ${args.map(describe).join(' ')}` : '';
      const tail = hidden > 0 ? ` (${hidden} similar message(s) suppressed)` : '';
      sink[level](`OpenTelemetry: ${message}${detail}${tail}`);
    };

  const drop: DiagLogFunction = () => undefined;

  return {
    error: emit('error'),
    warn: emit('warn'),
    info: drop,
    debug: drop,
    verbose: drop,
  };
}

/**
 * Never `JSON.stringify` here. A diag argument is whatever the SDK passed -
 * commonly an Error, sometimes a request object - and serialising an arbitrary
 * object into the log is exactly how a header or a connection string ends up in
 * a log line. An Error's message and a primitive's text are enough to tell an
 * operator the collector is unreachable.
 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `[${typeof value}]`;
}
