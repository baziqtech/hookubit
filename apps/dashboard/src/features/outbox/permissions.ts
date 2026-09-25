import type { Organization, Role } from '../../types/api';

/**
 * Who may press Requeue, as data.
 *
 * Both requeue routes carry `@Authorized('events.replay', 'deliveries.replay')`
 * — the same pair event replay requires — and the role matrix in control-api
 * `src/authz/permissions.ts` grants both to OWNER, ADMIN and DEVELOPER. A
 * viewer may watch an incident and may not act on it; billing holds neither.
 * A suspended organization loses every write permission, replay included.
 *
 * This is an AFFORDANCE, not authority. The server decides on every request,
 * and a 403 it returns is rendered as `PermissionDenied` naming the roles
 * (the pattern `AuditPage` uses). What this buys is a button that says why it
 * is disabled instead of one that fails identically every time it is pressed.
 *
 * When the role is not known — the organization list has not loaded, or
 * failed — the button stays enabled: a missing pre-check costs one 403, a
 * wrong one costs an operator a recovery path at 2am.
 */
export const REQUEUE_ROLES: readonly Role[] = ['developer', 'admin', 'owner'];

export type RequeueGate =
  | { verdict: 'allowed' }
  | { verdict: 'unknown' }
  | { verdict: 'denied'; because: 'role'; role: Role }
  | { verdict: 'denied'; because: 'suspended' };

export function requeueGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
): RequeueGate {
  if (!organization) return { verdict: 'unknown' };
  if (organization.status === 'suspended') return { verdict: 'denied', because: 'suspended' };
  if (!REQUEUE_ROLES.includes(organization.role)) {
    return { verdict: 'denied', because: 'role', role: organization.role };
  }
  return { verdict: 'allowed' };
}

/** Enabled unless the gate positively says no. */
export function mayRequeue(gate: RequeueGate): boolean {
  return gate.verdict !== 'denied';
}

/** The tooltip on a disabled button, so "greyed out" is never the whole answer. */
export function requeueDeniedReason(gate: RequeueGate): string | undefined {
  if (gate.verdict !== 'denied') return undefined;
  if (gate.because === 'suspended') {
    return 'This organization is suspended, so nothing can be requeued until it is reinstated.';
  }
  return `Requeueing needs the developer, admin or owner role. You are a ${gate.role} in this organization.`;
}
