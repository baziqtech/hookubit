import { AppError } from '../common/errors';

/**
 * How many entries one project's publish allowlist may hold.
 *
 * The list travels on every API-key lookup in the ingest path, so it is on the
 * hot path of every published event. A few dozen egress ranges is what this is
 * for; a customer who needs hundreds wants a CIDR block, and one who genuinely
 * needs hundreds of unrelated addresses wants to talk to us.
 */
export const MAX_ALLOWED_IPS = 50;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Normalise and validate a publish allowlist.
 *
 * ## Why this refuses rather than dropping bad entries
 *
 * This is a deny-by-default control: once the list is non-empty, everything not
 * on it is refused. Silently discarding an entry that failed to parse would
 * lock out the service that entry was for, at the moment the operator believed
 * they had just permitted it — and they would find out from their own
 * customers.
 *
 * ## Why duplicates are collapsed rather than refused
 *
 * `203.0.113.4` twice is not an error, it is a paste. Collapsing keeps the
 * stored list equal to what it means, so the count shown in the UI is the
 * number of distinct things permitted.
 */
export function normaliseAllowedIps(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    assertValid(entry);
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  if (out.length > MAX_ALLOWED_IPS) {
    throw new AppError(
      'invalid_request',
      `'allowed_ips' may hold at most ${MAX_ALLOWED_IPS} entries; ${out.length} were given. ` +
        'Use a CIDR block rather than listing addresses individually.',
    );
  }
  return out;
}

function assertValid(entry: string): void {
  const [address, prefix] = splitCidr(entry);

  const version = addressVersion(address);
  if (version === null) {
    throw new AppError(
      'invalid_request',
      `'${entry}' is not an IP address or CIDR block. Entries look like '203.0.113.4', ` +
        `'203.0.113.0/24' or '2001:db8::/32'.`,
    );
  }

  if (prefix === null) return;

  // A prefix outside its family's range is the mistake that silently widens a
  // list: `203.0.113.0/0` permits the internet, and `/33` is nothing at all.
  const max = version === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) {
    throw new AppError(
      'invalid_request',
      `'${entry}' has a prefix length outside 0-${max} for an IPv${version} block.`,
    );
  }
}

function splitCidr(entry: string): [string, string | null] {
  const slash = entry.lastIndexOf('/');
  if (slash === -1) return [entry, null];
  return [entry.slice(0, slash), entry.slice(slash + 1)];
}

/** 4, 6, or null when it is neither. */
function addressVersion(address: string): 4 | 6 | null {
  const v4 = IPV4.exec(address);
  if (v4) {
    return v4.slice(1).every((octet) => octet.length <= 3 && Number(octet) <= 255) ? 4 : null;
  }
  // Deliberately permissive about IPv6 shape beyond the character set and a
  // single `::`. Go's net/netip is the authority at the point of use, and a
  // stricter parser here that disagreed with it would refuse addresses the
  // data plane would have honoured.
  if (!address.includes(':')) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return null;
  if (address.split('::').length > 2) return null;
  return 6;
}
