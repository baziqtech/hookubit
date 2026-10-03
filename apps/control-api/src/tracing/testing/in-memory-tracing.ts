import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { setTracingEnabled } from '../tracing.runtime';

export interface InMemoryTracing {
  spans(): ReadableSpan[];
  named(name: string): ReadableSpan | undefined;
  reset(): void;
  stop(): Promise<void>;
}

/**
 * A real SDK writing to memory.
 *
 * `NodeTracerProvider.register()` is used rather than hand-wiring a context
 * manager for two reasons: `@opentelemetry/context-async-hooks` is a transitive
 * dependency and not one this package declares, so importing it directly would
 * be reaching through the dependency graph; and `register()` is what production
 * calls, so the async-context propagation these tests depend on is the same
 * mechanism production depends on. A test that stubbed it could pass while the
 * real thing lost the parent span across an `await`.
 *
 * `SimpleSpanProcessor`, not `BatchSpanProcessor`: spans must be readable the
 * instant they end, with no timer to wait on.
 */
export function startInMemoryTracing(): InMemoryTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  setTracingEnabled(true);

  return {
    spans: () => exporter.getFinishedSpans(),
    named: (name) => exporter.getFinishedSpans().find((span) => span.name === name),
    reset: () => exporter.reset(),
    stop: async () => {
      setTracingEnabled(false);
      await provider.shutdown();
      // The API keeps ONE global provider, propagator and context manager per
      // process. Without these a second `register()` in the same file is
      // refused and every later assertion silently reads the first provider.
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
