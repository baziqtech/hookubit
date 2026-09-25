import { ApiProperty } from '@nestjs/swagger';
import { Delivery, DeliveryAttempt, DeliveryStatus, Endpoint, Event } from '@prisma/client';
import { PAYLOAD_PREVIEW_MAX_CHARS, PayloadPreview } from '../../events/event-payload';
import { HEADER_REDACTED, isRedactedRequestHeader } from '../delivery-limits';

/** ISO-8601, or null. One helper so nine nullable timestamps read the same. */
function iso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/**
 * A `Json?` column rendered as a header map.
 *
 * Prisma types it as `JsonValue`, which includes arrays, scalars and the JSON
 * value `null`. The data plane only ever writes an object of string values, but
 * the row could have been written by an earlier build or by hand, and a mapper
 * that assumed otherwise would throw on read - making the delivery unreadable
 * in the UI at exactly the moment something is already wrong.
 */
function headerMap(
  value: unknown,
  redact: boolean,
): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    if (redact && isRedactedRequestHeader(name)) {
      out[name] = HEADER_REDACTED;
      continue;
    }
    out[name] = typeof header === 'string' ? header : JSON.stringify(header);
  }
  return out;
}

/**
 * One attempt. This is the row `ARCHITECTURE.md 33` specifies, on the wire.
 *
 * `delivery_attempts` is APPEND-ONLY: nothing in the control plane updates a
 * completed attempt, and nothing here presents a derived or recomputed value.
 * Everything below is what the worker recorded at the time.
 */
export class DeliveryAttemptDto {
  @ApiProperty() id!: string;
  @ApiProperty() delivery_id!: string;

  @ApiProperty({ description: '1-based, and unique per delivery.' })
  attempt_number!: number;

  @ApiProperty({
    enum: ['success', 'failure', 'timeout', 'error'],
    description:
      '`failure` means the endpoint answered and we disliked the answer; `timeout`/`error` mean ' +
      'we never got one. The distinction is the first thing to look at.',
  })
  status!: string;

  @ApiProperty({ type: Number, nullable: true }) http_status!: number | null;
  @ApiProperty() started_at!: string;
  @ApiProperty({ type: String, nullable: true }) completed_at!: string | null;
  @ApiProperty({ type: Number, nullable: true }) duration_ms!: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description:
      'What we sent. Credential-shaped header VALUES are replaced with `[redacted]` - the key ' +
      'stays, so "did we send Authorization?" is still answerable. The signature header is NOT ' +
      'redacted: it is an HMAC over the payload, not the key, and it is what a consumer compares ' +
      'against when verification fails.',
  })
  request_headers!: Record<string, string> | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
  })
  response_headers!: Record<string, string> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Truncated by the worker to EGRESS_MAX_RESPONSE_BYTES.',
  })
  response_body!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set instead of `response_body` when the response was too large to inline.',
  })
  response_body_location!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Bytes the endpoint sent, BEFORE truncation. Compare with `response_body`.',
  })
  response_size!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Low-cardinality classification derived from the error TYPE, never its message: ' +
      '`timeout`, `dns`, `connection`, `transport`, `blocked_target`, `signing_failed`, ' +
      '`payload_unavailable`, `permanent`, or `http_<status>`.',
  })
  error_code!: string | null;

  @ApiProperty({ type: String, nullable: true }) error_message!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Which worker made this attempt. Useful when one replica is misbehaving.',
  })
  worker_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The 32-hex trace id of the span for THIS attempt - the seam between this ledger and the ' +
      'trace backend. The worker writes it only when that span was actually sampled, so null ' +
      'honestly means "no trace was kept for this attempt": not that tracing is broken, and not ' +
      'a link worth rendering. Each attempt has its own trace; the retry chain is reassembled ' +
      'by querying the backend for `webhook.delivery.id`, not by walking a span tree.',
  })
  trace_id!: string | null;

  @ApiProperty() created_at!: string;
}

