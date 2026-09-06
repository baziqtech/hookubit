/**
 * Project slugs.
 *
 * `projects (organization_id, slug)` is UNIQUE, so a slug is an identifier a
 * customer chooses and the platform has to keep stable. Two rules follow:
 *
 * 1. A slug the caller SUPPLIED is validated, never normalised. Silently
 *    turning `Acme Prod` into `acme-prod` means the value the caller stores in
 *    their own config is not the value we stored, and the mismatch only shows
 *    up later as a 404 they cannot explain.
 * 2. A slug DERIVED from a name (because the caller sent no slug) is
 *    normalised, because there is nothing for the caller to disagree with yet.
 *    The derived value comes back in the create response.
 */

/** The wire format. Also enforced by `@Matches` on the DTO. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 64;

/**
 * Best-effort slug for a display name. Returns null when nothing usable
 * survives (`"!!!"`, an empty string, a name of only punctuation) - the caller
 * must then ask for an explicit slug rather than writing an empty one, which is
 * the bug `bootstrap` hit with `BOOTSTRAP_ORG="!!!"`.
 */
export function slugFromName(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');

  if (slug.length < SLUG_MIN_LENGTH || !SLUG_PATTERN.test(slug)) return null;
  return slug;
}
