import { DEFAULT_DIAG_THROTTLE_MS, DiagSink, createThrottledDiagLogger } from './otel-diagnostics';

function sink(): DiagSink & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    warn: (m) => warnings.push(m),
    error: (m) => errors.push(m),
  };
}

describe('createThrottledDiagLogger', () => {
  it('reports the first failure immediately - a dead collector must not be silent', () => {
    const out = sink();
    createThrottledDiagLogger(out).error('Export failed');
    expect(out.errors).toEqual(['OpenTelemetry: Export failed']);
  });

  it('suppresses repeats of the same message inside the window', () => {
    let now = 0;
    const out = sink();
    const logger = createThrottledDiagLogger(out, 60_000, () => now);

    logger.error('Export failed');
    now = 5_000;
    logger.error('Export failed');
    now = 10_000;
    logger.error('Export failed');

    expect(out.errors).toHaveLength(1);
  });

  it('reports again after the window, and says how many it swallowed', () => {
    let now = 0;
    const out = sink();
    const logger = createThrottledDiagLogger(out, 60_000, () => now);

    logger.error('Export failed');
    now = 10_000;
    logger.error('Export failed');
    logger.error('Export failed');
    now = 70_000;
    logger.error('Export failed');

    expect(out.errors).toHaveLength(2);
    expect(out.errors[1]).toContain('2 similar message(s) suppressed');
  });

  it('throttles per message, so a second distinct failure is not hidden by the first', () => {
    let now = 0;
    const out = sink();
    const logger = createThrottledDiagLogger(out, 60_000, () => now);

    logger.error('Export failed');
    now = 1_000;
    logger.error('Connection refused');

    expect(out.errors).toHaveLength(2);
  });

  it('keys on the message only, so per-attempt arguments do not defeat it', () => {
    let now = 0;
    const out = sink();
    const logger = createThrottledDiagLogger(out, 60_000, () => now);

    logger.error('Export failed', 'attempt 1');
    now = 1_000;
    logger.error('Export failed', 'attempt 2');
    now = 2_000;
    logger.error('Export failed', 'attempt 3');

    expect(out.errors).toHaveLength(1);
  });

  it('keeps warn and error in separate buckets', () => {
    const out = sink();
    const logger = createThrottledDiagLogger(out);
    logger.warn('Something');
    logger.error('Something');
    expect(out.warnings).toHaveLength(1);
    expect(out.errors).toHaveLength(1);
  });

  it('drops info, debug and verbose entirely', () => {
    const out = sink();
    const logger = createThrottledDiagLogger(out);
    logger.info('chatty');
    logger.debug('chatty');
    logger.verbose('chatty');
    expect(out.warnings).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('reports an Error argument by message and NEVER serialises an object', () => {
    const out = sink();
    const logger = createThrottledDiagLogger(out);

    logger.error('Export failed', new Error('connect ECONNREFUSED 10.0.0.1:4318'));
    expect(out.errors[0]).toContain('connect ECONNREFUSED 10.0.0.1:4318');

    // An arbitrary object could be a request carrying headers. Its SHAPE is
    // logged, never its contents.
    logger.error('Other failure', { headers: { authorization: 'Bearer super-secret' } });
    expect(out.errors[1]).toContain('[object]');
    expect(out.errors[1]).not.toContain('super-secret');
    expect(out.errors[1]).not.toContain('authorization');
  });

  it('defaults to a one-minute window', () => {
    expect(DEFAULT_DIAG_THROTTLE_MS).toBe(60_000);
  });
});