export function toAttemptDto(attempt: DeliveryAttempt): DeliveryAttemptDto {
  return {
    id: attempt.id,
    delivery_id: attempt.deliveryId,
    attempt_number: attempt.attemptNumber,
    status: attempt.status,
    http_status: attempt.httpStatus ?? null,
    started_at: new Date(attempt.startedAt).toISOString(),
    completed_at: iso(attempt.completedAt),
    duration_ms: attempt.durationMs ?? null,
    request_headers: headerMap(attempt.requestHeaders, true),
    response_headers: headerMap(attempt.responseHeaders, false),
    response_body: attempt.responseBody ?? null,
    response_body_location: attempt.responseBodyLocation ?? null,
    response_size: attempt.responseSize ?? null,
    error_code: attempt.errorCode ?? null,
    error_message: attempt.errorMessage ?? null,
    worker_id: attempt.workerId ?? null,
    trace_id: attempt.traceId ?? null,
    created_at: new Date(attempt.createdAt).toISOString(),
  };
}

/**
 * One delivery: one event, one endpoint, one retry chain of its own.
 *
 * The materialised routing is what makes this row exist - a published event
 * becomes N of these, each with an independent lifecycle - and it is what makes
 * "did finance ever receive this?" answerable at all.
 */
export class DeliveryDto {
  @ApiProperty() id!: string;
  @ApiProperty() event_id!: string;
  @ApiProperty() endpoint_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The subscription that matched. Null on a replay whose subscription has since been ' +
      'deleted - the provenance of that replay is `replay_of_delivery_id`, which never goes away.',
  })
  subscription_id!: string | null;

  @ApiProperty() project_id!: string;

  @ApiProperty({
    enum: [
      'pending',
      'scheduled',
      'queued',
      'processing',
      'succeeded',
      'failed',
      'retrying',
      'exhausted',
      'cancelled',
    ],
  })
  status!: DeliveryStatus;

  @ApiProperty({ description: 'Whether any further attempt will ever be made.' })
  terminal!: boolean;

  @ApiProperty() attempt_count!: number;
  @ApiProperty() max_attempts!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When the next attempt is due. Always set - the column is NOT NULL and defaults to the ' +
      'insert time, so a fresh delivery is due immediately. Read it together with `terminal`: ' +
      'a terminal delivery still carries the time of its last transition here and nothing will ' +
      'ever act on it. Nullable in the contract only so a client never has to change shape.',
  })
  next_attempt_at!: string | null;

  @ApiProperty({ type: String, nullable: true }) last_attempt_at!: string | null;
  @ApiProperty({ type: String, nullable: true }) completed_at!: string | null;
  @ApiProperty({ type: String, nullable: true }) ordering_key!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The last failure, as the worker phrased it. The full history is in `attempts`.',
  })
  last_error!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The worker holding this delivery, and until when. A row stuck in `processing` whose ' +
      '`locked_until` is in the past is a crashed worker; the scheduler reclaims it.',
  })
  locked_by!: string | null;

  @ApiProperty({ type: String, nullable: true }) locked_until!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The delivery this one replays. Set on every replay and never on an original, which is ' +
      'what the partial unique index `deliveries_event_endpoint_original_key` relies on.',
  })
  replay_of_delivery_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The user id that asked for the replay. Null on originals.',
  })
  replayed_by!: string | null;

  @ApiProperty({ description: 'Shorthand for `replay_of_delivery_id !== null`.' })
  is_replay!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When retention deleted this delivery`s per-attempt detail. Null means the attempt ' +
      'history is still here.\n\n' +
      'Read it before you read `attempts`. Past the attempt horizon the platform reclaims the ' +
      'request/response headers and bodies - which is where the bytes are - while keeping this ' +
      'summary row for much longer. Without this field a pruned delivery reads `attempt_count: ' +
      '5` next to an empty attempt list, which is indistinguishable from "the platform never ' +
      'tried"; with it, the answer is "we tried five times and the detail was reclaimed on this ' +
      'date".',
  })
  attempts_pruned_at!: string | null;

  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

const TERMINAL_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  DeliveryStatus.succeeded,
  DeliveryStatus.failed,
  DeliveryStatus.exhausted,
  DeliveryStatus.cancelled,
]);

