/**
 * The role lattice, client side, as data.
 *
 * Mirrors control-api `src/authz/permissions.ts` — `ROLE_RANK`,
 * `mayAssignRole`, `assertRoleChangeAllowed`, `assertMemberRemovalAllowed`
 * and `assertOwnerSurvives` — in the same words, so a control that is
 * disabled on the Team page says the sentence the server would have answered
 * with. This is an AFFORDANCE, not authority: the server re-runs every rule
 * inside the transaction that writes, and a 403/409 it returns is rendered
 * verbatim. What this buys is a select that explains why it is greyed out
 * instead of one that fails identically every time it is touched.
 *
 * The rules, in the server's order:
 *
 *   1. The actor holds `members.write` — owner and admin only.
 *   2. Never your own membership. Self-promotion is the escalation path this
 *      whole block exists for; self-demotion is how an organization loses its
 *      last owner by accident.
 *   3. Never a role ranked above your own (`mayAssignRole(actor, next)`).
 *   4. Never someone who outranks you (`mayAssignRole(actor, current)`) —
 *      taking a role from someone above you is the same power as granting
 *      yourself theirs.
 *   5. Never the last owner (a 409, the only one of these that is not a 403).
 *      The count is taken inside the server's transaction; the client only
 *      knows the page it can see, so it pre-empts this ONLY when the page is
 *      the whole list.
 *
 * `viewer` and `billing` share a rank: they are incomparable, and an admin may
 * move a member between them freely.
 */
import type { Member, Role } from '../../types/api';

/** `ROLE_RANK` on the control API. Higher outranks lower; equal is incomparable. */
export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  owner: 40,
  admin: 30,
  developer: 20,
  viewer: 10,
  billing: 10,
});

/** Every role, highest first — the order a select should list them in. */
export const ROLES: readonly Role[] = ['owner', 'admin', 'developer', 'viewer', 'billing'];

/** `members.write` in the permission matrix. */
export const MEMBERS_WRITE_ROLES: readonly Role[] = ['owner', 'admin'];

export function holdsMembersWrite(role: Role): boolean {
  return MEMBERS_WRITE_ROLES.includes(role);
}

/** May an actor holding `actor` hand out `target`? Never a role ranked above their own. */
export function mayAssignRole(actor: Role, target: Role): boolean {
  return holdsMembersWrite(actor) && ROLE_RANK[target] <= ROLE_RANK[actor];
}

/** The roles an actor may put someone in — what the select offers un-greyed. */
export function assignableRoles(actor: Role): Role[] {
  return ROLES.filter((role) => mayAssignRole(actor, role));
}

export type LatticeVerdict =
  | { verdict: 'allowed' }
  /** The server has not said, and the page cannot know: let it answer. */
  | { verdict: 'unknown' }
  | {
      verdict: 'denied';
      /** `forbidden` maps to a 403, `conflict` to the last-owner 409. */
      code: 'forbidden' | 'conflict';
      /** The sentence the server would answer with. */
      reason: string;
    };

export interface LatticeContext {
  /** The caller's role in this organization — `OrganizationDto.role`. */
  actorRole: Role | undefined;
  /** The caller's user id — `AuthUserDto.id`. Undefined while the session is loading. */
  actorUserId: string | undefined;
  /**
   * Live owners, when the page IS the whole list; null when it is paged and
   * the count cannot be known here. Never guessed from a partial page.
   */
  ownerCount: number | null;
}

/**
 * Whether the actor may change `target` to `nextRole`, and if not, why.
 *
 * Unknown actor role or user id yields `unknown`, not `denied`: a pre-check
 * that is wrong costs an owner a control; a missing one costs a single 403.
 */
export function roleChangeVerdict(
  context: LatticeContext,
  target: Pick<Member, 'user_id' | 'role'>,
  nextRole: Role,
): LatticeVerdict {
  const { actorRole, actorUserId } = context;
  if (actorRole === undefined || actorUserId === undefined) return { verdict: 'unknown' };

  if (!holdsMembersWrite(actorRole)) {
    return { verdict: 'denied', code: 'forbidden', reason: 'You may not change member roles.' };
  }
  if (target.user_id === actorUserId) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: 'You cannot change your own role. Ask another owner or admin to do it.',
    };
  }
  if (!mayAssignRole(actorRole, nextRole)) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: `You may not assign the role "${nextRole}".`,
    };
  }
  if (!mayAssignRole(actorRole, target.role)) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: `You may not change the role of an ${target.role}.`,
    };
  }
  return ownerSurvives(target.role, nextRole, context.ownerCount);
}

/**
 * Whether the actor may remove `target`. Removal is a role change to "no
 * role", so the same lattice applies, last-owner rule included.
 */
export function removalVerdict(
  context: LatticeContext,
  target: Pick<Member, 'user_id' | 'role'>,
): LatticeVerdict {
  const { actorRole, actorUserId } = context;
  if (actorRole === undefined || actorUserId === undefined) return { verdict: 'unknown' };

  if (!holdsMembersWrite(actorRole)) {
    return { verdict: 'denied', code: 'forbidden', reason: 'You may not remove members.' };
  }
  if (target.user_id === actorUserId) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: 'You cannot remove your own membership. Ask another owner or admin to do it.',
    };
  }
  if (!mayAssignRole(actorRole, target.role)) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: `You may not remove an ${target.role}.`,
    };
  }
  return ownerSurvives(target.role, null, context.ownerCount);
}

/**
 * Whether the row's select should be interactive at all, and the hint that
 * explains a greyed-out one. Independent of any particular next role: it asks
 * "may this actor change THIS member to anything".
 */
export function rowVerdict(
  context: LatticeContext,
  target: Pick<Member, 'user_id' | 'role'>,
): LatticeVerdict {
  const { actorRole, actorUserId } = context;
  if (actorRole === undefined || actorUserId === undefined) return { verdict: 'unknown' };
  if (!holdsMembersWrite(actorRole)) {
    return { verdict: 'denied', code: 'forbidden', reason: 'You may not change member roles.' };
  }
  if (target.user_id === actorUserId) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: 'You cannot change your own role. Ask another owner or admin to do it.',
    };
  }
  if (!mayAssignRole(actorRole, target.role)) {
    return {
      verdict: 'denied',
      code: 'forbidden',
      reason: `You may not change the role of an ${target.role}.`,
    };
  }
  return { verdict: 'allowed' };
}

export function isDenied(verdict: LatticeVerdict): verdict is Extract<LatticeVerdict, { verdict: 'denied' }> {
  return verdict.verdict === 'denied';
}

/** The last-owner rule. Unknown count means the server decides. */
function ownerSurvives(
  currentRole: Role,
  nextRole: Role | null,
  ownerCount: number | null,
): LatticeVerdict {
  if (currentRole !== 'owner' || nextRole === 'owner') return { verdict: 'allowed' };
  if (ownerCount === null) return { verdict: 'unknown' };
  if (ownerCount <= 1) {
    return {
      verdict: 'denied',
      code: 'conflict',
      reason: 'An organization must always have at least one owner. Promote another member first.',
    };
  }
  return { verdict: 'allowed' };
}

/**
 * Owners on the page, or null when the page is not the whole list — the only
 * honest input to the last-owner rule from a paged read.
 */
export function ownerCountOf(page: { rows: Pick<Member, 'role'>[]; hasMore: boolean }, offset: number): number | null {
  if (page.hasMore || offset > 0) return null;
  return page.rows.filter((member) => member.role === 'owner').length;
}
