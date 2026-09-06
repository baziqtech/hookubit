/**
 * The lifecycle of an API key, derived rather than stored.
 *
 * There is no `api_keys.status` column, and there should not be: `revoked_at`
 * and `expires_at` are facts with timestamps, a status is a summary of them at
 * a given instant, and the two would drift the moment a key expired with nobody
 * running an updater. The Go ingest path derives it the same way, at request
 * time, and it is authoritative:
 *
 *     handler.go:247  record.RevokedAt != nil && !record.RevokedAt.After(now)
 *     handler.go:250  record.ExpiresAt != nil && !record.ExpiresAt.After(now)
 *
 * Note `!After(now)`, i.e. `<= now`: a timestamp exactly equal to now counts as
 * already revoked/expired. This file mirrors that boundary deliberately - a
 * control plane that called a key "active" one millisecond after the data plane
 * started refusing it would send an operator hunting a phantom outage.
 *
 * `revoked` outranks `expired` because revocation is a deliberate act and the
 * operator needs to see it, even on a key that would have lapsed anyway.
 */
export type ApiKeyState = 'active' | 'expired' | 'revoked';

/** The two timestamp columns this derivation needs. */
export interface ApiKeyLifecycle {
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export function apiKeyState(key: ApiKeyLifecycle, now: Date = new Date()): ApiKeyState {
  const at = now.getTime();
  if (key.revokedAt !== null && key.revokedAt.getTime() <= at) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt.getTime() <= at) return 'expired';
  return 'active';
}

/**
 * Would the ingest path accept this key right now, on the key row alone?
 *
 * "On the key row alone" is the caveat: the data plane ALSO refuses a key whose
 * project is not `active` and whose environment does not match its project's
 * (`handler.go:166,169`). Both of those are project facts, not key facts, so
 * they are not derivable here and this must never be presented to an operator
 * as "this key works".
 */
export function isApiKeyUsable(key: ApiKeyLifecycle, now: Date = new Date()): boolean {
  return apiKeyState(key, now) === 'active';
}
