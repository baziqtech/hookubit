import { formatRoleList } from '../../lib/role-gate';
import type { Role } from '../../types/api';
import type { SetupStepId } from './setup';

/**
 * Which roles may READ each input the setup checklist is derived from.
 *
 * ## A denial is not a failed check
 *
 * The checklist composes six live queries, and two of them are gated by the
 * role matrix in control-api `src/authz/permissions.ts`. A member whose role
 * lacks the grant gets a 403, which `lib/api.ts` never retries — so the query
 * stays errored for the life of the tab.
 *
 * Read as an error, that pinned the Setup affordance to `show` FOREVER for a
 * viewer (no `api-keys.read`) and a billing member (no `api-keys.read`, no
 * `endpoints.read`, no `subscriptions.read`, no `events.read`): the check could
 * never resolve, so completeness was never recorded, so the item could never be
 * cleared — on every project, including a fully operating one, with the
 * checklist behind it reading "Setup state is incomplete". The mirror of the
 * failure the affordance rule exists to prevent: the item's presence became a
 * false claim about the project.
 *
 * So a denial is treated as NOT APPLICABLE rather than as an error. It is not
 * "we could not find out", which is temporary and might resolve; it is "this
 * role may not ask", which is a permanent and known property of the membership.
 * `useSetupState` drops those queries entirely (`enabled: false`, so no 403 is
 * issued and nothing polls one), excludes them from `isPending`/`isError`, and
 * marks the step `unavailable` — which `isSetupComplete` and `setupProgress`
 * leave out of the question rather than counting either way.
 *
 * The consequence, stated plainly: a role that cannot read an input is not
 * offered the checklist on account of that input. That is the right way round.
 * Every action on the checklist is a WRITE this role does not hold either
 * (`api-keys.write`, `endpoints.write`, `subscriptions.write`), so a permanent
 * to-do it can neither read nor clear is pure noise in the primary nav.
 *
 * ## Roles, not permissions
 *
 * The dashboard has no permission list of its own — the session carries a role
 * per organization, so the matrix is mirrored here as roles, the same way
 * `features/<feature>/permissions.ts` mirrors the write grants. `projects.read` and the
 * organizations list are granted to every role, which is why the organization
 * and project steps are absent from this table.
 */
export const SETUP_INPUT_READ_ROLES = {
  // `api-keys.read` — NOT viewer. A key row leaks no secret, but the inventory
  // of live credentials is not read-only-user data.
  'api-key': ['owner', 'admin', 'developer'],
  // `endpoints.read`, `subscriptions.read`, `events.read` — everyone but
  // billing, which is deliberately narrow: money, seats, and enough project
  // visibility to understand a usage line.
  endpoint: ['owner', 'admin', 'developer', 'viewer'],
  subscription: ['owner', 'admin', 'developer', 'viewer'],
  event: ['owner', 'admin', 'developer', 'viewer'],
} as const satisfies Partial<Record<SetupStepId, readonly Role[]>>;

/** The setup steps whose input is gated at all. */
export type GatedSetupStepId = keyof typeof SETUP_INPUT_READ_ROLES;

export const GATED_SETUP_STEPS = Object.freeze(
  Object.keys(SETUP_INPUT_READ_ROLES) as GatedSetupStepId[],
);

/**
 * May this role read the input behind this step?
 *
 * An UNKNOWN role answers yes — the organizations list has not landed yet, or
 * failed, and the rest of the check is pending or errored for the same reason.
 * Guessing "denied" here would silently drop a real input for an owner; asking
 * costs one request that the answer, once it arrives, stops repeating. Same
 * call `lib/role-gate.ts` makes for write affordances, for the same reason.
 *
 * Suspension is deliberately NOT consulted. A suspended organization loses its
 * WRITES; every read still answers, so `roleGate` — which denies outright on
 * suspension — is the wrong helper for a read gate.
 */
export function maySetupInputBeRead(step: GatedSetupStepId, role: Role | undefined): boolean {
  if (!role) return true;
  return (SETUP_INPUT_READ_ROLES[step] as readonly Role[]).includes(role);
}

/**
 * The steps this role may not read, each with the sentence explaining it.
 *
 * Handed to `deriveSetupSteps` as `unreadable`, so `/get-started` — still
 * reachable by bookmark for every role — says why a row is blank instead of
 * showing a step frozen at "Not started" that the reader cannot act on.
 */
export function unreadableSetupInputs(
  role: Role | undefined,
): Partial<Record<SetupStepId, string>> {
  const reasons: Partial<Record<SetupStepId, string>> = {};
  for (const step of GATED_SETUP_STEPS) {
    if (maySetupInputBeRead(step, role)) continue;
    reasons[step] =
      `Reading this needs the ${formatRoleList(SETUP_INPUT_READ_ROLES[step])} role. ` +
      `You are a ${role} in this organization.`;
  }
  return reasons;
}
