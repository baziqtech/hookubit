import { ApiProperty } from '@nestjs/swagger';
import { WebhookSubscription } from '@prisma/client';

/**
 * The wire shape of a subscription.
 *
 * Built by an explicit mapper rather than by returning the Prisma row, so a
 * column added to `webhook_subscriptions` later cannot appear in a
 * customer-facing response because nobody thought about it.
 *
 * `event_types` is returned VERBATIM - the same array that was stored, which is
 * the same array that was sent. This response is the thing a customer reads to
 * answer "what does this subscription receive?", and it was Convoy answering
 * that question wrongly (a filtered subscription reading back as `["*"]`) that
 * started this project. Nothing in this file sorts, de-duplicates, defaults or
 * otherwise touches the array.
 */
export class SubscriptionDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty() endpoint_id!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;

  @ApiProperty({
    type: [String],
    description: 'Exactly as stored. Never rewritten, never widened, never defaulted.',
  })
  event_types!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'The stored JSON predicate, or null. NOT YET EVALUATED by the data plane: a subscription ' +
      'with a payload filter currently behaves as if this were null.',
  })
  payload_filter!: Record<string, unknown> | null;

  @ApiProperty({ description: 'A disabled subscription matches no events at all.' })
  enabled!: boolean;

  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

/**
 * THE list envelope, and it is the same three fields on every list route in
 * this API - `{ data, has_more, next_offset }`. Nothing else.
 *
 * `has_more` is the load-bearing field: it is the whole reason
 * `ScopedRepository.findMany` now throws rather than silently truncating, and a
 * client cannot derive it from a total. There is deliberately NO `total` and no
 * `count`: a total costs a second COUNT query on every list request - real money
 * on `events` and `deliveries` later - and buys the client nothing it needs to
 * page. `next_offset` is `null`, never absent and never `0`, when this page was
 * the last one, so a client branches on exactly one thing.
 */
export class SubscriptionListDto {
  @ApiProperty({ type: [SubscriptionDto] }) data!: SubscriptionDto[];

  @ApiProperty({ description: 'More subscriptions match than this page carries.' })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Pass back as `offset` for the next page. Null when this page was the last.',
  })
  next_offset!: number | null;
}

/**
 * `payload_filter` is `Json?`, so Prisma types it as `JsonValue` - which
 * includes arrays, scalars and the JSON value `null`. The column can only hold
 * an object or SQL NULL (`rejectPayloadFilter` refuses everything else), but
 * the row could have been written by an earlier migration or by hand, and a
 * response mapper that assumed otherwise would throw on read and make the
 * subscription unreadable in the UI - the worst moment to lose the operator
 * surface being the moment something is already wrong.
 */
function payloadFilter(value: WebhookSubscription['payloadFilter']): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toSubscriptionDto(subscription: WebhookSubscription): SubscriptionDto {
  return {
    id: subscription.id,
    project_id: subscription.projectId,
    endpoint_id: subscription.endpointId,
    name: subscription.name ?? null,
    // A defensive copy: the caller must not be able to mutate the array the
    // Prisma row is still holding.
    event_types: [...subscription.eventTypes],
    payload_filter: payloadFilter(subscription.payloadFilter),
    enabled: subscription.enabled,
    created_at: new Date(subscription.createdAt).toISOString(),
    updated_at: new Date(subscription.updatedAt).toISOString(),
  };
}
