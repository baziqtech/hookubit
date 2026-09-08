import { rejectEndpointUrl } from './endpoint-url';

/**
 * These cases are lifted from `services/data-plane/internal/egress/ssrf_test.go`
 * so the two halves cannot drift apart quietly. What is asserted here is that
 * the customer is TOLD at save time; what actually stops the request is still
 * the dial-time guard, and no test here should ever be read as covering that.
 */
describe('rejectEndpointUrl - accepted', () => {
  it.each([
    'https://finance.example.com/webhooks/payments',
    'http://example.com/hook',
    'https://example.com:8443/hook?tenant=1',
    'https://8.8.8.8/hook',
    'https://[2606:4700:4700::1111]/hook',
    // A hostname that resolves privately is NOT decidable here. It is accepted
    // at save time and refused at dial time, which is the division of labour.
    'https://internal-consumer.corp/hook',
  ])('accepts %s', (url) => {
    expect(rejectEndpointUrl(url)).toBeNull();
  });
});

describe('rejectEndpointUrl - refused', () => {
  it.each([
    ['file:///etc/passwd', 'scheme file is not permitted; use http or https'],
    ['gopher://example.com/', 'scheme gopher is not permitted; use http or https'],
    ['javascript:alert(1)', 'scheme javascript is not permitted; use http or https'],
    ['https://user:pass@example.com/hook', 'credentials in URL are not permitted'],
    ['https://:token@example.com/hook', 'credentials in URL are not permitted'],
    ['notaurlatall', 'malformed URL'],
    ['not a url at all', 'URL contains whitespace or control characters'],
  ])('refuses %s', (url, reason) => {
    expect(rejectEndpointUrl(url)).toBe(reason);
  });

  it.each([
    ['http://localhost:3000/hook', 'loopback address'],
    ['http://api.localhost/hook', 'loopback address'],
    ['http://127.0.0.1/hook', 'loopback address'],
    ['http://[::1]/hook', 'loopback address'],
    ['http://0.0.0.0/hook', 'unspecified address'],
    ['http://10.1.2.3/hook', 'private address'],
    ['http://172.16.0.1/hook', 'private address'],
    ['http://192.168.0.1/hook', 'private address'],
    ['http://[fc00::1]/hook', 'private address'],
    ['http://[fe80::1]/hook', 'link-local address'],
    ['http://100.64.0.1/hook', 'carrier-grade NAT range (100.64.0.0/10)'],
    ['http://198.18.0.1/hook', 'benchmarking range (198.18.0.0/15)'],
    ['http://203.0.113.5/hook', 'documentation range'],
    ['http://[2001:db8::1]/hook', 'IPv6 documentation range (2001:db8::/32)'],
    ['http://255.255.255.255/hook', 'reserved range (240.0.0.0/4)'],
  ])('refuses the private literal %s', (url, reason) => {
    expect(rejectEndpointUrl(url)).toBe(reason);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/',
    'http://[fd00:ec2::254]/',
  ])('names the metadata service in %s rather than just "link-local"', (url) => {
    expect(rejectEndpointUrl(url)).toBe('cloud instance metadata address');
  });

  /**
   * The obfuscations. Every one of these is a normal-looking URL that resolves
   * to somewhere unroutable, and each is decidable without DNS - which is
   * exactly why they belong in the save-time check rather than only at dial
   * time.
   */
  it.each([
    // WHATWG URL normalises decimal, hex and octal IPv4 forms for us.
    ['http://2130706433/hook', 'loopback address'],
    ['http://0x7f000001/hook', 'loopback address'],
    ['http://017700000001/hook', 'loopback address'],
    // IPv4-mapped IPv6.
    ['http://[::ffff:127.0.0.1]/hook', 'loopback address'],
    ['http://[::ffff:169.254.169.254]/hook', 'cloud instance metadata address'],
  ])('sees through %s', (url, reason) => {
    expect(rejectEndpointUrl(url)).toBe(reason);
  });

  it('unwraps a NAT64 address pointing at the metadata service', () => {
    expect(rejectEndpointUrl('http://[64:ff9b::a9fe:a9fe]/')).toBe(
      'transition address embedding 169.254.169.254 (cloud instance metadata address)',
    );
  });

  it('unwraps a 6to4 address pointing at a private range', () => {
    expect(rejectEndpointUrl('http://[2002:0a00:0001::1]/')).toBe(
      'transition address embedding 10.0.0.1 (private address)',
    );
  });

  it('refuses a URL carrying a newline, which is header injection wherever it lands', () => {
    expect(rejectEndpointUrl('https://example.com/hook\r\nX-Evil: 1')).toBe(
      'URL contains whitespace or control characters',
    );
  });

  it('refuses an over-long URL and a non-string', () => {
    expect(rejectEndpointUrl(`https://example.com/${'a'.repeat(3000)}`)).toContain(
      'longer than 2048',
    );
    expect(rejectEndpointUrl(undefined)).toBe('a URL is required');
    expect(rejectEndpointUrl(42)).toBe('a URL is required');
    expect(rejectEndpointUrl('   ')).toBe('a URL is required');
  });
});

describe('egress policy', () => {
  const closed = { allowPrivateNetworks: false, privateAllowlist: [] as string[] };

  it('blocks private and loopback targets by default', () => {
    for (const url of ['http://localhost:8081/hook', 'http://127.0.0.1/x', 'http://10.0.0.5/x']) {
      expect(rejectEndpointUrl(url, closed)).not.toBeNull();
    }
  });

  it('permits a target inside an allowlisted CIDR, matching the Go guard', () => {
    const policy = { allowPrivateNetworks: false, privateAllowlist: ['10.20.0.0/16'] };
    expect(rejectEndpointUrl('http://10.20.5.5/hook', policy)).toBeNull();
    // Allowlisting one subnet must not open the rest of RFC1918.
    expect(rejectEndpointUrl('http://10.99.5.5/hook', policy)).not.toBeNull();
  });

  it('permits loopback when private networks are allowed, so local development works', () => {
    const open = { allowPrivateNetworks: true, privateAllowlist: [] as string[] };
    expect(rejectEndpointUrl('http://localhost:8081/hook', open)).toBeNull();
    expect(rejectEndpointUrl('http://127.0.0.1:8081/hook', open)).toBeNull();
  });

  it('NEVER permits cloud metadata, whatever the policy says', () => {
    // This is the ordering bug that was found and fixed in the Go guard. An
    // operator allowlisting 169.254.0.0/16 for an internal service must not
    // thereby hand every tenant a route to instance credentials.
    for (const policy of [
      { allowPrivateNetworks: true, privateAllowlist: [] as string[] },
      { allowPrivateNetworks: false, privateAllowlist: ['169.254.0.0/16'] },
    ]) {
      expect(rejectEndpointUrl('http://169.254.169.254/latest/meta-data/', policy)).not.toBeNull();
      expect(rejectEndpointUrl('http://100.100.100.200/', policy)).not.toBeNull();
    }
  });

  it('refuses a default route as an allowlist entry', () => {
    const policy = { allowPrivateNetworks: false, privateAllowlist: ['0.0.0.0/0'] };
    expect(rejectEndpointUrl('http://10.0.0.5/hook', policy)).not.toBeNull();
  });

  it('still permits public targets', () => {
    expect(rejectEndpointUrl('https://api.example.com/hooks', closed)).toBeNull();
  });
});
