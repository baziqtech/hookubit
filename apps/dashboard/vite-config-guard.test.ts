import { describe, expect, it } from 'vitest';
import { evaluateApiTransport } from './vite.config';

/**
 * The build guard's decision table. `evaluateApiTransport` is the pure half of
 * the `apply: 'build'` plugin in `vite.config.ts`; the plugin itself only
 * prints the verdict and throws on a refusal, so pinning the table here covers
 * everything a spawned build would, in milliseconds and without a dist/.
 *
 * What this does NOT cover, and cannot without spawning a build: that the
 * plugin is wired into `plugins` and that `apply: 'build'` keeps it away from
 * `vite dev` and from this very test run. Those are verified by execution in
 * the task record — and, circularly but usefully, by the fact that this file
 * runs at all.
 */
describe('evaluateApiTransport', () => {
  it('allows an explicit http build silently', () => {
    expect(evaluateApiTransport('http')).toEqual({ kind: 'ok' });
  });

  it('allows an explicit mock build, with a warning', () => {
    const verdict = evaluateApiTransport('mock');
    expect(verdict.kind).toBe('warn');
    if (verdict.kind !== 'warn') throw new Error('unreachable');
    expect(verdict.message).toContain('VITE_API_TRANSPORT=mock');
    expect(verdict.message).toContain('DEMO');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses a %s value as the forgotten-variable case', (_name, raw) => {
    const verdict = evaluateApiTransport(raw);
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') throw new Error('unreachable');
    expect(verdict.message).toContain('is not set');
    // The message has to name the variable, the valid values and the
    // consequence; an operator reading a failed deploy log gets one shot.
    expect(verdict.message).toContain('VITE_API_TRANSPORT');
    expect(verdict.message).toContain('VITE_API_TRANSPORT=http');
    expect(verdict.message).toContain('VITE_API_TRANSPORT=mock');
    expect(verdict.message).toContain('IN-MEMORY MOCK');
    expect(verdict.message).toContain('data that does not exist');
  });

  it.each([
    'HTTP',
    'Http',
    'htp',
    'https',
    'MOCK',
    'real',
    'true',
    ' http',
    'http ',
    ' http ',
    'http\n',
  ])('refuses %j rather than falling through to the mock', (raw) => {
    const verdict = evaluateApiTransport(raw);
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') throw new Error('unreachable');
    expect(verdict.message).toContain('not a value this build recognises');
    expect(verdict.message).toContain('`http` and `mock`');
    // The offending value is quoted, so trailing whitespace and case are
    // visible in the log rather than invisible.
    expect(verdict.message).toContain(JSON.stringify(raw));
    expect(verdict.summary).toContain(JSON.stringify(raw));
  });

  it('accepts only the two exact spellings the bundle itself compares against', () => {
    // src/lib/api.ts does `=== 'http'`. If this list ever grows, that
    // comparison is what has to grow with it.
    const accepted = ['http', 'mock', 'HTTP', ' http ', 'htp', '', 'x'].filter(
      (v) => evaluateApiTransport(v).kind !== 'refuse',
    );
    expect(accepted).toEqual(['http', 'mock']);
  });
});
