import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary, not three. Same three lines as `api-keys/not-found.ts`
 * and `projects/not-found.ts`, for the reason given there: the alternative is
 * one module importing another module's internals to save them.
 *
 * This module is the one where it matters most, because a subscription write
 * touches TWO tables. `ScopedRepository` says "Subscription not found." for the
 * subscription id and "Endpoint not found." for the caller-supplied
 * `endpoint_id` - and the second string is the interesting one. Left alone, a
 * caller probing `POST /subscriptions` with ids scraped from elsewhere could
 * tell "that endpoint id is not yours" apart from "that subscription id is not
 * yours", and a 404 that distinguishes what an id IS confirms the id is live
 * infrastructure belonging to another customer.
 *
 * Only `not_found` is rewritten. The distinctions that are genuinely useful
 * inside the tenant - a deleted endpoint, a ceiling reached, an invalid pattern
 * - are different codes with different messages and survive untouched.
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
