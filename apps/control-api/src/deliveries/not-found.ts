import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary. Same three lines as `endpoints/not-found.ts`,
 * `api-keys/not-found.ts` and `webhook-subscriptions/not-found.ts`, for the
 * reason given there: the alternative is one module importing another module's
 * internals to save them. (Fifth module in a row - see HANDOFF.)
 *
 * It matters more here than anywhere else, because a replay touches FOUR
 * tables. `ScopedRepository` would otherwise say "Delivery not found.",
 * "Event not found.", "Endpoint not found." and "Subscription not found." for
 * four ids in the same request, so a caller probing
 * `POST /deliveries/:id/replay` with ids scraped from elsewhere could tell
 * which KIND of resource each id names - and a 404 that identifies what an id
 * is confirms that it is live infrastructure belonging to another customer.
 *
 * Only `not_found` is rewritten. The distinctions that are genuinely useful
 * inside the tenant - a deleted endpoint, a routing over the cap, an event that
 * was never delivered anywhere - are different codes with different messages
 * and survive untouched.
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
