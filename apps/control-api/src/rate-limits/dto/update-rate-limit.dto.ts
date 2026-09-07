import { PartialType } from '@nestjs/swagger';
import { CreateRateLimitDto } from './create-rate-limit.dto';

/**
 * Every field optional, same bounds — `scope` and `resource_id` included.
 *
 * Those two are the row's IDENTITY (the unique index is
 * `(project_id, scope, resource_id)`), so patching them is a re-identification
 * and goes through exactly the same resolution and uniqueness path a create
 * does: the new `resource_id` is re-resolved through the scoped repository for
 * the new scope, and the uniqueness check runs on the resulting pair inside the
 * same transaction. Allowing the patch and re-running the checks is safer than
 * the alternative it pushes callers toward — delete then recreate — which has a
 * window in which no limit is in force at all.
 *
 * Note that `resource_id` must be re-stated when `scope` changes: an endpoint id
 * carried over onto `scope: "organization"` would resolve against the wrong
 * table. The service refuses a scope change that leaves a stale non-null
 * `resource_id` unstated.
 */
export class UpdateRateLimitDto extends PartialType(CreateRateLimitDto) {}
