import { describe, expect, it } from 'vitest';
import type { Role } from '../types/api';
import { deniedReason, mayAct, roleGate } from './role-gate';

const org = (role: Role, status: 'active' | 'suspended' | 'deleted' = 'active') => ({ role, status });

describe('roleGate', () => {
  it('allows a role in the list', () => {
    const gate = roleGate(org('developer'), ['developer', 'admin', 'owner']);
    expect(gate.verdict).toBe('allowed');
    expect(mayAct(gate)).toBe(true);
    expect(deniedReason(gate, 'Doing this')).toBeUndefined();
  });

  it('denies a role outside the list and names both the requirement and the caller', () => {
    const gate = roleGate(org('viewer'), ['admin', 'owner']);
    expect(gate).toEqual({
      verdict: 'denied',
      because: 'role',
      role: 'viewer',
      required: ['admin', 'owner'],
    });
    expect(mayAct(gate)).toBe(false);
    expect(deniedReason(gate, 'Creating a project')).toBe(
      'Creating a project needs the admin or owner role. You are a viewer in this organization.',
    );
  });

  it('reads a single required role without an "or"', () => {
    expect(deniedReason(roleGate(org('admin'), ['owner']), 'Deleting this organization')).toMatch(
      /needs the owner role/,
    );
  });

  it('denies every role in a suspended organization', () => {
    const gate = roleGate(org('owner', 'suspended'), ['owner']);
    expect(gate).toEqual({ verdict: 'denied', because: 'suspended' });
    expect(deniedReason(gate, 'x')).toMatch(/suspended/);
  });

  it('does NOT block when the role is unknown — the server is the authority', () => {
    const gate = roleGate(undefined, ['owner']);
    expect(gate.verdict).toBe('unknown');
    expect(mayAct(gate)).toBe(true);
  });
});
