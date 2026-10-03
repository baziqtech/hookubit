import { MemberRole } from '@prisma/client';
import { AppError } from '../common/errors';
import { TenantScope } from './tenant-scope.factory';
import {
  MEMBER_ROLES,
  PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  RoleChange,
  TENANT_SCOPE_PERMISSIONS,
  assertMemberRemovalAllowed,
  assertRoleChangeAllowed,
  isPermission,
  isReadPermission,
  mayAssignRole,
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
    'endpoint-secrets.read',
    'endpoint-secrets.write',
    'subscriptions.read',
    'subscriptions.write',
    'api-keys.read',
    'api-keys.write',
    'events.read',
    'events.replay',
    'deliveries.read',
    'deliveries.replay',
    'policies.read',
    'policies.write',
    'notifications.read',
    'notifications.write',
    'members.read',
    'members.write',
    'audit.read',
    'billing.read',
    'billing.write',
  ],
  admin: [
    'projects.read',
    'projects.write',
    'endpoints.read',
    'endpoints.write',
    'endpoint-secrets.read',
    'endpoint-secrets.write',
    'subscriptions.read',
    'subscriptions.write',
    'api-keys.read',
    'api-keys.write',
    'events.read',
    'events.replay',
    'deliveries.read',
    'deliveries.replay',
    'policies.read',
    'policies.write',
    'notifications.read',
    'notifications.write',
    'members.read',
    'members.write',
    'audit.read',
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
    'policies.read',
    'policies.write',
    'notifications.read',
    'notifications.write',
    'members.read',
  ],
  viewer: [
    'projects.read',
    'endpoints.read',
    'subscriptions.read',
    'events.read',
    'deliveries.read',
    'policies.read',
    'notifications.read',
    'members.read',
  ],
  billing: ['projects.read', 'members.read', 'billing.read', 'billing.write'],
};

const sorted = (values: Iterable<Permission>): Permission[] => [...values].sort();

