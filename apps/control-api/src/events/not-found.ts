import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary. Same three lines as `deliveries/not-found.ts` and the
 * three modules before it - see the docblock there for why each module keeps
 * its own copy rather than importing a sibling's internals.
 *
 * Here the leak it closes is specific: `POST /events/:id/replay` takes an
 * `endpoint_id` in the BODY as well as an event id in the path, so without this
 * a caller could tell "that event is not yours" (Event not found.) from "that
 * endpoint is not yours" (Endpoint not found.) in a single request, and use the
 * events route as an oracle over another customer's endpoint ids.
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
