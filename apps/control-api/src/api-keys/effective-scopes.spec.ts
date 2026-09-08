import { permissionsForRole } from '../authz';
import { effectiveScopes } from './effective-scopes';

/**
 * THE SECURITY FINDING, stated as a test.
 *
 * `api_keys.scopes` is a snapshot of the issuer's authority at mint time and
 * nothing re-checked it, so a developer who minted a key carrying
 * `endpoints.write` and `events.replay` and was then demoted - or removed -
 * left a credential with full developer authority behind them.
 */
describe('effectiveScopes', () => {
  const minted = ['endpoints.write', 'endpoints.read', 'events.replay'];

  it('is the stored scopes while the issuer still holds them', () => {
    expect(effectiveScopes(minted, 'developer')).toEqual(minted);
  });

  it('NARROWS to what the issuer holds now once they are demoted', () => {
    // viewer keeps endpoints.read and holds neither endpoints.write nor
    // events.replay, so the credential loses exactly those two.
    const effective = effectiveScopes(minted, 'viewer');

    expect(effective).toEqual(['endpoints.read']);
    expect(effective).not.toContain('endpoints.write');
    expect(effective).not.toContain('events.replay');
    for (const scope of effective) {
      expect(permissionsForRole('viewer').has(scope)).toBe(true);
    }
  });

  /**
   * `ON DELETE SET NULL` on `api_keys.created_by_membership_id` means a removed
   * membership leaves a NULL behind, and the caller passes null for that. It
   * must intersect to NOTHING - "we no longer know whose authority this was"
   * cannot be allowed to mean "all of it", which is the fail-open direction and
   * the whole finding.
   */
  it('is EMPTY when the issuer is gone', () => {
    expect(effectiveScopes(minted, null)).toEqual([]);
  });

  it('is empty for a key that was minted with no scopes at all', () => {
    // The normal ingest key: it authenticates, it exercises no control scope.
    expect(effectiveScopes([], 'owner')).toEqual([]);
  });

  it('never widens: a promoted issuer does not grant scopes the key never had', () => {
    // The mint-time refusal in ApiKeysService.resolveScopes is what keeps a key
    // from being born above its issuer; this is the other half - the
    // intersection can only ever remove.
    const effective = effectiveScopes(['endpoints.read'], 'owner');

    expect(effective).toEqual(['endpoints.read']);
    expect(effective.length).toBeLessThan(permissionsForRole('owner').size);
  });

  it('drops a stored string that is not a permission this build knows', () => {
    // A value written by a CLI, a migration, or a permission since removed. It
    // cannot be granted, so it is not returned - rather than passed through to
    // a caller that would compare it against nothing.
    expect(effectiveScopes(['endpoints.read', 'nonsense.write'], 'owner')).toEqual([
      'endpoints.read',
    ]);
  });

  it('deduplicates, so a repeated stored scope is not granted twice', () => {
    expect(effectiveScopes(['endpoints.read', 'endpoints.read'], 'owner')).toEqual([
      'endpoints.read',
    ]);
  });
});