/**
 * Mirrors `State.Terminal()` in services/data-plane/internal/worker/state.go -
 * and, since it is the same four statuses, `retention.TerminalStatuses` and the
 * predicates of `deliveries_retention_idx` and `deliveries_attempt_pruning_idx`.
 * A delivery this returns true for is one the retention sweep may eventually
 * prune; one it returns false for is never touched, however old.
 */
export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function toDeliveryDto(delivery: Delivery): DeliveryDto {
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    endpoint_id: delivery.endpointId,
    subscription_id: delivery.subscriptionId ?? null,
    project_id: delivery.projectId,
    status: delivery.status,
    terminal: isTerminal(delivery.status),
    attempt_count: delivery.attemptCount,
    max_attempts: delivery.maxAttempts,
    next_attempt_at: iso(delivery.nextAttemptAt),
    last_attempt_at: iso(delivery.lastAttemptAt),
    completed_at: iso(delivery.completedAt),
    ordering_key: delivery.orderingKey ?? null,
    last_error: delivery.lastError ?? null,
    locked_by: delivery.lockedBy ?? null,
    locked_until: iso(delivery.lockedUntil),
    replay_of_delivery_id: delivery.replayOfDeliveryId ?? null,
    replayed_by: delivery.replayedBy ?? null,
    is_replay: delivery.replayOfDeliveryId !== null && delivery.replayOfDeliveryId !== undefined,
    attempts_pruned_at: iso(delivery.attemptsPrunedAt),
    created_at: new Date(delivery.createdAt).toISOString(),
    updated_at: new Date(delivery.updatedAt).toISOString(),
  };
}

/**
 * A delivery AS A LIST ROW: the delivery, plus a bounded look at the body.
 *
 * Separate from `DeliveryDto` on purpose. These three fields are only honest
 * where they were actually read - `GET /deliveries`, `GET /events/:id/deliveries`
 * - and a `payload_preview: null` on a response that never looked at
 * `payload_raw` (a replay result, the detail route) would read as "this payload
 * is unavailable", which is the one thing null is supposed to mean. The detail
 * route serves the exact bytes under `GET /events/:id/payload` instead, and has
 * no use for a truncated copy.
 */
export class DeliveryListItemDto extends DeliveryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The first ' +
      String(PAYLOAD_PREVIEW_MAX_CHARS) +
      ' characters of the event body, decoded as UTF-8. A PREVIEW, and three ' +
      'things follow from that.\n\n' +
      '**It is not what was signed.** The signature a consumer verifies is an HMAC over the ' +
      'WHOLE body; hashing this string will not reproduce it, and a signature investigation ' +
      'belongs on `GET /events/:id/payload`, which serves the exact bytes.\n\n' +
      '**It is cut by character count, not at a structural boundary**, so it is very often ' +
      'invalid JSON - a truncated string literal, an unclosed brace. Render it as text. ' +
      '`payload_truncated` says whether anything was cut.\n\n' +
      '**Null is not "empty body".** It means no preview could be produced: the payload ' +
      'exceeded the inline threshold and lives in object storage (this API has no ' +
      'object-storage client and will not fetch 200 objects to draw a column), retention has ' +
      'reclaimed the bytes, or they are not valid UTF-8 - a gzipped or binary body, which would ' +
      'decode to replacement characters that look like data. `payload_size` is populated in all ' +
      'three cases; an empty body gives `""`, not null.',
  })
  payload_preview!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Bytes of the WHOLE body (`events.payload_size`), not of `payload_preview`. Recorded at ' +
      'ingest, so it is the real size even when the preview is null. Null only when the event ' +
      'row itself could not be read.',
  })
  payload_size!: number | null;

  @ApiProperty({
    description:
      'True when the body continues past `payload_preview`. FALSE whenever `payload_preview` is ' +
      'null - there is no preview for the body to be longer than, and a client that rendered an ' +
      'ellipsis after nothing would be inventing content. Read `payload_size` for how big the ' +
      'body is.',
  })
  payload_truncated!: boolean;
}

/**
 * A list row: the delivery, plus whatever preview the payload allowed.
 *
 * `preview` is passed in rather than read here: it comes from ONE companion
 * query over the page's distinct event ids (see `DeliveriesService.list`), and a
 * mapper that fetched per row would be the N+1 this design exists to avoid.
 */
