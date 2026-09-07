import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKey, Environment } from '@prisma/client';
import { ApiKeyState, apiKeyState } from '../api-key-state';

/**
 * An API key as it can safely be shown, forever.
 *
 * `key_hash` is not on this type and must never be added: it is the exact value
 * the ingest path looks a credential up by, so publishing it would turn a read
 * of the key inventory into a way to authenticate. `key_prefix` (12 characters,
 * enough to cover `wk_live_` plus four) is what an operator identifies a key by.
 */
export class ApiKeyDto {
  @ApiProperty({ example: 'key_01J8ZK...' })
  id!: string;

  @ApiProperty({ example: 'proj_01J8ZK...' })
  project_id!: string;

  @ApiProperty({ example: 'Payments ingest (production)' })
  name!: string;

  @ApiProperty({
    example: 'wk_live_a9Kd',
    description:
      'The first 12 characters of the key. Safe to display and to log; never enough to ' +
      'reconstruct the credential.',
  })
  key_prefix!: string;

  @ApiProperty({
    enum: Environment,
    enumName: 'Environment',
    description: "Always equal to the project's environment; the ingest path re-checks the pair.",
  })
  environment!: Environment;

  @ApiProperty({
    enum: ['active', 'expired', 'revoked'],
    description:
      'Derived from `revoked_at`/`expires_at` at read time, exactly as the ingest path derives ' +
      'it. `active` here still does not mean the key works: a suspended or deleted project ' +
      'refuses every key under it.',
  })
  status!: ApiKeyState;

  @ApiProperty({
    type: [String],
    description:
      'Control-plane permissions this key may exercise if and when key-authenticated control ' +
      'routes exist. The ingest path does NOT consult scopes today - it authenticates on the ' +
      'key, its project and its environment - so an empty list is a normal ingest key.',
  })
  scopes!: string[];

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  expires_at!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Best-effort, written by the data plane. Never a basis for an authorization call.',
  })
  last_used_at!: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  revoked_at!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

/**
 * The create response, and the ONLY place `key` ever appears.
 *
 * There is no second chance by design: only the SHA-256 hash is stored, so
 * nothing in this system can reproduce the plaintext - not this API, not the
 * database, not an operator with psql. A caller that loses it revokes and
 * re-issues.
 */
export class CreatedApiKeyDto extends ApiKeyDto {
  @ApiProperty({
    example: 'wk_live_3xAmPl3S3cr3tK3yV4lu3Chars32Aa',
    description:
      'THE PLAINTEXT KEY, RETURNED EXACTLY ONCE. It is not stored and cannot be recovered or ' +
      'redisplayed. Do not log it, do not put it in a URL, do not persist it anywhere but a ' +
      'secret store.',
  })
  key!: string;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toApiKeyDto(key: ApiKey, now: Date = new Date()): ApiKeyDto {
  return {
    id: key.id,
    project_id: key.projectId,
    name: key.name,
    key_prefix: key.keyPrefix,
    environment: key.environment,
    status: apiKeyState(key, now),
    scopes: key.scopes,
    expires_at: iso(key.expiresAt),
    last_used_at: iso(key.lastUsedAt),
    revoked_at: iso(key.revokedAt),
    created_at: key.createdAt.toISOString(),
  };
}

/**
 * A page of keys, and whether the bound was reached.
 *
 * A bare array here was actively dangerous rather than merely incomplete: the
 * reason to enumerate a project's keys is usually "revoke everything that can
 * authenticate as us", and a caller that received exactly `limit` rows could not
 * tell a full page from the whole inventory. `has_more` is what makes "I have
 * seen every credential" expressible.
 */
export class ApiKeyListDto {
  @ApiProperty({ type: [ApiKeyDto] })
  data!: ApiKeyDto[];

  @ApiProperty({
    description: 'Keys in `data`. Never compare this against `limit` to detect the last page.',
    example: 50,
  })
  count!: number;

  @ApiProperty({
    description: 'True when more keys exist in this project than the page carries.',
    example: false,
  })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Pass as `offset` to fetch the next page. Null when this page was the last one.',
    example: null,
  })
  next_offset!: number | null;
}
