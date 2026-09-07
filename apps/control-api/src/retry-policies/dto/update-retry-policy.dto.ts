import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateRetryPolicyDto } from './create-retry-policy.dto';

/**
 * Every field optional, same per-field bounds — except `is_default`, which is
 * deliberately NOT patchable.
 *
 * "Exactly one default per project" is a concurrency invariant over a SET of
 * rows, not a property of the row being written: clearing the old default and
 * setting the new one is a read-then-write that two concurrent callers will
 * interleave, and the schema has no partial unique index to catch them. It is
 * therefore held by a SERIALIZABLE transaction in `setDefault`, and the only
 * way to keep that true is to have exactly one code path that writes the
 * column. A patchable `is_default` would be a second one — and the shape of a
 * PATCH ("just set this field") is precisely the shape that skips the clear.
 */
export class UpdateRetryPolicyDto extends PartialType(
  OmitType(CreateRetryPolicyDto, ['is_default'] as const),
) {}