export function toDeliveryListItemDto(
  delivery: Delivery,
  preview: PayloadPreview,
): DeliveryListItemDto {
  return {
    ...toDeliveryDto(delivery),
    payload_preview: preview.preview,
    payload_size: preview.size,
    payload_truncated: preview.truncated,
  };
}

/**
 * Enough of the event and the endpoint to stop the reader opening two more
 * tabs. A delivery row on its own says "del_x failed against ep_y", which is
 * not an answer to any question a human has at 2am.
 */
export class DeliveryEventRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() event_type!: string;
  @ApiProperty({ type: String, nullable: true }) idempotency_key!: string | null;
  @ApiProperty() created_at!: string;
}

export class DeliveryEndpointRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;

  @ApiProperty({
    enum: ['active', 'paused', 'disabled', 'deleted'],
    description:
      'The endpoint as it is NOW, not as it was when this delivery was made. A `deleted` or ' +
      '`disabled` endpoint here is why a replay of this delivery will be refused.',
  })
  status!: string;

  @ApiProperty({ type: String, nullable: true }) disabled_reason!: string | null;
}

/**
 * `GET /deliveries/:id` - the response the whole module exists for.
 *
 * Everything needed to answer "what happened to this?" without a second
 * request: the delivery, the event it came from, the endpoint as it stands now,
 * and the complete attempt history in order.
 */
export class DeliveryDetailDto extends DeliveryDto {
  @ApiProperty({ type: DeliveryEventRefDto }) event!: DeliveryEventRefDto;
  @ApiProperty({ type: DeliveryEndpointRefDto }) endpoint!: DeliveryEndpointRefDto;

  @ApiProperty({
    type: [DeliveryAttemptDto],
    description: 'Ascending by `attempt_number`. Append-only; nothing here is ever rewritten.',
  })
  attempts!: DeliveryAttemptDto[];

  @ApiProperty({
    description:
      'True when this delivery has more attempts than the inline cap. Page the rest from ' +
      '`GET /deliveries/:id/attempts`.',
  })
  attempts_truncated!: boolean;
}

export function toEventRef(event: Event): DeliveryEventRefDto {
  return {
    id: event.id,
    event_type: event.eventType,
    idempotency_key: event.idempotencyKey ?? null,
    created_at: new Date(event.createdAt).toISOString(),
  };
}

export function toEndpointRef(endpoint: Endpoint): DeliveryEndpointRefDto {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    status: endpoint.status,
    disabled_reason: endpoint.disabledReason ?? null,
  };
}

/**
 * THE list envelope - the same three fields as every other list route in this
 * API. See `SubscriptionListDto` for why there is no `total`; on `deliveries`,
 * the largest table in the system, a COUNT on every list request is not a
 * theoretical cost.
 */
export class DeliveryListDto {
  @ApiProperty({ type: [DeliveryListItemDto] }) data!: DeliveryListItemDto[];
  @ApiProperty() has_more!: boolean;
  @ApiProperty({ type: Number, nullable: true }) next_offset!: number | null;
}

export class DeliveryAttemptListDto {
  @ApiProperty({ type: [DeliveryAttemptDto] }) data!: DeliveryAttemptDto[];
  @ApiProperty() has_more!: boolean;
  @ApiProperty({ type: Number, nullable: true }) next_offset!: number | null;
}

/**
 * What a replay produced.
 *
 * Deliberately NOT the `{ data, has_more, next_offset }` list envelope: this is
 * not a page of an existing collection and there is nothing to page. Naming the
 * field `deliveries` rather than `data` keeps a client from writing a paging
 * loop against a response that will never have a second page.
 */
export class ReplayResultDto {
  @ApiProperty({
    type: [DeliveryDto],
    description:
      'The NEW delivery rows. Every one carries `replay_of_delivery_id`; no original was ' +
      'touched.',
  })
  deliveries!: DeliveryDto[];

  @ApiProperty() replayed_count!: number;

  @ApiProperty({
    type: [String],
    description: 'The original delivery ids these replay, in the same order.',
  })
  replay_of!: string[];
}
