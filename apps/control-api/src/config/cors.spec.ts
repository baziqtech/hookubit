import { EXPOSED_HEADERS, corsOptions } from './cors';

describe('corsOptions', () => {
  it('exposes Retry-After, so a cross-origin 429 is readable', () => {
    // The browser drops every response header that is neither CORS-safelisted
    // nor on Access-Control-Expose-Headers, and it does so SILENTLY - nothing
    // errors, the header simply does not exist for JavaScript. ThrottleGuard
    // was setting Retry-After on every 429 and the dashboard could never see
    // it.
    expect(corsOptions('https://app.example.com').exposedHeaders).toContain('Retry-After');
  });

  it('exposes the request id the error body quotes', () => {
    // `request_id` appears in every error body; the header is the only way to
    // get it off a SUCCESSFUL response, which is what an operator needs when a
    // request went through but did the wrong thing.
    expect(EXPOSED_HEADERS).toContain('x-request-id');
  });

  it('exposes nothing else - the list is a deliberate allowlist', () => {
    expect([...EXPOSED_HEADERS].sort()).toEqual(['Retry-After', 'x-request-id']);
  });

  it('splits and trims a comma-separated origin list', () => {
    expect(corsOptions(' https://a.example.com , https://b.example.com ').origin).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('FAILS CLOSED when CORS_ORIGINS is unset or blank', () => {
    // `false`, never `true` and never a reflected origin: this API is
    // credentialed, so reflecting an arbitrary Origin would hand any site the
    // caller's session cookie.
    expect(corsOptions(undefined).origin).toBe(false);
    expect(corsOptions('').origin).toBe(false);
    expect(corsOptions(' , ').origin).toBe(false);
  });

  it('keeps credentials on - the session is a cookie', () => {
    expect(corsOptions('https://app.example.com').credentials).toBe(true);
  });
});
