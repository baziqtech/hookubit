import { MemberRole } from '@prisma/client';
import {
  MEMBER_ROLES,
  PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  isPermission,
  isReadPermission,
  permissionsForRole,
  permissionsUnderSuspension,
  roleHasPermission,
} from './permissions';

/**
 * The expected grant for every role, written out longhand.
 *
 * Deliberately NOT derived from the same table the implementation uses - a test
 * that recomputed the matrix would pass for any matrix. This is the second,
 * independent statement of the intent, so a change to `permissions.ts` that
 * nobody meant fails here and has to be argued for.
 */
const EXPECTED: Record<MemberRole, Permission[]> = {
  owner: [
    'projects.read',
    'projects.write',
    'endpoints.read',
    'endpoints.write',
    'subscriptions.read',
    'subscriptions.write',
    'api-keys.read',
    'api-keys.write',
    'events.read',
    'events.replay',
    'deliveries.read',
    'deliveries.replay',
    'members.read',
    'members.write',
    'billing.read',
    'billing.write',
  ],
  admin: [
    'projects.read',
    'projects.write',
    'endpoints.read',
    'endpoints.write',
    'subscriptions.read',
    'subscriptions.write',
    'api-keys.read',
    'api-keys.write',
    'events.read',
    'events.replay',
    'deliveries.read',
    'deliveries.replay',
    'members.read',
    'members.write',
    'billing.read',
  ],
  developer: [
    'projects.read',
    'endpoints.read',
    'endpoints.write',
    'subscriptions.read',
    'subscriptions.write',
    'api-keys.read',
    'api-keys.write',
    'events.read',
    'events.replay',
    'deliveries.read',
    'deliveries.replay',
    'members.read',
  ],
  viewer: [
    'projects.read',
    'endpoints.read',
    'subscriptions.read',
    'events.read',
    'deliveries.read',
    'members.read',
  ],
  billing: ['projects.read', 'members.read', 'billing.read', 'billing.write'],
};

const sorted = (values: Iterable<Permission>): Permission[] => [...values].sort();

describe('permission matrix', () => {
  it.each(MEMBER_ROLES)('grants %s exactly the documented permission set', (role) => {
    expect(sorted(permissionsForRole(role))).toEqual(sorted(EXPECTED[role]));
  });

  it('covers every declared role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...MEMBER_ROLES].sort());
  });

  it('gives owner every permission - owner is the escape hatch of last resort', () => {
    expect(sorted(permissionsForRole('owner'))).toEqual(sorted(PERMISSIONS));
  });

  it('withholds billing.write from admin, so payment details stay with owner and billing', () => {
    expect(roleHasPermission('admin', 'billing.write')).toBe(false);
    expect(roleHasPermission('owner', 'billing.write')).toBe(true);
    expect(roleHasPermission('billing', 'billing.write')).toBe(true);
  });

  it('withholds members.write from developer - role escalation is an admin action', () => {
    expect(roleHasPermission('developer', 'members.write')).toBe(false);
    expect(roleHasPermission('developer', 'members.read')).toBe(true);
  });

  it('gives viewer no write and no replay anywhere', () => {
    for (const permission of permissionsForRole('viewer')) {
      expect(permission.endsWith('.read')).toBe(true);
    }
  });

  it('keeps API key inventory away from viewer and billing', () => {
    expect(roleHasPermission('viewer', 'api-keys.read')).toBe(false);
    expect(roleHasPermission('billing', 'api-keys.read')).toBe(false);
    expect(roleHasPermission('developer', 'api-keys.read')).toBe(true);
  });

  it('keeps event and delivery data away from the billing role', () => {
    expect(roleHasPermission('billing', 'events.read')).toBe(false);
    expect(roleHasPermission('billing', 'deliveries.read')).toBe(false);
  });

  it('treats replay as a write, because it puts real traffic on a customer endpoint', () => {
    expect(isReadPermission('events.replay')).toBe(false);
    expect(isReadPermission('deliveries.replay')).toBe(false);
    expect(isReadPermission('deliveries.read')).toBe(true);
  });

  it('narrows a suspended tenant to reads plus billing.write', () => {
    const suspended = permissionsUnderSuspension(permissionsForRole('owner'));
    expect(suspended.has('billing.write')).toBe(true);
    expect(suspended.has('projects.read')).toBe(true);
    expect(suspended.has('endpoints.write')).toBe(false);
    expect(suspended.has('deliveries.replay')).toBe(false);
    expect(suspended.has('members.write')).toBe(false);
  });

  it('cannot widen a role under suspension', () => {
    const granted = permissionsForRole('viewer');
    for (const permission of permissionsUnderSuspension(granted)) {
      expect(granted.has(permission)).toBe(true);
    }
  });

  it('narrows a role that never had billing.write without inventing it', () => {
    expect(permissionsUnderSuspension(permissionsForRole('developer')).has('billing.write')).toBe(
      false,
    );
  });

  it('recognises only declared permissions at runtime', () => {
    expect(isPermission('endpoints.write')).toBe(true);
    expect(isPermission('endpoints.delete')).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
    expect(isPermission('constructor')).toBe(false);
  });

  it('exposes every ARCHITECTURE.md section 10 permission plus the four the module list implies', () => {
    expect([...PERMISSIONS].sort()).toEqual(
      [
        'api-keys.read',
        'api-keys.write',
        'billing.read',
        'billing.write',
        'deliveries.read',
        'deliveries.replay',
        'endpoints.read',
        'endpoints.write',
        'events.read',
        'events.replay',
        'members.read',
        'members.write',
        'projects.read',
        'projects.write',
        'subscriptions.read',
        'subscriptions.write',
      ].sort(),
    );
  });
});
