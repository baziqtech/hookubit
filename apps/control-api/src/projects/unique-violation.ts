/**
 * P2002 handling, done by INDEX rather than by error code.
 *
 * The auth module shipped exactly this bug and it is worth restating: a
 * `catch (P2002) -> throw conflict('email already exists')` duck-typed on the
 * code alone, so a collision on the OTHER unique index in the same statement -
 * `organizations_slug_key` - was reported to the caller as a duplicate email.
 * The caller was told something false about a request that had failed for a
 * different, fixable reason.
 *
 * So: read `err.meta.target`, decide per index, and RETHROW anything not
 * recognised. A unique index nobody modelled must surface as a 500 with a stack
 * trace, not as a friendly 409 that sends the caller looking in the wrong
 * place.
 *
 * Prisma reports `meta.target` in two shapes depending on the connector and the
 * version - the column list (`['organization_id', 'slug']`) and the constraint
 * name (`'projects_organizationId_slug_key'`) - so both are flattened to one
 * lowercase string and matched by substring.
 */
export const UNIQUE_VIOLATION = 'P2002';

/**
 * The lowercased, comma-joined `meta.target` of a P2002, or null when the error
 * is not a unique violation at all. An empty string means "P2002, but the
 * driver told us nothing about which index" - which must NOT be treated as a
 * match for any particular one.
 */
export function uniqueViolationTarget(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  if ((err as { code?: unknown }).code !== UNIQUE_VIOLATION) return null;

  const raw = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(raw)) return raw.map((part) => String(part)).join(',').toLowerCase();
  if (typeof raw === 'string') return raw.toLowerCase();
  return '';
}

/** True when this error is a unique violation on an index covering `column`. */
export function isUniqueViolationOn(err: unknown, column: string): boolean {
  const target = uniqueViolationTarget(err);
  return target !== null && target.includes(column);
}
