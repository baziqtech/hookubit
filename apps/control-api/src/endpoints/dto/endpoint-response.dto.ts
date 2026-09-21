import { ApiProperty } from '@nestjs/swagger';
import { Endpoint, EndpointStatus } from '@prisma/client';

/**
 * The wire shape of an endpoint.
 *
 * Built by an explicit mapper rather than by returning the Prisma row, so a
 * column added to `endpoints` later cannot appear in a customer-facing response
 * because nobody thought about it. `endpoints` has no secret column today; the
 * signing secrets live in `endpoint_secrets` behind `endpoint-secrets.read`,
 * which is owner/admin only and deliberately NOT implied by `endpoints.read`.
 *
 * `has_live_secret` is the one thing about those secrets this shape carries, and
 * it is a bare boolean for that reason. Without it the dashboard offered
 * "Resume deliveries" on every paused endpoint, including the ones a developer
 * had just created - which is the COMMON case, since `endpoint-secrets.*` is
 * owner/admin only, so a developer's endpoint is deliberately left paused with
 * `secret_pending` - and `POST /enable` answered 409 every time. The operator
 * learned that by clicking. Nothing about the secret ITSELF widens: no id, no
 * version, no prefix, no expiry timestamp, because a `viewer` holds
 * `endpoints.read` and holds nothing at all on `endpoint_secrets`.
 */
export class EndpointDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['active', 'paused', 'disabled', 'deleted'] }) status!: EndpointStatus;
  @ApiProperty({ description: 'Operator intent. The circuit breaker uses `status` instead.' })
  enabled!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the PLATFORM disabled this endpoint, as a sentence, starting with `auto-disabled`. ' +
      'Set when the circuit breaker has been open past the configured window; cleared by ' +
      '`POST .../enable`. Null for an endpoint a human paused - that reason is in the audit ' +
      'log - so `status === "disabled" && disabled_reason !== null` is how the two are told apart.',
  })
  disabled_reason!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'When the platform disabled it. Null unless `disabled_reason` is set.',
  })
  disabled_at!: string | null;
  @ApiProperty() timeout_ms!: number;
  @ApiProperty() max_concurrency!: number;
  @ApiProperty({ type: Number, nullable: true }) rate_limit!: number | null;
  @ApiProperty() rate_limit_window_seconds!: number;
  @ApiProperty({ type: String, nullable: true }) retry_policy_id!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, nullable: true })
  custom_headers!: Record<string, string> | null;
  @ApiProperty({
    description:
      'Whether this endpoint has at least one signing secret that is signing RIGHT NOW - ' +
      'one that is active and either has no expiry or has not reached it yet, which is the ' +
      'same test the delivery workers apply when they sign. False means `POST /enable` will ' +
      'refuse with 409: an enabled endpoint with nothing to sign with delivers nothing, ' +
      "because signing fails closed rather than sending an unsigned request. Read a secret's " +
      '`active` flag alone and the two answers disagree for the window between a secret ' +
      'expiring and its flag being swept, which is exactly when an operator is looking.\n\n' +
      'A BOOLEAN, deliberately: no id, version, prefix or expiry. This field is visible to ' +
      'anyone with `endpoints.read` (a viewer included), and reading signing secrets is ' +
      '`endpoint-secrets.read` - owner and admin only.',
    example: true,
  })
  has_live_secret!: boolean;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;

  @ApiProperty({
    type: () => EndpointHealthDto,
    nullable: true,
    description:
      'How this endpoint has been doing, over a fixed trailing hour. Present on the LIST and ' +
      'null on the single-endpoint read.',
  })
  health!: EndpointHealthDto | null;
}

