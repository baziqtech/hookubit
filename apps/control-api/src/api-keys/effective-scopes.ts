import { MemberRole } from '@prisma/client';
import { Permission, isPermission, permissionsForRole } from '../authz';

/**
 * WHAT A KEY MAY ACTUALLY DO, RIGHT NOW - as opposed to what it was minted with.
 *
 * `api_keys.scopes` is a SNAPSHOT of its issuer's authority at one instant.
 * `ApiKeysService.resolveScopes` refuses any scope the issuer does not hold, so
 * a key can never be minted above its issuer - and then nothing ever looked
 * again. A developer mints a key carrying `endpoints.write` and `events.replay`,
 * is demoted to viewer or removed from the organization, and the credential
 * keeps full developer authority for as long as it exists.
 *
 * The fix is a DERIVATION, not a stored value:
 *
 *     effective = key.scopes INTERSECT permissionsForRole(issuer's CURRENT role)
 *
 * and a key whose issuer is gone (`created_by_membership_id` NULL, which is what
 * the FK's ON DELETE SET NULL leaves behind when a membership is removed)
 * intersects to the EMPTY set. Never to the stored scopes - "we no longer know
 * whose authority this was" must mean no authority, not all of it.
 *
 * Why a derivation rather than revoking the key when its issuer leaves:
 *
 *  - A key is bound to a PROJECT, not to a person. Revoking on an HR event takes
 *    a production ingest credential offline for a reason that has nothing to do
 *    with the integration it serves; the first time it happens is an outage
 *    nobody can explain from the key's own history.
 *  - It is idempotent and needs no sweep. A sweep can be missed (a membership
 *    deleted by a migration, a backfill, another service, or by the FK's own
 *    cascade rather than through this API) and a missed sweep fails OPEN.
 *    Re-deriving reads current state on every use, so there is no window and
 *    nothing to replay.
 *  - It degrades authority instead of destroying it. A demoted developer's key
 *    keeps exactly the scopes the demotion left them, which is the answer an
 *    operator would give by hand.
 *  - It is expressible as a single JOIN, so the Go ingest path can adopt it
 *    without a scheduler or a second writer. See apps/control-api/HANDOFF.md,
 *    "API key effective scopes".
 *
 * Revocation stays the operator's tool for "this credential must die", and is
 * still the only thing that frees a slot against the per-project ceiling.
 */
export function effectiveScopes(
  stored: readonly string[],
  issuerRole: MemberRole | null,
): Permission[] {
  // No issuer means no authority. This covers three cases that must not be told
  // apart here: the membership was removed (FK set it NULL), the row predates
  // the columns, and the issuer's membership is in an organization the key's
  // project no longer belongs to.
  if (issuerRole === null) return [];

  const held = permissionsForRole(issuerRole);
  const effective: Permission[] = [];
  for (const scope of stored) {
    // An unknown string in the column - written by a migration, a CLI, or a
    // permission this build has since removed - is not a permission this system
    // can grant, so it is dropped rather than passed through.
    if (!isPermission(scope)) continue;
    if (held.has(scope) && !effective.includes(scope)) effective.push(scope);
  }
  return effective;
}
