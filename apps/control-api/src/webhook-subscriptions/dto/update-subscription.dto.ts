import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
} from 'class-validator';
import { MAX_EVENT_TYPES_PER_SUBSCRIPTION } from '../event-type-pattern';
import { MAX_SUBSCRIPTION_NAME_LENGTH } from '../subscription-limits';
import { EventTypesConstraint, PayloadFilterConstraint } from './create-subscription.dto';

/**
 * Written out rather than `PartialType(CreateSubscriptionDto)`, for two reasons
 * that both bite in the same place.
 *
 * 1. `enabled` must NOT be here. Enabling and disabling have their own routes,
 *    so that pausing a subscription is a distinct, separately auditable act
 *    with its own audit action, rather than a field that rides along in a PATCH
 *    that was really about renaming something. `PartialType` would have carried
 *    it in, and `forbidNonWhitelisted` then turns a body containing `enabled`
 *    into a 400 that names the right route.
 * 2. `PartialType` applies `@IsOptional()`, and `@IsOptional()` in
 *    class-validator skips every other validator when the value is `null` as
 *    well as when it is `undefined`. For `name` and `payload_filter` that is
 *    exactly right - null CLEARS them. For `event_types` it would be a hole:
 *    `{"event_types": null}` would walk past `EventTypesConstraint` and reach
 *    the service. The service asserts it again for that reason (see
 *    `assertEventTypes`), and this file does not pretend the DTO is the only
 *    line of defence.
 *
 * Every field is optional; an empty body is a no-op that returns the current
 * row rather than an error.
 */
export class UpdateSubscriptionDto {
  @ApiPropertyOptional({
    maxLength: MAX_SUBSCRIPTION_NAME_LENGTH,
    nullable: true,
    description: 'Null clears the name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUBSCRIPTION_NAME_LENGTH)
  name?: string | null;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Re-point this subscription at a different endpoint in the same project. Resolved ' +
      'through the tenant scope; a deleted endpoint is refused.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  endpoint_id?: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: MAX_EVENT_TYPES_PER_SUBSCRIPTION,
    description:
      'Replaces the whole filter - this is not a merge. The same three forms are accepted as ' +
      'on create, and the same refusals apply: an invalid pattern is a 400, never a silent ' +
      'widening to "*", and an empty array is refused.',
  })
  @IsOptional()
  @IsArray()
  @Validate(EventTypesConstraint)
  event_types?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Replaces the whole predicate. Null removes it. See the create DTO.',
  })
  @IsOptional()
  @Validate(PayloadFilterConstraint)
  payload_filter?: Record<string, unknown> | null;
}

/** The reason a subscription was paused, for the audit log. */
export class DisableSubscriptionDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Recorded in the audit log so the delivery gap this creates can be explained later.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
