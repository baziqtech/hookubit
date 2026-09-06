import {
  MAX_CUSTOM_HEADERS,
  isReservedHeader,
  normaliseCustomHeaders,
  rejectCustomHeaders,
} from './endpoint-headers';

describe('reserved custom headers', () => {
  /**
   * The finding, restated as a test: `signing.Verify` accepts a delivery if ANY
   * `v1=` component matches, which is what makes an overlapping rotation window
   * work. A tenant able to add a second `Webhook-Signature` would be handing the
   * consumer a signature the platform never computed, alongside one it did.
   */
  it.each([
    'Webhook-Signature',
    'webhook-signature',
    'WEBHOOK-SIGNATURE',
    'Webhook-Id',
    'Webhook-Delivery-Id',
    'Webhook-Timestamp',
    'Webhook-Anything-At-All',
    'Authorization',
    'authorization',
    'Host',
    'Content-Length',
    'Transfer-Encoding',
  ])('refuses %s', (name) => {
    expect(isReservedHeader(name)).toBe(true);
    const rejection = rejectCustomHeaders({ [name]: 'x' });
    expect(rejection?.header).toBe(name);
    expect(rejection?.reason).toContain('reserved');
  });

  it('allows ordinary headers a customer actually needs', () => {
    expect(
      rejectCustomHeaders({
        'X-Tenant': 'acme',
        'X-Api-Version': '2026-09-01',
        Accept: 'application/json',
      }),
    ).toBeNull();
  });

  /** `X-Webhook-Signature` is not in our namespace; only the prefix is reserved. */
  it('does not over-reach past the Webhook- prefix', () => {
    expect(isReservedHeader('X-Webhook-Signature')).toBe(false);
    expect(rejectCustomHeaders({ 'X-Webhook-Signature': 'x' })).toBeNull();
  });
});

describe('custom header shape', () => {
  it('refuses a CR or LF in a value - that is header injection, not a header', () => {
    expect(rejectCustomHeaders({ 'X-Trace': 'a\r\nX-Evil: 1' })?.reason).toContain(
      'control characters',
    );
    expect(rejectCustomHeaders({ 'X-Trace': 'a\nb' })?.reason).toContain('control characters');
  });

  it('refuses a name that is not a token', () => {
    expect(rejectCustomHeaders({ 'X Trace': 'a' })?.reason).toContain('not allowed');
    expect(rejectCustomHeaders({ 'X-Trace:': 'a' })?.reason).toContain('not allowed');
  });

  it('refuses two spellings of the same header', () => {
    expect(rejectCustomHeaders({ 'X-Trace': 'a', 'x-trace': 'b' })?.reason).toContain('duplicate');
  });

  it('refuses non-string values and over-long ones', () => {
    expect(rejectCustomHeaders({ 'X-Trace': 42 })?.reason).toContain('must be a string');
    expect(rejectCustomHeaders({ 'X-Trace': 'a'.repeat(2000) })?.reason).toContain('at most');
  });

  it('caps the number and the total size', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_CUSTOM_HEADERS; i += 1) many[`X-H${i}`] = 'v';
    expect(rejectCustomHeaders(many)?.reason).toContain(`at most ${MAX_CUSTOM_HEADERS}`);

    const heavy: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_HEADERS; i += 1) heavy[`X-H${i}`] = 'v'.repeat(1024);
    expect(rejectCustomHeaders(heavy)?.reason).toContain('bytes');
  });

  it('treats absent, null and empty as "no custom headers"', () => {
    expect(rejectCustomHeaders(undefined)).toBeNull();
    expect(rejectCustomHeaders(null)).toBeNull();
    expect(rejectCustomHeaders({})).toBeNull();
    expect(normaliseCustomHeaders({})).toBeNull();
    expect(normaliseCustomHeaders(null)).toBeNull();
    expect(normaliseCustomHeaders({ 'X-Trace': 'a' })).toEqual({ 'X-Trace': 'a' });
  });

  it('refuses an array, which would otherwise pass a bare typeof check', () => {
    expect(rejectCustomHeaders(['X-Trace'])?.reason).toContain('object of string values');
  });
});
