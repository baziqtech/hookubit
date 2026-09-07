import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary, not two. See `projects/not-found.ts` for the argument;
 * this is the same three lines because the alternative is one module importing
 * another module's internals to save them, which is a worse dependency than a
 * duplicated try/catch.
 *
 * `ScopedRepository.notFound()` for this table says "API key not found." That is
 * not an oracle - it is only ever reached for a key id inside an
 * already-resolved project, where absent and foreign produce the identical
 * string - but it is a SECOND vocabulary, and `endpoints`/`endpoint-secrets`
 * already answer with `CROSS_TENANT_MESSAGE`. Eight modules are still to be
 * written against whatever idiom they find here.
 *
 * Only `not_found` is rewritten. The distinctions that are genuinely useful
 * inside the tenant - an expiry in the past, a scope the caller does not hold,
 * a ceiling reached - are different codes and different messages, and they all
 * survive untouched.
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
