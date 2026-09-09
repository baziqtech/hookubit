import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { setTracingEnabled } from './tracing.runtime';
import { withSpan } from './with-span';
import { InMemoryTracing, startInMemoryTracing } from './testing/in-memory-tracing';

describe('withSpan', () => {
  describe('with tracing off', () => {
    beforeEach(() => setTracingEnabled(false));

    it('is exactly the callback - same value, no span argument', async () => {
      const result = await withSpan('sweep', {}, async (span) => {
        expect(span).toBeUndefined();
        return 42;
      });
      expect(result).toBe(42);
    });

    it('does not alter a failure', async () => {
      const failure = new Error('sweep failed');
      await expect(withSpan('sweep', {}, () => Promise.reject(failure))).rejects.toBe(failure);
    });
  });

  describe('with tracing on', () => {
    let tracing: InMemoryTracing;
    beforeEach(() => {
      tracing = startInMemoryTracing();
    });
    afterEach(async () => {
      await tracing.stop();
    });

    it('records a span and still returns the work’s value', async () => {
      await expect(withSpan('sweep', {}, async () => 'done')).resolves.toBe('done');
      expect(tracing.named('sweep')?.kind).toBe(SpanKind.INTERNAL);
    });

    it('makes the span active, so work started inside nests under it', async () => {
      await withSpan('sweep', {}, async () => {
        const inner = trace.getTracer('t').startSpan('inner');
        inner.end();
      });

      expect(tracing.named('inner')?.parentSpanContext?.spanId).toBe(
        tracing.named('sweep')?.spanContext().spanId,
      );
    });

    it('marks a failure and RETHROWS it unchanged', async () => {
      class SweepFailed extends Error {}
      const failure = new SweepFailed('lock contention');

      await expect(withSpan('sweep', {}, () => Promise.reject(failure))).rejects.toBe(failure);

      const span = tracing.named('sweep');
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes['error.type']).toBe('Error');
      // The message can name a row, a constraint or a connection string.
      expect(JSON.stringify(span?.attributes)).not.toContain('lock contention');
    });

    it('ends the span on the failure path too', async () => {
      await expect(withSpan('sweep', {}, () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(tracing.spans()).toHaveLength(1);
    });

    it('leaves no active span behind once it returns', async () => {
      await withSpan('sweep', {}, async () => undefined);
      expect(trace.getSpan(context.active())).toBeUndefined();
    });
  });
});
