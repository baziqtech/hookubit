import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EndpointSecret } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../authz';
import {
  DEFAULT_OVERLAP_SECONDS,
  MAX_OVERLAP_SECONDS,
  MIN_OVERLAP_SECONDS,
} from '../secret-generator';

/** Paging for the metadata listing. Bounded by the same ceiling the repository clamps to. */
export class ListSecretsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class RotateSecretDto {
  @ApiPropertyOptional({
    minimum: MIN_OVERLAP_SECONDS,
    maximum: MAX_OVERLAP_SECONDS,
    default: DEFAULT_OVERLAP_SECONDS,
    description:
      'How long the CURRENT secrets keep signing alongside the new one. Every active secret ' +
      'produces its own `v1=` component in Webhook-Signature and a consumer that matches any ' +
      'one of them verifies, so this is the window in which consumers can be rolled. 0 stops ' +
      'the old secrets immediately - use it for a leak, not for a routine rotation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_OVERLAP_SECONDS)
  @Max(MAX_OVERLAP_SECONDS)
  overlap_seconds?: number;
}

/**
 * Secret METADATA. There is no field here that could hold a secret, and that is
 * the point: this is the type every read path returns, so a plaintext value has
 * nowhere to leak into even by accident.
 */
export class EndpointSecretDto {
  @ApiProperty() id!: string;
  @ApiProperty() endpoint_id!: string;
  @ApiProperty({ description: 'Monotonic per endpoint. Highest version is the newest.' })
  version!: number;
  @ApiProperty({
    description:
      'Whether this secret currently signs deliveries: the stored `active` flag AND an ' +
      '`expires_at` that has not passed. An expired row reads false here before any sweep ' +
      'has flipped the column.',
  })
  active!: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'When this secret stops signing.' })
  expires_at!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'When a rotation superseded it.' })
  rotated_at!: string | null;
  @ApiProperty() created_at!: string;
}

export class RotatedSecretDto extends EndpointSecretDto {
  @ApiProperty({
    description:
      'The plaintext secret. RETURNED EXACTLY ONCE, in this response. It is encrypted at ' +
      'rest with a key this API does not hand out and is never included in any other ' +
      'response, log line or audit entry. If it is lost, rotate again.',
  })
  secret!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The LAST moment any previously issued secret still signs - the maximum over every ' +
      'version in `overlapping_versions`, not just the ones this rotation moved. Null when no ' +
      'prior secret is signing any more (a rotation with `overlap_seconds: 0`, or the first ' +
      'secret on an endpoint). Consumers must accept both old and new until this passes.',
  })
  previous_secrets_expire_at!: string | null;

  @ApiProperty({
    type: [Number],
    description:
      'EVERY prior version that still signs after this rotation, newest first - including ' +
      'versions whose own expiry this rotation did not move, because they are still emitting a ' +
      '`v1=` component and a consumer rolling its secrets off this list must know about them.',
  })
  overlapping_versions!: number[];
}

export class EndpointSecretListDto {
  @ApiProperty({ type: [EndpointSecretDto] }) data!: EndpointSecretDto[];
  @ApiProperty({ description: 'More secrets match than this page carries.' })
  has_more!: boolean;
  @ApiPropertyOptional({ nullable: true, description: '`offset` for the next page, or null.' })
  next_offset!: number | null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * A secret is signing right now iff the column says active AND it has not
 * expired. Both halves matter: `active` alone would keep an expired secret in
 * the header until a sweep ran, and `expires_at` alone would resurrect a secret
 * that was explicitly revoked.
 *
 * **This is the contract with the data plane's secret loader.** The equivalent
 * SQL is `active = true AND (expires_at IS NULL OR expires_at > now())`.
 */
export function isEffectivelyActive(secret: EndpointSecret, now: Date = new Date()): boolean {
  if (!secret.active) return false;
  return secret.expiresAt === null || new Date(secret.expiresAt).getTime() > now.getTime();
}

export function toEndpointSecretDto(secret: EndpointSecret, now?: Date): EndpointSecretDto {
  return {
    id: secret.id,
    endpoint_id: secret.endpointId,
    version: secret.version,
    active: isEffectivelyActive(secret, now),
    expires_at: iso(secret.expiresAt),
    rotated_at: iso(secret.rotatedAt),
    created_at: new Date(secret.createdAt).toISOString(),
  };
}
