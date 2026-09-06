import { requestIdForResponse, resolveRequestId } from './request-id';

/** REGRESSION (FIX 7): a client-supplied correlation id used to be trusted verbatim. */
describe('resolveRequestId', () => {
  it('honours a well-formed client id so callers can correlate their traces', () => {
    expect(resolveRequestId('req_01HQ8Z-abc_DEF')).toBe('req_01HQ8Z-abc_DEF');
  });

  it.each([
    ['a newline, which would forge a log line', 'ok\ninjected level=fatal msg="pwned"'],
    ['a JSON fragment, which would forge structured fields', '","level":60,"msg":"'],
    ['a space, which nothing legitimate sends', 'req 123'],
    ['ANSI escapes, which rewrite a terminal reading the logs', '\u001b[31mred'],
    ['a NUL byte', 'req\u0000id'],
    ['an empty string', ''],
    ['65 characters, one past the cap', 'a'.repeat(65)],
  ])('refuses %s and mints its own id instead', (_label, supplied) => {
    const id = resolveRequestId(supplied);

    expect(id).not.toBe(supplied);
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('mints an id when the header is absent', () => {
    expect(resolveRequestId(undefined)).toMatch(/^req_/);
  });

  it('takes the first value when the header is repeated, and still validates it', () => {
    expect(resolveRequestId(['good-1', 'good-2'])).toBe('good-1');
    expect(resolveRequestId(['bad value', 'good-2'])).toMatch(/^req_/);
  });

  it('accepts exactly 64 characters', () => {
    const id = 'b'.repeat(64);
    expect(resolveRequestId(id)).toBe(id);
  });
});

describe('requestIdForResponse', () => {
  it('uses the id already on the request', () => {
    expect(requestIdForResponse({ id: 'req_abc', headers: {} })).toBe('req_abc');
  });

  it('never echoes an unvalidated header into an error body', () => {
    const hostile = { id: 'x\ny', headers: { 'x-request-id': 'also\nbad' } };

    expect(requestIdForResponse(hostile)).toBe('unknown');
  });

  it('falls back to a well-formed header when nothing set req.id', () => {
    expect(requestIdForResponse({ headers: { 'x-request-id': 'client-42' } })).toBe('client-42');
  });

  it('says "unknown" rather than inventing an id that appears in no log line', () => {
    expect(requestIdForResponse({ headers: {} })).toBe('unknown');
  });
});
