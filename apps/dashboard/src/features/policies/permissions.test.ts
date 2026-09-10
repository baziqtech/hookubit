import { describe, expect, it } from 'vitest';
import type { Role } from '../../types/api';
import {
  POLICY_WRITE_ROLES,
  mayWritePolicies,
  policyWriteDeniedReason,
  policyWriteGate,
} from './permissions';

const org = (role: Role, status: 'active' | 'suspended' = 'active') => ({ role, status });

/**
 * Mirrors the `policies.write` row of the permission matrix in control-api
 * `src/authz/permissions.ts`: owner, admin, developer — not viewer, not
 * billing. A drift here is a button that either fails on every press or
 * hides a recovery path from someone entitled to it.
 */
describe('policyWriteGate', () => {
  it('allows exactly owner, admin and developer', () => {
    for (const role of ['owner', 'admin', 'developer'] as const) {
      expect(policyWriteGate(org(role))).toEqual({ verdict: 'allowed' });
    }
    expect(POLICY_WRITE_ROLES).toHaveLength(3);
  });

  it('denies viewer and billing, naming the role', () => {
    for (const role of ['viewer', 'billing'] as const) {
      expect(policyWriteGate(org(role))).toEqual({ verdict: 'denied', because: 'role', role });
      expect(policyWriteDeniedReason(policyWriteGate(org(role)))).toContain(role);
    }
  });

  it('denies every role on a suspended organization', () => {
    expect(policyWriteGate(org('owner', 'suspended'))).toEqual({
      verdict: 'denied',
      because: 'suspended',
    });
  });

  it('leaves the control ENABLED when the role is not known — the server decides', () => {
    const gate = policyWriteGate(undefined);
    expect(gate).toEqual({ verdict: 'unknown' });
    expect(mayWritePolicies(gate)).toBe(true);
    expect(policyWriteDeniedReason(gate)).toBeUndefined();
  });
});
