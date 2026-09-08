import { isIP } from 'node:net';

/**
 * A USABILITY MIRROR of `services/data-plane/internal/egress/ssrf.go`.
 *
 * ## Read this before changing anything here
 *
 * **The Go guard is the authority and this file is not.** `egress.Guard.CheckIP`
 * runs as `net.Dialer.Control`, after DNS resolution and immediately before
 * connect, on the concrete address the socket is about to use. That placement is
 * the entire security argument: it is the only point at which DNS rebinding
 * loses, because a name that resolved publicly when it was saved cannot smuggle
 * a private address past a check that runs on the address actually dialled. Nine
 * tenths of what customers type here is a hostname, and a hostname cannot be
 * judged at all at save time.
 *
 * So what is this for? A customer who saves `http://localhost:3000/hook` today
 * is told nothing, and then accumulates a delivery log full of
 * `egress blocked: loopback address` a day later - if they ever look. Telling
 * them at the moment they press Save is worth doing, and it is worth doing
 * *only* for the cases that are decidable without resolving anything: the
 * scheme, credentials in the URL, and a literal IP that is already unroutable
 * from the platform.
 *
 * **Nothing may be removed from the Go guard because it also exists here.**
 * This check is a strict subset by construction, it runs on a different host at
 * a different time, and it cannot see what a name resolves to. Deleting the dial
 * time check would turn every hostname in the database into an open SSRF.
 *
 * Ranges and rejection wording deliberately track ssrf.go so an operator reading
 * a 400 here and a delivery error there sees the same words.
 */

/** Longest URL we will store. Well under any proxy or PostgreSQL limit. */
export const MAX_URL_LENGTH = 2048;

const METADATA_LITERALS: readonly string[] = [
  '169.254.169.254', // AWS / GCP / Azure / DigitalOcean
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv2 over IPv6
];

/**
 * RFC 6761 reserves `localhost` and every name under it, and requires resolvers
 * to answer with a loopback address. It is decidable without DNS, and it is by
 * far the most common thing a developer pastes in by mistake.
 */
function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

function ipv4Bytes(text: string): number[] | null {
  if (isIP(text) !== 4) return null;
  return text.split('.').map((part) => Number(part));
}

/**
 * Expands an IPv6 literal to its sixteen bytes, including the `::` run and a
 * dotted-quad tail (`::ffff:127.0.0.1`). `isIP` has already accepted the shape;
 * this only has to take it apart.
 */
function ipv6Bytes(literal: string): number[] | null {
  if (isIP(literal) !== 6) return null;
  let text = literal;

  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A dotted-quad tail becomes the two hextets it encodes, so the rest of this
  // function only has to deal with hex groups.
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const embedded = ipv4Bytes(text.slice(colon + 1));
    if (!embedded) return null;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    text = `${text.slice(0, colon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups = [
    ...head,
    ...new Array<string>(8 - head.length - tail.length).fill('0'),
    ...tail,
  ];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 literal, mirroring Go's
 * `net.IP.To4`: `::ffff:a.b.c.d` only. `::1` stays an IPv6 loopback and is
 * caught as one.
 */
function mappedIpv4(bytes: readonly number[]): number[] | null {
  if (bytes.length !== 16) return null;
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? [...bytes.slice(12)] : null;
}

/**
 * The IPv4 destination carried inside an IPv6 transition address, mirroring
 * `embeddedIPv4` in ssrf.go. `http://[64:ff9b::a9fe:a9fe]/` is a request to
 * 169.254.169.254 wearing a disguise, and the network will unwrap it for us, so
 * the address that traffic actually reaches is the one to judge.
 */
function transitionIpv4(bytes: readonly number[]): number[] | null {
  if (bytes.length !== 16 || mappedIpv4(bytes)) return null;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return [...bytes.slice(2, 6)]; // 2002::/16, 6to4
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return [...bytes.slice(12)]; // 64:ff9b::/96, NAT64
  }
  return null;
}

function classifyIpv4(b: readonly number[]): string | null {
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0) return 'unspecified address';
  if (b[0] === 127) return 'loopback address';
  if (b[0] === 169 && b[1] === 254) return 'link-local address';
  if (b[0] >= 224 && b[0] <= 239) return 'multicast address';
  if (b[0] === 10) return 'private address';
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return 'private address';
  if (b[0] === 192 && b[1] === 168) return 'private address';
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return 'carrier-grade NAT range (100.64.0.0/10)';
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (
    (b[0] === 192 && b[1] === 0 && b[2] === 2) ||
    (b[0] === 198 && b[1] === 51 && b[2] === 100) ||
    (b[0] === 203 && b[1] === 0 && b[2] === 113)
  ) {
    return 'documentation range';
  }
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return 'benchmarking range (198.18.0.0/15)';
  if (b[0] >= 240) return 'reserved range (240.0.0.0/4)';
  return null;
}

function classifyIpv6(b: readonly number[]): string | null {
  if (b.every((byte) => byte === 0)) return 'unspecified address';
  if (b.slice(0, 15).every((byte) => byte === 0) && b[15] === 1) return 'loopback address';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local address';
  if (b[0] === 0xff && (b[1] & 0x0f) === 0x02) return 'link-local address';
  if (b[0] === 0xff) return 'multicast address';
  if ((b[0] & 0xfe) === 0xfc) return 'private address';
  if (
    b[0] === 0x01 &&
    b[1] === 0x00 &&
    b.slice(2, 8).every((byte) => byte === 0)
  ) {
    return 'IPv6 discard prefix (100::/64)';
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) {
    return 'IPv6 documentation range (2001:db8::/32)';
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 0x01) {
    return 'IPv6 special-purpose range (2001::/23)';
  }
  return null;
}

