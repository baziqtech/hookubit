import { MemberRole } from '@prisma/client';

/**
 * The permission matrix (ARCHITECTURE.md 10).
 *
 * This is THE source of truth for both axes. `Permission` is derived from the
 * keys and `MemberRole` comes from the Prisma schema, so the table cannot drift
 * from either:
 *
 * - Adding a permission means adding a row here; there is no separate list to
 *   forget, because the type does not exist until the row does.
 * - Adding a role to `enum MemberRole` in schema.prisma makes every row here
 *   fail the `satisfies Record<string, Record<MemberRole, boolean>>` check, so
 *   the compiler names the incomplete rows instead of silently denying.
 *
 * The failure mode this shape exists to prevent is the opposite one: a mapping
 * that quietly returns "no permission" for something it was never told about.
 * A missing grant must be a build failure, not a 403 discovered in production.
 *
 * Read the table as a grid. Deliberate calls:
 *
 * - `developer` cannot create or delete projects (`projects.write`) or change
 *   the team (`members.write`); it owns everything inside a project instead.
 * - `developer` CAN manage API keys, because issuing an ingest key is the
 *   integration work developers are hired to do. It is the one credential-shaped
 *   grant they hold, and every issue is auditable.
 * - `viewer` cannot read API keys. A key row leaks only name/prefix, never the
 *   secret, but the inventory of live credentials is not read-only-user data.
 * - `viewer` cannot replay. Replay re-sends real traffic to a customer's
 *   endpoint; it is a write with side effects outside this system.
 * - `billing` is deliberately narrow: money, seats, and enough project
 *   visibility to understand a usage line. It sees no events and no deliveries.
 * - `admin` may not do `billing.write`. Payment instruments belong to the owner
 *   and the billing contact.
 */
const GRANTS = {
  //                       owner  admin  developer viewer billing
  'projects.read':      { owner: true,  admin: true,  developer: true,  viewer: true,  billing: true  },
  'projects.write':     { owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'endpoints.read':     { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'endpoints.write':    { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'subscriptions.read': { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'subscriptions.write':{ owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'api-keys.read':      { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },
  'api-keys.write':     { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'events.read':        { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'events.replay':      { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'deliveries.read':    { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'deliveries.replay':  { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'members.read':       { owner: true,  admin: true,  developer: true,  viewer: true,  billing: true  },
  'members.write':      { owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'billing.read':       { owner: true,  admin: true,  developer: false, viewer: false, billing: true  },
  'billing.write':      { owner: true,  admin: false, developer: false, viewer: false, billing: true  },
} as const satisfies Record<string, Record<MemberRole, boolean>>;

export type Permission = keyof typeof GRANTS;

/** Every permission, in declaration order. Iteration order is stable. */
export const PERMISSIONS: readonly Permission[] = Object.keys(GRANTS) as Permission[];

export const MEMBER_ROLES: readonly MemberRole[] = [
  'owner',
  'admin',
  'developer',
  'viewer',
  'billing',
];

function buildRolePermissions(): Readonly<Record<MemberRole, ReadonlySet<Permission>>> {
  const table = {} as Record<MemberRole, Set<Permission>>;
  for (const role of MEMBER_ROLES) table[role] = new Set<Permission>();
  for (const permission of PERMISSIONS) {
    for (const role of MEMBER_ROLES) {
      if (GRANTS[permission][role]) table[role].add(permission);
    }
  }
  return table;
}

/** role -> the permissions it grants. Frozen at module load; never mutate. */
export const ROLE_PERMISSIONS: Readonly<Record<MemberRole, ReadonlySet<Permission>>> =
  buildRolePermissions();

export function permissionsForRole(role: MemberRole): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: MemberRole, permission: Permission): boolean {
  return GRANTS[permission][role];
}

/** Runtime narrowing for values that arrived as strings (config, API key scopes). */
export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(GRANTS, value);
}

/**
 * Permissions that only read. Used by the suspension rule below.
 *
 * The `.read` suffix is the contract, not a heuristic: a permission that
 * mutates anything - `events.replay` and `deliveries.replay` included, because
 * a replay puts real HTTP traffic on a customer's endpoint - must not be named
 * `*.read`.
 */
export const READ_PERMISSIONS: ReadonlySet<Permission> = new Set(
  PERMISSIONS.filter((permission) => permission.endsWith('.read')),
);

export function isReadPermission(permission: Permission): boolean {
  return READ_PERMISSIONS.has(permission);
}

/**
 * What a member may still do while their organization or project is SUSPENDED.
 *
 * Reads, so they can see their own data and export it, plus `billing.write`,
 * because the most common reason for a suspension is an unpaid invoice and
 * locking the customer out of the payment form makes the suspension permanent.
 * Everything else - creating endpoints, replaying deliveries, inviting people -
 * is denied.
 */
export function permissionsUnderSuspension(
  granted: ReadonlySet<Permission>,
): ReadonlySet<Permission> {
  const allowed = new Set<Permission>();
  for (const permission of granted) {
    if (isReadPermission(permission) || permission === 'billing.write') allowed.add(permission);
  }
  return allowed;
}
