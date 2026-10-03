import { MemberRole } from '@prisma/client';
import { AppError } from '../common/errors';

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
 *   and the billing contact. That denial is only real because `members.write`
 *   is fenced by the role lattice further down: without `mayAssignRole`, an
 *   admin promotes itself to owner and holds `billing.write` a request later.
 * - `endpoint-secrets.*` is owner/admin ONLY, and is NOT covered by
 *   `endpoints.read`. An HMAC signing secret authenticates every outbound call
 *   we make; whoever holds it can forge a webhook into the customer's own
 *   consumers. It is strictly stronger than the API key inventory that this
 *   same table already withholds from `viewer`, so it cannot ride along on the
 *   endpoint row.
 * - `audit.read` is owner/admin. The audit log carries other members' actions,
 *   IP addresses and user agents - staff surveillance data, not project data.
 * - `policies.*` covers retry and rate-limit policies: project configuration a
 *   developer is expected to tune, visible to a viewer, invisible to billing.
 */
const GRANTS = {
  //                          owner  admin  developer viewer billing
  'projects.read':         { owner: true,  admin: true,  developer: true,  viewer: true,  billing: true  },
  'projects.write':        { owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'endpoints.read':        { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'endpoints.write':       { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'endpoint-secrets.read': { owner: true,  admin: true,  developer: false, viewer: false, billing: false },
  'endpoint-secrets.write':{ owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'subscriptions.read':    { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'subscriptions.write':   { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'api-keys.read':         { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },
  'api-keys.write':        { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'events.read':           { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'events.replay':         { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'deliveries.read':       { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'deliveries.replay':     { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'policies.read':         { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'policies.write':        { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  // Alert destinations. Readable by everyone who can read the delivery record,
  // because "who gets told when this breaks?" is part of understanding what
  // happened. Writable by developer and up: adding a destination sends mail to
  // an address of the writer's choosing, which is not a viewer's to do.
  'notifications.read':    { owner: true,  admin: true,  developer: true,  viewer: true,  billing: false },
  'notifications.write':   { owner: true,  admin: true,  developer: true,  viewer: false, billing: false },

  'members.read':          { owner: true,  admin: true,  developer: true,  viewer: true,  billing: true  },
  'members.write':         { owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'audit.read':            { owner: true,  admin: true,  developer: false, viewer: false, billing: false },

  'billing.read':          { owner: true,  admin: true,  developer: false, viewer: false, billing: true  },
  'billing.write':         { owner: true,  admin: false, developer: false, viewer: false, billing: true  },
} as const satisfies Record<string, Record<MemberRole, boolean>>;

export type Permission = keyof typeof GRANTS;

/** Every permission, in declaration order. Iteration order is stable. */
export const PERMISSIONS: readonly Permission[] = Object.freeze(
  Object.keys(GRANTS) as Permission[],
);

/**
 * Every role, DERIVED from the matrix rather than hand-written.
 *
 * A hand-written list is a third place to forget: adding a role to the Prisma
 * enum and to `GRANTS` is compiler-forced, but forgetting a separate array
 * compiled clean and produced `permissionsForRole(newRole) === undefined`, i.e.
 * a TypeError and a 500 on every request from that role, logged as an unhandled
 * exception rather than as an authorization decision. Any matrix row would do;
 * `projects.read` is the one every role has an opinion about.
 */
export const MEMBER_ROLES: readonly MemberRole[] = Object.freeze(
  Object.keys(GRANTS['projects.read']) as MemberRole[],
);

/**
 * A `Set` that cannot be widened, even by a cast.
 *
 * `ReadonlySet` is erased at compile time: the shared per-role set was handed
 * out directly, so a single `as Set<Permission>` anywhere in fourteen modules
 * would have granted that permission to every user of that role for the
 * lifetime of the process. This exposes `has`/iteration and simply has no
 * `add`, so the cast throws instead of succeeding, and the object is frozen so
 * one cannot be bolted on.
 */
class FrozenPermissionSet implements ReadonlySet<Permission> {
  private readonly inner: ReadonlySet<Permission>;

  constructor(values: Iterable<Permission>) {
    this.inner = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.inner.size;
  }

  has(permission: Permission): boolean {
    return this.inner.has(permission);
  }

  forEach(
    callback: (value: Permission, value2: Permission, set: ReadonlySet<Permission>) => void,
    thisArg?: unknown,
  ): void {
    this.inner.forEach((value, value2) => callback.call(thisArg, value, value2, this));
  }

  entries(): IterableIterator<[Permission, Permission]> {
    return this.inner.entries();
  }

  keys(): IterableIterator<Permission> {
    return this.inner.keys();
  }

  values(): IterableIterator<Permission> {
    return this.inner.values();
  }

  [Symbol.iterator](): IterableIterator<Permission> {
    return this.inner[Symbol.iterator]();
  }
}

function buildRolePermissions(): Readonly<Record<MemberRole, ReadonlySet<Permission>>> {
  const table = {} as Record<MemberRole, ReadonlySet<Permission>>;
  for (const role of MEMBER_ROLES) {
    table[role] = new FrozenPermissionSet(
      PERMISSIONS.filter((permission) => GRANTS[permission][role]),
    );
  }
  return Object.freeze(table);
}

/** role -> the permissions it grants. Actually frozen, at module load. */
export const ROLE_PERMISSIONS: Readonly<Record<MemberRole, ReadonlySet<Permission>>> =
  buildRolePermissions();

/**
 * Throws rather than returning `undefined` for a role the matrix never heard
 * of. The caller is about to do `.has(...)` on the result; a miss must surface
 * as a named authorization failure, not as a TypeError in a request handler.
 */
export function permissionsForRole(role: MemberRole): ReadonlySet<Permission> {
  const permissions = Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)
    ? ROLE_PERMISSIONS[role]
    : undefined;
  if (!permissions) {
    throw new AppError(
      'internal_error',
      `Role "${String(role)}" has no row in the permission matrix. Add it to GRANTS in authz/permissions.ts.`,
    );
  }
  return permissions;
}

export function roleHasPermission(role: MemberRole, permission: Permission): boolean {
  return permissionsForRole(role).has(permission);
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
export const READ_PERMISSIONS: ReadonlySet<Permission> = new FrozenPermissionSet(
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
  const allowed: Permission[] = [];
  for (const permission of granted) {
    if (isReadPermission(permission) || permission === 'billing.write') allowed.push(permission);
  }
  return new FrozenPermissionSet(allowed);
}

/**
 * The ROLE LATTICE - the second axis of the matrix, and the reason the
 * `billing.write` denial above is not cosmetic.
 *
 * `members.write` governs role changes. Held alone it is a self-service
 * promotion: an admin sets its own membership to `owner` in one request and
 * holds every permission the matrix withheld from admin in the next. The
 * permission answers "may you touch memberships at all"; these rules answer
 * "which membership, to which role" - and they live here, beside the grid,
 * because the grid is the declared source of truth for the role axis.
 *
 * `viewer` and `billing` share a rank: they are incomparable (one sees data,
 * the other sees money) and neither may assign anything, so no ordering between
 * them is needed or implied.
 */
export const ROLE_RANK: Readonly<Record<MemberRole, number>> = Object.freeze({
  owner: 40,
  admin: 30,
  developer: 20,
  viewer: 10,
  billing: 10,
} satisfies Record<MemberRole, number>);

/**
 * May an actor holding `actor` hand out `target`?
 *
 * Never a role ranked above your own. An admin may make another admin - that is
 * ordinary delegation - but may not mint an owner, and may not demote one,
 * because both are the same move: taking a role you do not hold.
 */
export function mayAssignRole(actor: MemberRole, target: MemberRole): boolean {
  return roleHasPermission(actor, 'members.write') && ROLE_RANK[target] <= ROLE_RANK[actor];
}

/** A proposed membership change, as the members module will present it. */
export interface RoleChange {
  actorRole: MemberRole;
  /** `organization_members.id` of the actor - `RequestContext.membershipId`. */
  actorMembershipId: string;
  /** `organization_members.id` of the membership being changed. */
  targetMembershipId: string;
  /** The target's role right now. */
  currentRole: MemberRole;
  /** The role being assigned. */
  nextRole: MemberRole;
  /**
   * Owners in this organization RIGHT NOW, including the target if it is one.
   * Count it inside the same transaction as the update, or two concurrent
   * demotions each see two owners and leave zero.
   */
  ownerCount: number;
}

/**
 * The three invariants a members module must not re-derive. Throws; returns
 * nothing on success, so it cannot be called and ignored by accident.
 */
export function assertRoleChangeAllowed(change: RoleChange): void {
  if (!roleHasPermission(change.actorRole, 'members.write')) {
    throw new AppError('forbidden', 'You may not change member roles.');
  }
  // Self-promotion is the escalation path this whole block exists for, and
  // self-demotion is how an organization loses its last owner by accident.
  // Someone else with the rank does it, or it does not happen.
  if (change.actorMembershipId === change.targetMembershipId) {
    throw new AppError(
      'forbidden',
      'You cannot change your own role. Ask another owner or admin to do it.',
    );
  }
  if (!mayAssignRole(change.actorRole, change.nextRole)) {
    throw new AppError('forbidden', `You may not assign the role "${change.nextRole}".`);
  }
  // Symmetrical: taking a role away from someone above you is the same power as
  // granting yourself theirs.
  if (!mayAssignRole(change.actorRole, change.currentRole)) {
    throw new AppError('forbidden', `You may not change the role of an ${change.currentRole}.`);
  }
  assertOwnerSurvives(change.currentRole, change.nextRole, change.ownerCount);
}

/** Removal is a role change to "no role": the same last-owner rule applies. */
export function assertMemberRemovalAllowed(
  change: Omit<RoleChange, 'nextRole'>,
): void {
  if (!roleHasPermission(change.actorRole, 'members.write')) {
    throw new AppError('forbidden', 'You may not remove members.');
  }
  if (change.actorMembershipId === change.targetMembershipId) {
    throw new AppError(
      'forbidden',
      'You cannot remove your own membership. Ask another owner or admin to do it.',
    );
  }
  if (!mayAssignRole(change.actorRole, change.currentRole)) {
    throw new AppError('forbidden', `You may not remove an ${change.currentRole}.`);
  }
  assertOwnerSurvives(change.currentRole, null, change.ownerCount);
}

/**
 * An organization with no owner cannot be recovered through the API - nobody
 * left holds `members.write` at owner rank, and `billing.write` goes with it.
 */
function assertOwnerSurvives(
  currentRole: MemberRole,
  nextRole: MemberRole | null,
  ownerCount: number,
): void {
  if (currentRole !== 'owner' || nextRole === 'owner') return;
  if (ownerCount <= 1) {
    throw new AppError(
      'conflict',
      'An organization must always have at least one owner. Promote another member first.',
    );
  }
}

/**
 * Accessor on `TenantScope` -> the permission that gates reading it.
 *
 * The compiler is silent about a resource nobody named, so the author of the
 * next module reaches for the nearest plausible permission and it is over-broad
 * by construction. This table is the explicit answer, and
 * `permissions.spec.ts` fails if `TenantScope` grows an accessor that is not in
 * it. Write access, where it differs, is the matching `.write`/`.replay`.
 */
export const TENANT_SCOPE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> =
  Object.freeze({
    // Every member can see the organization they are in and its projects; that
    // is the same visibility `billing` is deliberately given.
    organization: ['projects.read'],
    projects: ['projects.read'],
    members: ['members.read'],
    auditLogs: ['audit.read'],
    usageRecords: ['billing.read'],
    billingSubscriptions: ['billing.read'],
    endpoints: ['endpoints.read'],
    apiKeys: ['api-keys.read'],
    subscriptions: ['subscriptions.read'],
    retryPolicies: ['policies.read'],
    rateLimitPolicies: ['policies.read'],
    notificationDestinations: ['notifications.read'],
    // Idempotency records are the write path's own bookkeeping for the resource
    // being written; they carry no data of their own beyond a stored response.
    idempotencyKeys: ['events.read'],
    events: ['events.read'],
    // The router's work queue for an event. Reading it is reading the event's
    // own processing state - "why has nothing arrived?" - so it rides on
    // `events.read`. WRITING it (requeue) does not: that route demands
    // `events.replay` AND `deliveries.replay`, because a requeue puts real
    // outbound HTTP on a customer's endpoints.
    eventOutbox: ['events.read'],
    deliveries: ['deliveries.read'],
    endpointSecrets: ['endpoint-secrets.read'],
    // Health is an endpoint's delivery record, not its credential.
    endpointHealth: ['endpoints.read'],
    deliveryAttempts: ['deliveries.read'],
  } satisfies Record<string, readonly Permission[]>);
