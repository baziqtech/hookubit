import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  MAX_EVENT_TYPES_PER_SUBSCRIPTION,
  MAX_EVENT_TYPE_LENGTH,
  rejectEventTypes,
} from '../event-type-pattern';
import { PAYLOAD_FILTER_LIMITS, rejectPayloadFilter } from '../payload-filter';
import { MAX_SUBSCRIPTION_NAME_LENGTH } from '../subscription-limits';

/**
 * The event-type filter, checked at the DTO edge so the caller is told their
 * pattern is unusable in the same 400 that would have told them the name is too
 * long.
 *
 * The service asserts the same thing again before writing. That is deliberate
 * duplication, not belt-and-braces theatre: the DTO is only reached over HTTP,
 * and a filter that is silently wrong is the single failure this module exists
 * to prevent. The rule must hold for a service called from a job, a CLI or a
 * test as well.
 */
@ValidatorConstraint({ name: 'eventTypePatterns', async: false })
export class EventTypesConstraint implements ValidatorConstraintInterface {
  private reason = 'is not a valid event-type filter';

  validate(value: unknown): boolean {
    const rejection = rejectEventTypes(value);
    if (!rejection) return true;
    this.reason = rejection;
    return false;
  }

  defaultMessage(): string {
    return this.reason;
  }
}

/** Shape and size of the JSON payload predicate. See `payload-filter.ts`. */
@ValidatorConstraint({ name: 'payloadFilterShape', async: false })
export class PayloadFilterConstraint implements ValidatorConstraintInterface {
  private reason = 'is not a valid payload filter';

  validate(value: unknown): boolean {
    const rejection = rejectPayloadFilter(value);
    if (!rejection) return true;
    this.reason = rejection;
    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property}: ${this.reason}`;
  }
}

export class CreateSubscriptionDto {
  @ApiPropertyOptional({
    maxLength: MAX_SUBSCRIPTION_NAME_LENGTH,
    nullable: true,
    example: 'Finance ledger - settlements only',
    description: 'For humans reading the subscription list. Optional; the column is nullable.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUBSCRIPTION_NAME_LENGTH)
  name?: string | null;

  @ApiProperty({
    maxLength: 64,
    example: 'ep_01J8ZK...',
    description:
      'An endpoint in THIS project. Resolved through the tenant scope, so an id belonging to ' +
      'another customer answers 404 with the same message as an id that does not exist.',
  })
  @IsString()
  @MaxLength(64)
  endpoint_id!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_EVENT_TYPES_PER_SUBSCRIPTION,
    example: ['payment.settled', 'payment.failed'],
    description:
      'The event types this subscription receives. Exactly three forms are accepted, and they ' +
      'are the three the router implements: "*" (everything), "payment.*" (every type ' +
      'beginning with the literal "payment.", so NOT "payments.settled" and NOT "payment"), ' +
      'and an exact type. Anything else is REFUSED - never widened to "*", never stored as ' +
      'something the router would read differently. An empty array is refused too: it would ' +
      'match no events at all. "*" may not appear alongside other patterns.',
  })
  @IsArray()
  @Validate(EventTypesConstraint)
  event_types!: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { 'data.currency': 'GHS', 'data.amount': { $gte: 1000 } },
    description:
      'A JSON predicate applied to the event body after the event-type filter matches. ' +
      'Implicit AND over field paths; $and/$or/$not combine filters; ' +
      '$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists compare one path. Strict JSON typing, no ' +
      'coercion; an absent path satisfies only {"$exists": false}. Bounded to ' +
      `${PAYLOAD_FILTER_LIMITS.maxBytes} bytes, ${PAYLOAD_FILTER_LIMITS.maxDepth} levels and ` +
      `${PAYLOAD_FILTER_LIMITS.maxNodes} conditions. NOT YET EVALUATED BY THE DATA PLANE - a ` +
      'stored filter is inert until the router implements it. Send null, or omit it, for no ' +
      'body filter; an empty object is refused because it would match everything.',
  })
  @IsOptional()
  @Validate(PayloadFilterConstraint)
  payload_filter?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    default: true,
    description:
      'A disabled subscription never matches - `Match()` skips it before the event-type test. ' +
      'This is how you stop deliveries without touching the filter.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** The event-type ceiling, re-exported so the OpenAPI text and the validator agree. */
export const EVENT_TYPE_LIMITS = {
  maxPatterns: MAX_EVENT_TYPES_PER_SUBSCRIPTION,
  maxPatternLength: MAX_EVENT_TYPE_LENGTH,
} as const;
