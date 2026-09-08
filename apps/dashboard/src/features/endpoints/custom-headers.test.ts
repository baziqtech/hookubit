import { describe, expect, it } from 'vitest';
import { formatCustomHeaders, isReservedHeader, parseCustomHeaders } from './custom-headers';

/**
 * These headers are merged into a request the platform SIGNS, so the reserved
 * list is a security boundary rather than tidiness: a tenant able to add a
 * second `Webhook-Signature` hands their consumer a signature the platform did
 * not compute, next to one it did, and the consumer's verifier accepts either.
 *
 * The server refuses all of this anyway. What is tested here is that the form
 * refuses it in the SAME terms, at the moment it is typed.
 */
describe('parseCustomHeaders', () => {
  it('reads one header per line', () => {
    expect(parseCustomHeaders('X-Tenant: shaq\nX-Trace: on')).toEqual({
      ok: true,
      headers: { 'X-Tenant': 'shaq', 'X-Trace': 'on' },
    });
  });

  it('treats empty text as null, never as an empty map', () => {
    // "Unset" has one representation on the wire — the server normalises {} to
    // NULL — so sending the other one is a PATCH that changes nothing while
    // looking like a save.
    expect(parseCustomHeaders('   \n  ')).toEqual({ ok: true, headers: null });
  });

  it('keeps a value containing a colon intact', () => {
    const parsed = parseCustomHeaders('X-Origin: https://shaq.example.com:8443/hooks');
    expect(parsed).toEqual({
      ok: true,
      headers: { 'X-Origin': 'https://shaq.example.com:8443/hooks' },
    });
  });

  it('refuses every reserved header, and says why', () => {
    for (const name of ['Authorization', 'host', 'Content-Length', 'Transfer-Encoding']) {
      const parsed = parseCustomHeaders(`${name}: anything`);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toContain('reserved');
    }
  });

  it('refuses the whole Webhook-* namespace, not just the signature', () => {
    // `Webhook-Id`, `Webhook-Timestamp` and `Webhook-Delivery-Id` are the
    // platform's contract with the consumer; restating any of them makes a
    // delivery claim to be a different event or a different attempt.
    for (const name of ['Webhook-Signature', 'webhook-id', 'Webhook-Timestamp', 'WEBHOOK-Foo']) {
      expect(isReservedHeader(name)).toBe(true);
      expect(parseCustomHeaders(`${name}: x`).ok).toBe(false);
    }
  });

  it('refuses the same header twice in different cases', () => {
    // Header names are case-insensitive, so this is one header with two values.
    const parsed = parseCustomHeaders('X-Trace: a\nx-trace: b');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('twice');
  });

  it('refuses a line that is not a header at all', () => {
    const parsed = parseCustomHeaders('this is not a header');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('Name: value');
  });

  it('round-trips through the textarea representation', () => {
    const headers = { 'X-A': '1', 'X-B': 'two' };
    expect(parseCustomHeaders(formatCustomHeaders(headers))).toEqual({ ok: true, headers });
    expect(formatCustomHeaders(null)).toBe('');
  });
});
