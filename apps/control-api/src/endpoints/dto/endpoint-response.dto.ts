import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Endpoint, EndpointStatus } from '@prisma/client';

/**
 * The wire shape of an endpoint.
 *
 * Built by an explicit mapper rather than by returning the Prisma row, so a
 * column added to `endpoints` later cannot appear in a customer-facing response
 * because nobody thought about it. `endpoints` has no secret column today; the
 * signing secrets live in `endpoint_secrets` behind `endpoint-secrets.read`,
 * which is owner/admin only and deliberately NOT implied by `endpoints.read`.
 */
export class EndpointDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['active', 'paused', 'disabled', 'deleted'] }) status!: EndpointStatus;
  @ApiProperty({ description: 'Operator intent. The circuit breaker uses `status` instead.' })
  enabled!: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'Set by the circuit breaker.' })
  disabled_reason!: string | null;
  @ApiPropertyOptional({ nullable: true }) disabled_at!: string | null;
  @ApiProperty() timeout_ms!: number;
  @ApiProperty() max_concurrency!: number;
  @ApiPropertyOptional({ nullable: true }) rate_limit!: number | null;
  @ApiProperty() rate_limit_window_seconds!: number;
  @ApiPropertyOptional({ nullable: true }) retry_policy_id!: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' }, nullable: true })
  custom_headers!: Record<string, string> | null;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

export class CreatedEndpointDto extends EndpointDto {
  @ApiPropertyOptional({
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

export class EndpointListDto {
  @ApiProperty({ type: [EndpointDto] }) data!: EndpointDto[];
  @ApiProperty({ description: 'More endpoints match than this page carries.' })
  has_more!: boolean;
  @ApiPropertyOptional({ nullable: true, description: '`offset` for the next page, or null.' })
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

export function toEndpointDto(endpoint: Endpoint): EndpointDto {
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
    created_at: new Date(endpoint.createdAt).toISOString(),
    updated_at: new Date(endpoint.updatedAt).toISOString(),
  };
}
