import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERLAP_SECONDS } from '../../types/api';
import {
  MAX_OVERLAP_SECONDS,
  describeOverlap,
  describeSeconds,
  isDefaultOverlap,
  mayManageSecrets,
  rejectOverlapSeconds,
  secretCondition,
  wouldBeLastActive,
} from './secrets';

/**
 * Rotation is the operation where a wrong word is an outage: telling an
 * operator that an overlap of zero "rotates the secret" without saying that
 * every unswitched consumer starts rejecting deliveries is how a routine
 * rotation becomes an incident. These pin the copy that prevents it.
 */
describe('describeOverlap', () => {
  it('states that zero overlap stops the old secrets NOW, and names it as the leak case', () => {
    const { headline, detail } = describeOverlap(0);
    expect(headline).toMatch(/immediately/);
    expect(detail).toMatch(/reject every delivery/);
    expect(detail).toMatch(/leaked/);
    expect(detail).toMatch(/not for a routine rotation/);
  });

  it('states the window and that consumers can roll without dropping a delivery', () => {
    const { headline, detail } = describeOverlap(DEFAULT_OVERLAP_SECONDS);
    expect(headline).toContain('1 day');
    expect(detail).toMatch(/one signature per active secret/);
    expect(detail).toMatch(/without dropping a delivery/);
  });

  it('never describes the two cases with the same headline', () => {
    expect(describeOverlap(0).headline).not.toBe(describeOverlap(3600).headline);
  });
});

describe('describeSeconds', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(describeSeconds(86_400)).toBe('1 day');
    expect(describeSeconds(MAX_OVERLAP_SECONDS)).toBe('30 days');
    expect(describeSeconds(3_600)).toBe('1 hour');
    expect(describeSeconds(5_400)).toBe('90 minutes');
    expect(describeSeconds(45)).toBe('45 seconds');
    expect(describeSeconds(0)).toBe('no time at all');
  });
});

describe('rejectOverlapSeconds', () => {
  /** Mirrors `@IsInt() @Min(0) @Max(2592000)` on `RotateSecretDto`. */
  it('accepts the whole legal range, endpoints included', () => {
    expect(rejectOverlapSeconds(0)).toBeNull();
    expect(rejectOverlapSeconds(DEFAULT_OVERLAP_SECONDS)).toBeNull();
    expect(rejectOverlapSeconds(MAX_OVERLAP_SECONDS)).toBeNull();
  });

  it('refuses what the server would refuse, in its words', () => {
    expect(rejectOverlapSeconds(-1)).toBe('must not be less than 0');
    expect(rejectOverlapSeconds(MAX_OVERLAP_SECONDS + 1)).toBe(
      `must not be greater than ${MAX_OVERLAP_SECONDS}`,
    );
    expect(rejectOverlapSeconds(1.5)).toBe('must be an integer number');
    expect(rejectOverlapSeconds(Number.NaN)).toBe('must be an integer number');
  });

  it('knows the server default so the hint can say so', () => {
    expect(isDefaultOverlap(86_400)).toBe(true);
    expect(isDefaultOverlap(3_600)).toBe(false);
  });
});

describe('secretCondition', () => {
  it('reads the server-derived active flag rather than the clock', () => {
    expect(secretCondition({ active: true, expires_at: null })).toBe('signing');
    expect(secretCondition({ active: true, expires_at: '2099-01-01T00:00:00Z' })).toBe('expiring');
    // Expired or revoked: the API already folded the expiry into `active`.
    expect(secretCondition({ active: false, expires_at: '2000-01-01T00:00:00Z' })).toBe('retired');
    expect(secretCondition({ active: false, expires_at: null })).toBe('retired');
  });
});

describe('mayManageSecrets', () => {
  /** `endpoint-secrets.*` is owner and admin ONLY in the permission matrix. */
  it('allows owner and admin, and nobody else', () => {
    expect(mayManageSecrets('owner')).toBe(true);
    expect(mayManageSecrets('admin')).toBe(true);
    expect(mayManageSecrets('developer')).toBe(false);
    expect(mayManageSecrets('viewer')).toBe(false);
    expect(mayManageSecrets('billing')).toBe(false);
  });

  it('does not block when the role is unknown — the server is the authority', () => {
    expect(mayManageSecrets(undefined)).toBe(true);
  });
});

describe('wouldBeLastActive', () => {
  const rows = [
    { id: 'a', active: true },
    { id: 'b', active: false },
  ];

  it('says so when the page is complete and no other secret signs', () => {
    expect(wouldBeLastActive(rows[0], { rows, hasMore: false }, 'active')).toBe(true);
  });

  it('is false when another active secret survives, or the target is already retired', () => {
    const two = [...rows, { id: 'c', active: true }];
    expect(wouldBeLastActive(two[0], { rows: two, hasMore: false }, 'active')).toBe(false);
    expect(wouldBeLastActive(rows[1], { rows, hasMore: false }, 'active')).toBe(false);
  });

  it('is false on a deleted endpoint, which the server exempts from the rule', () => {
    expect(wouldBeLastActive(rows[0], { rows, hasMore: false }, 'deleted')).toBe(false);
  });

  it('refuses to guess from a partial page', () => {
    expect(wouldBeLastActive(rows[0], { rows, hasMore: true }, 'active')).toBeNull();
  });
});
