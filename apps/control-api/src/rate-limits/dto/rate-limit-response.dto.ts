import { ApiProperty } from '@nestjs/swagger';
import { RateLimitPolicy, RateLimitScope } from '@prisma/client';
import { RATE_LIMIT_SCOPES } from '../rate-limit-limits';
import { RateLimitSettings } from '../rate-limit-rules';

/**
 * The wire shape, built by an explicit mapper rather than by returning the
 * Prisma row, so a column added to `rate_limit_policies` later cannot appear in
 * a customer-facing response because nobody thought about it.
 */
export class RateLimitDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty({ enum: RATE_LIMIT_SCOPES }) scope!: RateLimitScope;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null means every resource in this scope.',
  })
  resource_id!: string | null;
  @ApiProperty() limit!: number;
  @ApiProperty() window_seconds!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Null means the same as `limit`.' })
  burst!: number | null;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

export class RateLimitListDto {
  @ApiProperty({ type: [RateLimitDto] }) data!: RateLimitDto[];
  @ApiProperty({
    description:
      'More policies match than this page carries. The load-bearing field: a client cannot ' +
      'derive it from a total, and a total would cost a second COUNT on every list request.',
  })
  has_more!: boolean;
  @ApiProperty({ type: Number, nullable: true, description: '`offset` for the next page, or null.' })
  next_offset!: number | null;
}

/** The tunable fields of a stored row, for merging a PATCH against. */
export function settingsOf(policy: RateLimitPolicy): RateLimitSettings {
  return {
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
    burst: policy.burst ?? null,
  };
}

export function toRateLimitDto(policy: RateLimitPolicy): RateLimitDto {
  return {
    id: policy.id,
    project_id: policy.projectId,
    scope: policy.scope,
    resource_id: policy.resourceId ?? null,
    limit: policy.limit,
    window_seconds: policy.windowSeconds,
    burst: policy.burst ?? null,
    created_at: new Date(policy.createdAt).toISOString(),
    updated_at: new Date(policy.updatedAt).toISOString(),
  };
}
