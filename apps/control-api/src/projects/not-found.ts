import { CROSS_TENANT_MESSAGE } from '../authz';
import { AppError } from '../common/errors';

/**
 * One 404 vocabulary, not two.
 *
 * `ScopedRepository.notFound()` says "Project not found."; `TenantResolver` says
 * `CROSS_TENANT_MESSAGE` ("Resource not found."). Neither string is an oracle on
 * its own - a per-resource message is only ever emitted for an id inside an
 * already-resolved tenant, where "absent" and "belongs to someone else" produce
 * the identical string - but two vocabularies in one API is a trap for the eight
 * modules still to be written: the first person to add a message that IS
 * specific to "exists but is not yours" will not notice they have broken the
 * invariant, because the codebase already reads as if per-resource messages are
 * fine.
 *
 * `endpoints` and `endpoint-secrets` already answer with `CROSS_TENANT_MESSAGE`
 * throughout. This aligns projects with them.
 *
 * Nothing is lost by the alignment: the only distinction the repository message
 * carried was the resource TYPE, which the route the caller just addressed
 * already states. A distinction that is genuinely useful inside the tenant - a
 * conflict, a validation failure, a rule the caller can act on - is a different
 * error code and is untouched here; only `not_found` is rewritten.
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