/** Throws or fails; returns the error so the caller can assert on it. */
function expectAppError(run: () => void, code: string): AppError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected the call to throw ${code}, but it returned`);
}

describe('permission matrix', () => {
  it.each(MEMBER_ROLES)('grants %s exactly the documented permission set', (role) => {
    expect(sorted(permissionsForRole(role))).toEqual(sorted(EXPECTED[role]));
  });

  /**
   * Against the Prisma enum, NOT against `MEMBER_ROLES`: `ROLE_PERMISSIONS` is
   * built from `MEMBER_ROLES`, so comparing the two could never fail. The
   * database enum is the only statement of "which roles exist" that this file
   * does not produce itself.
   */
  it('covers every role in the Prisma MemberRole enum', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.values(MemberRole).sort());
    expect([...MEMBER_ROLES].sort()).toEqual(Object.values(MemberRole).sort());
  });

  it('raises a named authorization error, not a TypeError, for a role it never heard of', () => {
    const error = expectAppError(
      () => permissionsForRole('superuser' as MemberRole),
      'internal_error',
    );
    expect(error.message).toContain('permission matrix');
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

  it('keeps HMAC signing secrets to owner and admin, above the API key inventory', () => {
    for (const role of ['developer', 'viewer', 'billing'] as const) {
      expect(roleHasPermission(role, 'endpoint-secrets.read')).toBe(false);
      expect(roleHasPermission(role, 'endpoint-secrets.write')).toBe(false);
    }
    expect(roleHasPermission('admin', 'endpoint-secrets.read')).toBe(true);
    // The point of the separate permission: reading the endpoint does not read
    // the secret that signs its traffic.
    expect(roleHasPermission('viewer', 'endpoints.read')).toBe(true);
  });

  it('keeps the audit log - other members, their IPs and user agents - to owner and admin', () => {
    expect(roleHasPermission('owner', 'audit.read')).toBe(true);
    expect(roleHasPermission('admin', 'audit.read')).toBe(true);
    expect(roleHasPermission('developer', 'audit.read')).toBe(false);
    expect(roleHasPermission('viewer', 'audit.read')).toBe(false);
    expect(roleHasPermission('billing', 'audit.read')).toBe(false);
  });

  it('lets a developer tune retry and rate-limit policies but not a viewer', () => {
    expect(roleHasPermission('developer', 'policies.write')).toBe(true);
    expect(roleHasPermission('viewer', 'policies.read')).toBe(true);
    expect(roleHasPermission('viewer', 'policies.write')).toBe(false);
    expect(roleHasPermission('billing', 'policies.read')).toBe(false);
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

  it('exposes exactly the declared permission list', () => {
    expect([...PERMISSIONS].sort()).toEqual(
      [
        'api-keys.read',
        'api-keys.write',
        'audit.read',
        'billing.read',
        'billing.write',
        'deliveries.read',
        'deliveries.replay',
        'endpoint-secrets.read',
        'endpoint-secrets.write',
        'endpoints.read',
        'endpoints.write',
        'events.read',
        'events.replay',
        'members.read',
        'members.write',
        'notifications.read',
        'notifications.write',
        'policies.read',
        'policies.write',
        'projects.read',
        'projects.write',
        'subscriptions.read',
        'subscriptions.write',
      ].sort(),
    );
  });
});

/**
 * The grant sets are shared, process-wide objects. `ReadonlySet` is erased at
 * runtime, so one `as Set<Permission>` in any of fourteen modules would have
 * granted the added permission to every user of that role until the process
 * restarted.
 */
describe('permission sets cannot be widened at runtime', () => {
  it('freezes the role table', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
  });

  it('has no add/delete to cast to, so the escalation throws instead of succeeding', () => {
    const granted = permissionsForRole('viewer') as unknown as Set<Permission>;
    expect(typeof granted.add).toBe('undefined');
    expect(() => granted.add('billing.write')).toThrow(TypeError);
    expect(Object.isFrozen(granted)).toBe(true);
    expect(permissionsForRole('viewer').has('billing.write')).toBe(false);
  });

  it('protects the narrowed set a suspended request runs on too', () => {
    const suspended = permissionsUnderSuspension(
      permissionsForRole('owner'),
    ) as unknown as Set<Permission>;
    expect(() => suspended.add('endpoints.write')).toThrow(TypeError);
  });
});

/**
 * `members.write` alone is a self-service promotion: admin sets its own row to
 * `owner`, and holds `billing.write` one request later. The matrix's denial is
 * only real because of these rules.
 */
describe('role lattice', () => {
  const change = (over: Partial<RoleChange>): RoleChange => ({
    actorRole: 'admin',
    actorMembershipId: 'mem_actor',
    targetMembershipId: 'mem_target',
    currentRole: 'developer',
    nextRole: 'developer',
    ownerCount: 2,
    ...over,
  });

  it('ranks owner above admin above developer above viewer/billing', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.developer);
    expect(ROLE_RANK.developer).toBeGreaterThan(ROLE_RANK.viewer);
    expect(ROLE_RANK.viewer).toBe(ROLE_RANK.billing);
  });

  it('THE ESCALATION: an admin cannot promote anyone to owner', () => {
    expect(mayAssignRole('admin', 'owner')).toBe(false);
    expectAppError(
      () => assertRoleChangeAllowed(change({ nextRole: 'owner' })),
      'forbidden',
    );
  });

  it('THE ESCALATION: an admin cannot promote ITSELF, even to a role it holds', () => {
    const error = expectAppError(
      () =>
        assertRoleChangeAllowed(
          change({ targetMembershipId: 'mem_actor', currentRole: 'admin', nextRole: 'owner' }),
        ),
      'forbidden',
    );
    expect(error.message).toContain('your own role');
  });

  it('closes the loop: the promotion it is denied would have carried billing.write', () => {
    expect(roleHasPermission('admin', 'billing.write')).toBe(false);
    expect(roleHasPermission('owner', 'billing.write')).toBe(true);
    expect(mayAssignRole('admin', 'owner')).toBe(false);
  });

  it('will not let a role below the target demote it', () => {
    expect(
      expectAppError(
        () => assertRoleChangeAllowed(change({ currentRole: 'owner', nextRole: 'viewer' })),
        'forbidden',
      ).message,
    ).toContain('owner');
  });

  it('lets an admin delegate at or below its own rank', () => {
    expect(mayAssignRole('admin', 'admin')).toBe(true);
    expect(mayAssignRole('admin', 'developer')).toBe(true);
    expect(() => assertRoleChangeAllowed(change({ nextRole: 'admin' }))).not.toThrow();
  });

  it('lets an owner assign any role, including another owner', () => {
    for (const role of MEMBER_ROLES) expect(mayAssignRole('owner', role)).toBe(true);
    expect(() =>
      assertRoleChangeAllowed(change({ actorRole: 'owner', nextRole: 'owner' })),
    ).not.toThrow();
  });

  it('refuses every role change to a role without members.write', () => {
    for (const role of ['developer', 'viewer', 'billing'] as const) {
      expect(mayAssignRole(role, 'viewer')).toBe(false);
      expectAppError(() => assertRoleChangeAllowed(change({ actorRole: role })), 'forbidden');
    }
  });

  it('refuses to demote the last owner, which would strand the organization', () => {
    expectAppError(
      () =>
        assertRoleChangeAllowed(
          change({ actorRole: 'owner', currentRole: 'owner', nextRole: 'admin', ownerCount: 1 }),
        ),
      'conflict',
    );
    expect(() =>
      assertRoleChangeAllowed(
        change({ actorRole: 'owner', currentRole: 'owner', nextRole: 'admin', ownerCount: 2 }),
      ),
    ).not.toThrow();
  });

  it('refuses to remove the last owner and refuses self-removal', () => {
    const removal = {
      actorRole: 'owner' as const,
      actorMembershipId: 'mem_actor',
      targetMembershipId: 'mem_target',
      currentRole: 'owner' as const,
      ownerCount: 1,
    };
    expectAppError(() => assertMemberRemovalAllowed(removal), 'conflict');
    expectAppError(
      () => assertMemberRemovalAllowed({ ...removal, targetMembershipId: 'mem_actor' }),
      'forbidden',
    );
    expectAppError(
      () => assertMemberRemovalAllowed({ ...removal, actorRole: 'admin', ownerCount: 3 }),
      'forbidden',
    );
  });
});

/**
 * The compiler says nothing about a resource nobody named, so the author of the
 * next module reuses the nearest plausible permission - over-broad by
 * construction. This fails the build instead.
 */
describe('every tenant-owned resource is gated by a declared permission', () => {
  const SCALAR_ACCESSORS = new Set(['organizationId', 'projectId']);

  const accessors = Object.entries(
    Object.getOwnPropertyDescriptors(TenantScope.prototype),
  )
    .filter(([name, descriptor]) => typeof descriptor.get === 'function' && !SCALAR_ACCESSORS.has(name))
    .map(([name]) => name);

  it('finds the TenantScope accessors it is meant to be checking', () => {
    expect(accessors.length).toBeGreaterThan(10);
    expect(accessors).toContain('endpointSecrets');
    expect(accessors).toContain('auditLogs');
  });

  it.each(accessors)('maps TenantScope.%s to at least one declared permission', (accessor) => {
    const permissions = TENANT_SCOPE_PERMISSIONS[accessor];
    expect(permissions).toBeDefined();
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) expect(isPermission(permission)).toBe(true);
  });

  it('maps nothing that TenantScope does not expose', () => {
    expect(Object.keys(TENANT_SCOPE_PERMISSIONS).sort()).toEqual([...accessors].sort());
  });

  it('does not let endpoint secrets ride along on endpoints.read', () => {
    expect(TENANT_SCOPE_PERMISSIONS.endpointSecrets).toEqual(['endpoint-secrets.read']);
    expect(TENANT_SCOPE_PERMISSIONS.auditLogs).toEqual(['audit.read']);
  });
});
