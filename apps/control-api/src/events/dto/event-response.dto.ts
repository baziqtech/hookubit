import { ApiProperty } from '@nestjs/swagger';
import { Event, EventStatus } from '@prisma/client';
import { HEADER_REDACTED, isRedactedRequestHeader } from '../../deliveries/delivery-limits';
import { PayloadEncoding, PayloadSource, renderPayload } from '../event-payload';

function iso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/**
 * The ingest request's headers, with credential-shaped VALUES removed.
 *
 * `events.headers` is what arrived on the ingest call, and what arrived
 * includes the `Authorization` header carrying the project's own API key.
 * `events.read` is held by `viewer`, while `api-keys.read` is not - so
 * rendering this map verbatim would hand a viewer a live ingest credential
 * through the events screen. The key stays so "what did the producer send?" is
 * still answerable.
 */
function safeHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    out[name] = isRedactedRequestHeader(name)
      ? HEADER_REDACTED
      : typeof header === 'string'
        ? header
        : JSON.stringify(header);
  }
  return out;
}

/**
 * An event, WITHOUT its payload.
 *
 * The payload is deliberately absent from the list shape. `events` is the
 * largest table in the system and its rows are raw webhook bodies; a listing
 * that inlined them would move megabytes per page, and no list screen renders
 * them. `payload_size` and `payload_hash` are here so a listing can still say
 * how big it was and whether two events carry identical bytes.
 */
export class EventDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty() event_type!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The idempotency key the producer published this event with, if any. Publishing again ' +
      'with the same key in the same project resolves to this event instead of creating another.',
  })
  idempotency_key!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opt-in serialisation key, carried onto every delivery this event fanned out to. It is ' +
      'accepted and stored today so it is already in place when per-key ordering is enforced, ' +
      'but per-key ordering is NOT yet enforced: this field currently guarantees nothing about ' +
      'delivery order.',
  })
  ordering_key!: string | null;

  @ApiProperty({
    enum: ['received', 'processing', 'processed', 'failed'],
    description:
      'The INGEST/fan-out state, not a delivery outcome. `processed` means the fan-out ' +
      'committed, which says nothing about whether any endpoint accepted it - that is what the ' +
      'deliveries are for.',
  })
  status!: EventStatus;

  @ApiProperty({ description: 'Bytes of the authoritative payload as received.' })
  payload_size!: number;

  @ApiProperty({ description: 'SHA-256 of the authoritative raw bytes, lowercase hex.' })
  payload_hash!: string;

  @ApiProperty({
    description: 'False when the raw bytes are not in the database (offloaded, or aged out).',
  })
  payload_inline!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`s3://bucket/key` when the payload was too large to store inline.',
  })
  payload_location!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description: 'Ingest request headers. Credential-shaped values are `[redacted]`.',
  })
  headers!: Record<string, string> | null;

  @ApiProperty() created_at!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'When the fan-out first committed. Null until it has.',
  })
  processed_at!: string | null;
}

export function toEventDto(event: Event): EventDto {
  return {
    id: event.id,
    project_id: event.projectId,
    event_type: event.eventType,
    idempotency_key: event.idempotencyKey ?? null,
    ordering_key: event.orderingKey ?? null,
    status: event.status,
    payload_size: event.payloadSize,
    payload_hash: event.payloadHash,
    payload_inline: event.payloadRaw !== null && event.payloadRaw !== undefined,
    payload_location: event.payloadLocation ?? null,
    headers: safeHeaders(event.headers),
    created_at: new Date(event.createdAt).toISOString(),
    processed_at: iso(event.processedAt),
  };
}

/**
 * The payload, with the raw/jsonb distinction on the wire rather than in a
 * comment. See `event-payload.ts` for why this shape exists at all.
 */
export class EventPayloadDto {
  @ApiProperty({
    enum: ['inline', 'object_storage', 'unavailable'],
    description:
      'Where the authoritative bytes are. `body` is non-null only for `inline`; the other two ' +
      'are told, not disguised as an empty payload.',
  })
  source!: PayloadSource;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'THE DELIVERED BYTES, decoded. This is what was signed.',
  })
  body!: string | null;

  @ApiProperty({
    enum: ['utf-8', 'base64'],
    nullable: true,
    description:
      '`base64` when the payload is not valid UTF-8. Checked by re-encoding, so a binary body ' +
      'is never rendered as replacement characters that look like data.',
  })
  encoding!: PayloadEncoding | null;

  @ApiProperty({ type: String, nullable: true }) location!: string | null;

  @ApiProperty({ description: 'Bytes as received. Meaningful even when `body` is null.' })
  size_bytes!: number;

  @ApiProperty({ description: 'SHA-256 of the authoritative bytes, lowercase hex.' })
  sha256!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'THE JSONB COPY. For filtering, search and display convenience only. NOT what was ' +
      'delivered: PostgreSQL normalises jsonb, so key order, whitespace and duplicate keys ' +
      'differ from the bytes that were signed. Never verify a signature against this.',
  })
  normalised_json!: unknown;

  @ApiProperty({ description: 'Says the above in a sentence, for whoever is reading the JSON.' })
  notice!: string;
}

/** `GET /events/:id`. The list shape plus the payload. */
export class EventDetailDto extends EventDto {
  @ApiProperty({ type: EventPayloadDto }) payload!: EventPayloadDto;
}

export function toEventDetailDto(event: Event): EventDetailDto {
  const rendered = renderPayload({
    payloadRaw: event.payloadRaw ?? null,
    payloadLocation: event.payloadLocation ?? null,
  });
  return {
    ...toEventDto(event),
    payload: {
      source: rendered.source,
      body: rendered.body,
      encoding: rendered.encoding,
      location: rendered.location,
      size_bytes: event.payloadSize,
      sha256: event.payloadHash,
      // `payload` is `Json?`; `undefined` is not valid JSON on the wire, so an
      // absent column becomes an explicit null.
      normalised_json: event.payload ?? null,
      notice: rendered.notice,
    },
  };
}

/** THE list envelope. Three fields, the same three as every other list route. */
export class EventListDto {
  @ApiProperty({ type: [EventDto] }) data!: EventDto[];
  @ApiProperty() has_more!: boolean;
  @ApiProperty({ type: Number, nullable: true }) next_offset!: number | null;
}
