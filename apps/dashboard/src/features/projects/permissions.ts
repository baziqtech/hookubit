import { roleGate, type RoleGate } from '../../lib/role-gate';
import type { Organization, Role } from '../../types/api';

/**
 * `projects.write` — owner and admin ONLY, per control-api
 * `src/authz/permissions.ts`. A developer owns everything inside a project and
 * cannot create or delete one. Creating and soft-deleting a project both carry
 * this permission.
 */
export const PROJECT_WRITE_ROLES: readonly Role[] = ['admin', 'owner'];

export function projectWriteGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
): RoleGate {
  return roleGate(organization, PROJECT_WRITE_ROLES);
}

/**
 * Deleting an ORGANIZATION is owner-only. The route is declared
 * `@Authorized('projects.write')` and `OrganizationsService.remove` then
 * checks `context.role === 'owner'` separately — the matrix has no row for it,
 * which is why this is its own list rather than `PROJECT_WRITE_ROLES`.
 */
export const ORGANIZATION_DELETE_ROLES: readonly Role[] = ['owner'];

export function organizationDeleteGate(
  organization: Pick<Organization, 'role' | 'status'> | undefined,
): RoleGate {
  return roleGate(organization, ORGANIZATION_DELETE_ROLES);
}
