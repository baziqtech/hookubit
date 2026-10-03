import type { Organization, Role } from '../../types/api';

/**
 * Who may write a retry or rate-limit policy, as data.
 *
 * Every write route on `RetryPoliciesController` and `RateLimitsController`
 * carries `@Authorized('policies.write')`, and the role matrix in control-api
 * `src/authz/permissions.ts` grants it to OWNER, ADMIN and DEVELOPER —
 * "project configuration a developer is expected to tune, visible to a
 * viewer, invisible to billing". `policies.read` is every role but billing,
 * so a viewer sees the tables and none of the buttons do anything for them.
 *
 * This is an AFFORDANCE, not authority — the same posture as
 * `features/outbox/permissions.ts`. The server decides on every request, and
 * a 403 it returns is rendered as `PermissionDenied` naming the roles. What
 * this buys is a control that says WHY it is disabled instead of one that
 * fails identically every time it is pressed.
 *
 * When the role is not known (the organization list has not loaded, or
 * failed) the controls stay enabled: a missing pre-check costs one 403, a
 * wrong one costs an operator the ability to fix a policy during an incident.
 */
export const POLICY_WRITE_ROLES: readonly Role[] = ['developer', 'admin', 'owner'];

export type PolicyWriteGate =
  | { verdict: 'allowed' }
  | { verdict: 'unknown' }
  | { verdict: 'denied'; because: 'role'; role: Role }
  | { verdict: 'denied'; because: 'suspended' };

export function policyWriteGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
): PolicyWriteGate {
  if (!organization) return { verdict: 'unknown' };
  if (organization.status === 'suspended') return { verdict: 'denied', because: 'suspended' };
  if (!POLICY_WRITE_ROLES.includes(organization.role)) {
    return { verdict: 'denied', because: 'role', role: organization.role };
  }
  return { verdict: 'allowed' };
}

/** Enabled unless the gate positively says no. */
export function mayWritePolicies(gate: PolicyWriteGate): boolean {
  return gate.verdict !== 'denied';
}

/** The tooltip on a disabled control, so "greyed out" is never the whole answer. */
export function policyWriteDeniedReason(gate: PolicyWriteGate): string | undefined {
  if (gate.verdict !== 'denied') return undefined;
  if (gate.because === 'suspended') {
    return 'This organization is suspended, so its policies cannot be changed until it is reinstated.';
  }
  return `Changing policies needs the developer, admin or owner role. You are a ${gate.role} in this organization.`;
}
