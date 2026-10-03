import { roleGate, type RoleGate } from '../../lib/role-gate';
import type { Organization, Role } from '../../types/api';

/**
 * `subscriptions.write` — owner, admin and developer, per the matrix in
 * control-api `src/authz/permissions.ts`. Every write route on
 * `WebhookSubscriptionsController` (create, update, enable, disable, delete)
 * carries it; a viewer holds `subscriptions.read` only and billing holds
 * neither.
 */
export const SUBSCRIPTION_WRITE_ROLES: readonly Role[] = ['developer', 'admin', 'owner'];

export function subscriptionWriteGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
): RoleGate {
  return roleGate(organization, SUBSCRIPTION_WRITE_ROLES);
}
