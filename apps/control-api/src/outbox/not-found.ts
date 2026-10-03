import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary. Same three lines as `events/not-found.ts` and the modules
 * before it - see the docblock there for why each module keeps its own copy
 * rather than importing a sibling's internals.
 *
 * The leak it closes here: an outbox row is addressed by its own id, but the
 * routes also take an `event_id` filter, and `ScopedRepository` would otherwise
 * answer "Outbox entry not found." for one and "Event not found." for the other.
 * A 404 that says which KIND of thing an id names confirms the id is live
 * infrastructure belonging to somebody.
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

/** The 404 this module raises directly. */
export function crossTenantNotFound(): AppError {
  return new AppError('not_found', CROSS_TENANT_MESSAGE);
}