function sameAddress(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Metadata services hold credentials, so they are named first and separately -
 * the same ordering ssrf.go uses. Every one of them is also caught by a range
 * check below, but "cloud instance metadata address" is the sentence that tells
 * a customer what they actually typed.
 */
function metadataReason(bytes: readonly number[]): string | null {
  for (const literal of METADATA_LITERALS) {
    const candidate = ipv4Bytes(literal) ?? ipv6Bytes(literal);
    if (candidate && sameAddress(bytes, candidate)) return 'cloud instance metadata address';
  }
  return null;
}

/** Why a literal address is unreachable from the platform, or null if it is fine. */
function classifyLiteral(host: string): string | null {
  const v4 = ipv4Bytes(host);
  if (v4) return metadataReason(v4) ?? classifyIpv4(v4);

  const v6 = ipv6Bytes(host);
  if (!v6) return null;

  const metadata = metadataReason(v6);
  if (metadata) return metadata;

  const mapped = mappedIpv4(v6);
  if (mapped) return metadataReason(mapped) ?? classifyIpv4(mapped);

  const transition = transitionIpv4(v6);
  if (transition) {
    const reason = metadataReason(transition) ?? classifyIpv4(transition);
    if (reason) return `transition address embedding ${transition.join('.')} (${reason})`;
  }
  return classifyIpv6(v6);
}

/**
 * Returns a human-readable reason the URL is unusable, or null if it passes.
 *
 * Passing here is NOT a promise that a delivery will be attempted: the dial-time
 * guard still runs, and a hostname that resolves into private space is refused
 * there. See the file docblock.
 */

/**
 * Egress policy, read from the SAME two variables the Go guard reads.
 *
 * Without this the two halves disagree in a way that makes a documented feature
 * unusable: an operator who sets EGRESS_PRIVATE_ALLOWLIST=10.0.0.0/8 to deliver
 * to consumers on their own network - which the deployment docs recommend as the
 * production-safe alternative to allowing all private traffic - could not CREATE
 * such an endpoint, because this validator refused it unconditionally. It also
 * made local development impossible: nobody could point an endpoint at their own
 * machine to see a delivery arrive.
 *
 * The Go guard at dial time remains the authority. This is the usability mirror,
 * and a mirror that disagrees with the thing it reflects is worse than no mirror.
 */
export interface EgressPolicy {
  allowPrivateNetworks: boolean;
  privateAllowlist: readonly string[];
}

export function egressPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  return {
    allowPrivateNetworks: env.EGRESS_ALLOW_PRIVATE_NETWORKS === 'true',
    privateAllowlist: (env.EGRESS_PRIVATE_ALLOWLIST ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
}

/** Whether an IPv4 literal falls inside a CIDR from the allowlist. */
function withinCidr(bytes: readonly number[], cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  // A default route is not an allowlist; the Go guard rejects it outright and
  // so does this.
  if (prefix === 0) return false;
  const net = ipv4Bytes(network);
  if (!net || bytes.length !== 4) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const toInt = (b: readonly number[]) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return (toInt(bytes) & mask) === (toInt(net) & mask);
}

function permittedByPolicy(host: string, policy: EgressPolicy): boolean {
  const v4 = ipv4Bytes(host);
  // Metadata addresses are refused unconditionally, allowlist or not. This is
  // the ordering bug that was found and fixed in the Go guard; reintroducing it
  // here would let an operator who allowlists 169.254.0.0/16 hand every tenant
  // a route to instance credentials.
  if (v4 && metadataReason(v4)) return false;
  if (policy.allowPrivateNetworks) return true;
  if (!v4) return false;
  return policy.privateAllowlist.some((cidr) => withinCidr(v4, cidr));
}

export function rejectEndpointUrl(
  raw: unknown,
  policy: EgressPolicy = egressPolicyFromEnv(),
): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'a URL is required';
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) return `URL is longer than ${MAX_URL_LENGTH} characters`;
  // A URL is one line by definition; a newline in it is a header-injection
  // attempt against whatever eventually writes the request.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F]/.test(text)) {
    return 'URL contains whitespace or control characters';
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'malformed URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme ${url.protocol.replace(':', '')} is not permitted; use http or https`;
  }
  // Credentials in the URL end up in delivery logs, in the operator UI and in
  // support tickets. The Go guard refuses them for the same reason.
  if (url.username || url.password) return 'credentials in URL are not permitted';

  // `URL` strips brackets from an IPv6 host only in `host`, not `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'URL has no host';
  const rejection = isLocalhostName(host) ? 'loopback address' : classifyLiteral(host);
  if (rejection === null) return null;
  // The address is non-public. Permit it only if policy says so - and resolve
  // localhost to 127.0.0.1 first, so `http://localhost:8081` is judged by the
  // same rule as the literal a developer would otherwise have to type.
  const literal = isLocalhostName(host) ? '127.0.0.1' : host;
  return permittedByPolicy(literal, policy) ? null : rejection;
}

/** The URL as it will be stored: trimmed, otherwise byte-for-byte the input. */
export function normaliseEndpointUrl(raw: string): string {
  return raw.trim();
}
