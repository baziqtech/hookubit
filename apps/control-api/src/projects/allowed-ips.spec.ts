import { AppError } from '../common/errors';
import { MAX_ALLOWED_IPS, normaliseAllowedIps } from './allowed-ips';

describe('normaliseAllowedIps', () => {
  it('accepts addresses and blocks in both families', () => {
    expect(
      normaliseAllowedIps(['203.0.113.4', '203.0.113.0/24', '2001:db8::1', '2001:db8::/32']),
    ).toEqual(['203.0.113.4', '203.0.113.0/24', '2001:db8::1', '2001:db8::/32']);
  });

  it('REFUSES a malformed entry rather than dropping it', () => {
    // Deny-by-default: silently discarding an entry would lock out the service
    // it was for, at the moment the operator believed they had permitted it —
    // and they would find out from their own customers.
    for (const bad of ['not-an-ip', '203.0.113.', '999.0.0.1', '203.0.113.0/33', '::/129']) {
      expect(() => normaliseAllowedIps([bad])).toThrow(AppError);
    }
  });

  it('names the entry it refused, so the fix is obvious', () => {
    try {
      normaliseAllowedIps(['203.0.113.4', 'oops']);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).message).toContain("'oops'");
    }
  });

  it('collapses duplicates, because twice is a paste and not an error', () => {
    expect(normaliseAllowedIps(['203.0.113.4', '203.0.113.4'])).toEqual(['203.0.113.4']);
  });

  it('ignores blank entries, which is what an empty row in a form is', () => {
    expect(normaliseAllowedIps(['', '  ', '203.0.113.4'])).toEqual(['203.0.113.4']);
  });

  it('refuses more entries than the ceiling and says to use a block', () => {
    const many = Array.from({ length: MAX_ALLOWED_IPS + 1 }, (_, i) => `203.0.${i}.1`);
    expect(() => normaliseAllowedIps(many)).toThrow(/CIDR block/);
  });

  it('keeps /0 valid, because permitting everything is a thing people mean', () => {
    // It is the same as an empty list, and refusing it would be us deciding a
    // customer cannot say explicitly what they can say by omission.
    expect(normaliseAllowedIps(['0.0.0.0/0'])).toEqual(['0.0.0.0/0']);
  });
});
