import type { Organization, Role } from '../types/api';

/**
 * "May this role press this button?", as data.
 *
 * The shape `src/features/outbox/permissions.ts` established for Requeue,
 * lifted so subscriptions, projects and organization deletion can declare
 * their roles in one line each instead of restating the gate. The rules are
 * unchanged:
 *
 *   - This is an AFFORDANCE, not authority. The server decides on every
 *     request and its 403 is rendered honestly. What the gate buys is a button
 *     that says WHY it is disabled instead of one that fails identically every
 *     time it is pressed.
 *   - When the role is not known — the organization list has not loaded, or
 *     failed — the control stays enabled. A missing pre-check costs one 403; a
 *     wrong one costs an operator a recovery path at 2am.
 *   - A suspended organization loses every write, so every gate denies there.
 *
 * The role lists come from the matrix in control-api `src/authz/permissions.ts`
 * and are declared next to the feature that uses them.
 */
export type RoleGate =
  | { verdict: 'allowed' }
  | { verdict: 'unknown' }
  | { verdict: 'denied'; because: 'role'; role: Role; required: readonly Role[] }
  | { verdict: 'denied'; because: 'suspended' };

export function roleGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
  required: readonly Role[],
): RoleGate {
  if (!organization) return { verdict: 'unknown' };
  if (organization.status === 'suspended') return { verdict: 'denied', because: 'suspended' };
  if (!required.includes(organization.role)) {
    return { verdict: 'denied', because: 'role', role: organization.role, required };
  }
  return { verdict: 'allowed' };
}

/** Enabled unless the gate positively says no. */
export function mayAct(gate: RoleGate): boolean {
  return gate.verdict !== 'denied';
}

/** "developer, admin or owner" — a list a person reads. */
export function formatRoleList(roles: readonly Role[]): string {
  if (roles.length === 1) return roles[0];
  return `${roles.slice(0, -1).join(', ')} or ${roles[roles.length - 1]}`;
}

/**
 * The tooltip on a disabled control, so "greyed out" is never the whole
 * answer. `action` is a gerund phrase: "Creating a subscription".
 */
export function deniedReason(gate: RoleGate, action: string): string | undefined {
  if (gate.verdict !== 'denied') return undefined;
  if (gate.because === 'suspended') {
    return `This organization is suspended, so nothing can be changed until it is reinstated.`;
  }
  return `${action} needs the ${formatRoleList(gate.required)} role. You are a ${gate.role} in this organization.`;
}