export class CreatedEndpointDto extends EndpointDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The version 1 signing secret, in plaintext, returned HERE AND NOWHERE ELSE. ' +
      'Present only when the caller also holds `endpoint-secrets.write` (owner or admin): ' +
      'a developer may create endpoints but may not read signing secrets, so for them this ' +
      'is null, the endpoint stays paused, and `secret_pending` says so.',
  })
  secret!: string | null;

  @ApiProperty({
    description:
      'True when the endpoint was created with a signing secret this caller may not receive, ' +
      'so it is PAUSED and not delivering. An owner or admin must rotate ' +
      '(POST /v1/endpoints/{id}/secrets/rotate), hand the consumer the plaintext, then enable ' +
      'it. Going live here instead would sign every delivery with a key nobody holds: the ' +
      'consumer would reject all of them, and the rotation that fixed it would change the ' +
      'secret AGAIN - two verification outages instead of none.',
  })
  secret_pending!: boolean;

  @ApiProperty({ description: 'Version of the secret that was minted with this endpoint.' })
  secret_version!: number;
}

/**
 * The canonical list envelope - `{ data, has_more, next_offset }` - and the
 * only one this API returns.
 *
 * `next_offset` is a REQUIRED, nullable number. It was declared with
 * `@ApiPropertyOptional`, which generated a client field that could be absent;
 * it never is, and null is the entire signal for "this was the last page".
 */
export class EndpointListDto {
  @ApiProperty({ type: [EndpointDto] }) data!: EndpointDto[];
  @ApiProperty({ description: 'More endpoints match than this page carries.', example: false })
  has_more!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pass back as `offset` for the next page. NULL - never absent, never 0 - on the last one.',
    example: null,
  })
  next_offset!: number | null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** `custom_headers` is `Json?`, so Prisma types it as `JsonValue`. */
function customHeaders(value: Endpoint['customHeaders']): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * `hasLiveSecret` is a REQUIRED second argument rather than an optional one.
 *
 * The secret state lives in another table, so this mapper cannot derive it, and
 * a default would silently answer for every caller who did not think about it -
 * on a field the dashboard uses to decide whether to offer "Resume deliveries".
 * Stating it forces each call site to say where its answer came from.
 */
/**
 * How this endpoint has been doing, over a fixed trailing hour.
 *
 * Present on the LIST, absent on the single-endpoint read — the list is where
 * "which of these is the problem?" is asked, and computing it for one endpoint
 * that the caller is already looking at adds a query to answer a question they
 * did not ask.
 */
export class EndpointHealthDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Successes over SETTLED deliveries in the last hour. NULL, never 0, when nothing settled — ' +
      'an endpoint with no traffic reads "no data", and 0 means every delivery we attempted ' +
      'failed. Rendering the null as 0% turns a new endpoint into an outage.',
  })
  success_rate_1h!: number | null;

  @ApiProperty({ description: 'Deliveries created in the last hour. Context for the rate.' })
  deliveries_1h!: number;

  @ApiProperty({
    description:
      'Created and still moving, at ANY age — not hour-bounded, because "what is queued behind ' +
      'this problem?" is not a question about the last hour.',
  })
  deliveries_waiting!: number;

  @ApiProperty({ description: 'From the circuit breaker. Zero when it has not been failing.' })
  consecutive_failures!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'When the breaker opened. Null when it is not open.',
  })
  opened_at!: string | null;

  @ApiProperty({ type: String, nullable: true })
  last_delivery_at!: string | null;
}

export function toEndpointDto(
  endpoint: Endpoint,
  hasLiveSecret: boolean,
  health?: EndpointHealthDto,
): EndpointDto {
  return {
    id: endpoint.id,
    project_id: endpoint.projectId,
    name: endpoint.name,
    url: endpoint.url,
    description: endpoint.description ?? null,
    status: endpoint.status,
    enabled: endpoint.enabled,
    disabled_reason: endpoint.disabledReason ?? null,
    disabled_at: iso(endpoint.disabledAt),
    timeout_ms: endpoint.timeoutMs,
    max_concurrency: endpoint.maxConcurrency,
    rate_limit: endpoint.rateLimit ?? null,
    rate_limit_window_seconds: endpoint.rateLimitWindowSeconds,
    retry_policy_id: endpoint.retryPolicyId ?? null,
    custom_headers: customHeaders(endpoint.customHeaders),
    has_live_secret: hasLiveSecret,
    created_at: new Date(endpoint.createdAt).toISOString(),
    updated_at: new Date(endpoint.updatedAt).toISOString(),
    health: health ?? null,
  };
}
