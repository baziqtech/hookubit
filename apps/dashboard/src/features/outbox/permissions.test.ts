import { describe, expect, it } from 'vitest';
import type { Role } from '../../types/api';
import { mayRequeue, requeueDeniedReason, requeueGate } from './permissions';

const org = (role: Role, status: 'active' | 'suspended' | 'deleted' = 'active') => ({ role, status });

/**
 * Mirrors the role matrix in control-api `src/authz/permissions.ts`:
 * `events.replay` and `deliveries.replay` are both granted to owner, admin
 * and developer, and to nobody else. Both requeue routes require both.
 */
describe('requeueGate', () => {
  it('allows the three roles that hold events.replay AND deliveries.replay', () => {
    for (const role of ['owner', 'admin', 'developer'] as const) {
      const gate = requeueGate(org(role));
      expect(gate.verdict).toBe('allowed');
      expect(mayRequeue(gate)).toBe(true);
      expect(requeueDeniedReason(gate)).toBeUndefined();
    }
  });

  it('denies a viewer, who may watch an incident but not act on it, and says why', () => {
    const gate = requeueGate(org('viewer'));
    expect(gate).toEqual({ verdict: 'denied', because: 'role', role: 'viewer' });
    expect(mayRequeue(gate)).toBe(false);
    expect(requeueDeniedReason(gate)).toMatch(/developer, admin or owner/);
    expect(requeueDeniedReason(gate)).toMatch(/You are a viewer/);
  });

  it('denies billing', () => {
    expect(mayRequeue(requeueGate(org('billing')))).toBe(false);
  });

  it('denies every role in a suspended organization', () => {
    const gate = requeueGate(org('owner', 'suspended'));
    expect(gate).toEqual({ verdict: 'denied', because: 'suspended' });
    expect(requeueDeniedReason(gate)).toMatch(/suspended/);
  });

  it('does NOT block when the role is unknown — the server is the authority', () => {
    const gate = requeueGate(undefined);
    expect(gate.verdict).toBe('unknown');
    expect(mayRequeue(gate)).toBe(true);
  });
});
