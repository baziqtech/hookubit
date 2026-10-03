/**
 * What the Secrets dialog is allowed to say, as data.
 *
 * A signing secret is the strongest credential in the product — whoever holds
 * it can forge a webhook into the customer's own consumer — and rotation is
 * the one operation where the wrong word costs an outage rather than a
 * support ticket. So the copy that explains an overlap window, the state of a
 * version and who may see any of it lives here, testable without a DOM, and
 * the dialog renders it.
 *
 * Mirrors control-api `src/endpoint-secrets/secret-generator.ts` (the overlap
 * bounds) and `src/authz/permissions.ts` (`endpoint-secrets.*` is owner and
 * admin ONLY, and is deliberately not implied by `endpoints.read`).
 */
import type { EndpointSecret, Role } from '../../types/api';
import { DEFAULT_OVERLAP_SECONDS } from '../../types/api';

/** `endpoint-secrets.read` and `.write` — the same two roles hold both. */
export const SECRET_ROLES: readonly Role[] = ['admin', 'owner'];

/** `MIN_OVERLAP_SECONDS` / `MAX_OVERLAP_SECONDS` on the control API: 0 to 30 days. */
export const MIN_OVERLAP_SECONDS = 0;
export const MAX_OVERLAP_SECONDS = 30 * 24 * 60 * 60;

export function mayManageSecrets(role: Role | undefined): boolean {
  // Unknown is NOT denied: the server decides, and a 403 it returns is rendered
  // as `PermissionDenied`. A pre-check that is wrong costs an owner the cure.
  if (role === undefined) return true;
  return SECRET_ROLES.includes(role);
}

/**
 * The three states a version can be in, from the two fields the DTO carries.
 *
 * `active` is already "the stored flag AND the expiry has not passed", computed
 * server-side, so an expired row reads `active: false` before any sweep has
 * flipped the column. This does not re-derive it from the clock.
 */
export type SecretCondition =
  /** Signing, with no end scheduled. */
  | 'signing'
  /** Signing, until `expires_at` — the overlap window of a rotation. */
  | 'expiring'
  /** No longer signs: rotated out and expired, or revoked. */
  | 'retired';

export function secretCondition(
  secret: Pick<EndpointSecret, 'active' | 'expires_at'>,
): SecretCondition {
  if (!secret.active) return 'retired';
  return secret.expires_at ? 'expiring' : 'signing';
}

export const SECRET_CONDITION_LABEL: Record<SecretCondition, string> = {
  signing: 'signing',
  expiring: 'signing until',
  retired: 'retired',
};

/**
 * Validates `overlap_seconds` before a round trip, in the words the
 * `ValidationPipe` would use. Null means acceptable.
 */
export function rejectOverlapSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 'must be an integer number';
  }
  if (value < MIN_OVERLAP_SECONDS) return `must not be less than ${MIN_OVERLAP_SECONDS}`;
  if (value > MAX_OVERLAP_SECONDS) return `must not be greater than ${MAX_OVERLAP_SECONDS}`;
  return null;
}

/** "24 hours", "30 days", "90 minutes" — for a number of seconds a person typed. */
export function describeSeconds(seconds: number): string {
  if (seconds === 0) return 'no time at all';
  const units: Array<[number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${name}${count === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

/**
 * The consequence of an overlap window, stated before the button.
 *
 * The distinction that matters: a window lets a consumer roll without
 * dropping a delivery; ZERO makes every delivery unverifiable at a consumer
 * that has not switched yet. The second is the right choice for a leaked
 * secret and the wrong one for a routine rotation, and the copy must never
 * present them as the same operation with a different number.
 */
export function describeOverlap(seconds: number): { headline: string; detail: string } {
  if (seconds === 0) {
    return {
      headline: 'The current secrets stop signing immediately.',
      detail:
        'Only the new secret will sign from now on. A consumer that is still verifying with ' +
        'the old one will reject every delivery until it is switched. Use this for a leaked ' +
        'secret, not for a routine rotation.',
    };
  }
  return {
    headline: `The current secrets keep signing for ${describeSeconds(seconds)}, then stop.`,
    detail:
      'During that window every delivery carries one signature per active secret, and a ' +
      'consumer verifying with either one succeeds — so the consumer can be switched to the ' +
      'new secret without dropping a delivery. Switch it before the window closes.',
  };
}

/** True when the value is the server's own default and the hint can say so. */
export function isDefaultOverlap(seconds: number): boolean {
  return seconds === DEFAULT_OVERLAP_SECONDS;
}

/**
 * Whether revoking this one secret would be refused by the server.
 *
 * `null` when it cannot be known from what the page has — the list is paged,
 * and a page that is not the whole list does not carry the count. The server
 * answers 409 either way; this only lets the dialog say so BEFORE the click.
 */
export function wouldBeLastActive(
  target: Pick<EndpointSecret, 'id' | 'active'>,
  page: { rows: Pick<EndpointSecret, 'id' | 'active'>[]; hasMore: boolean },
  endpointStatus: string,
): boolean | null {
  if (!target.active) return false;
  if (endpointStatus === 'deleted') return false;
  if (page.hasMore) return null;
  return !page.rows.some((secret) => secret.id !== target.id && secret.active);
}
