import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * Normalise any `not_found` raised inside this module to the ONE 404 string the
 * whole control plane speaks.
 *
 * `ScopedRepository.notFound()` now emits `CROSS_TENANT_MESSAGE` itself, so the
 * repository path no longer needs this. It stays as the module's fence for the
 * `not_found`s a SERVICE raises - a lookup that misses after its own read, a
 * helper that predates the alignment - so there is one place to look when
 * someone asks why every miss in this module reads the same.
 *
 * Only `not_found` is rewritten. The distinctions that are genuinely useful
 * inside the tenant - an expiry in the past, a scope the caller does not hold,
 * a ceiling reached, a conflict - are different codes with their own messages
 * and all survive untouched.
 */
export async function withCrossTenantNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      throw new AppError('not_found', CROSS_TENANT_MESSAGE, err.details);
    }
    throw err;
  }
}
