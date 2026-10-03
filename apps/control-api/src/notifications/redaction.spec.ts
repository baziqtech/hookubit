import { fingerprintToken, redactRecipient, scrubAddresses } from './redaction';

describe('redactRecipient', () => {
  it('keeps the domain, replaces the local part with a stable hash', () => {
    const redacted = redactRecipient('Ada.Lovelace@Example.com');
    expect(redacted).toMatch(/^[0-9a-f]{12}@example\.com$/);
    expect(redacted).not.toContain('ada');
    expect(redacted).not.toContain('lovelace');
  });

  it('is stable across case and whitespace, so two failures for one person group together', () => {
    expect(redactRecipient('ada@example.com')).toBe(redactRecipient('  ADA@EXAMPLE.COM '));
    expect(redactRecipient('ada@example.com')).not.toBe(redactRecipient('bob@example.com'));
  });

  it('copes with something that is not an address at all', () => {
    expect(redactRecipient('not-an-address')).toMatch(/^[0-9a-f]{12}@unknown$/);
  });
});

describe('scrubAddresses', () => {
  it('removes the recipient from an SMTP rejection line', () => {
    const line = 'Recipient command failed: 550 5.1.1 <ada@example.com>: Recipient address rejected';
    const scrubbed = scrubAddresses(line);
    expect(scrubbed).not.toContain('ada@example.com');
    expect(scrubbed).toContain('550 5.1.1');
  });

  it('removes every address, not just the first', () => {
    expect(scrubAddresses('from a@x.io to b@y.io')).toBe(
      'from <address redacted> to <address redacted>',
    );
  });

  it('leaves an address-free message alone', () => {
    expect(scrubAddresses('connect ECONNREFUSED 127.0.0.1:1025')).toBe(
      'connect ECONNREFUSED 127.0.0.1:1025',
    );
  });
});

describe('fingerprintToken', () => {
  it('shows six characters and the length - correlatable, not replayable', () => {
    const raw = 'Zm9yZ2VkLXRva2VuLXRoYXQtdW5sb2Nrcy10aGUtYWNjb3VudA';
    expect(fingerprintToken(raw)).toBe(`Zm9yZ2…(${raw.length} chars)`);
  });
});
