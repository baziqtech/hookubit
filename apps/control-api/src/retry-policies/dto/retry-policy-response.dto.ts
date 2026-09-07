import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetryPolicy } from '@prisma/client';
import { RETRY_STRATEGIES, RetryStrategy } from '../retry-policy-limits';
import { RetrySettings } from '../retry-policy-rules';

/**
 * The wire shape, built by an explicit mapper rather than by returning the
 * Prisma row: a column added to `retry_policies` later cannot appear in a
 * customer-facing response because nobody thought about it.
 */
export class RetryPolicyDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Exactly one policy per project carries this.' })
  is_default!: boolean;
  @ApiProperty({ enum: RETRY_STRATEGIES }) strategy!: RetryStrategy;
  @ApiProperty() max_attempts!: number;
  @ApiProperty() initial_delay_ms!: number;
  @ApiProperty() max_delay_ms!: number;
  @ApiProperty() multiplier!: number;
  @ApiProperty() jitter_ratio!: number;
  @ApiProperty() max_retry_duration_ms!: number;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

export class RetryPolicyListDto {
  @ApiProperty({ type: [RetryPolicyDto] }) data!: RetryPolicyDto[];
  @ApiProperty({
    description:
      'More policies match than this page carries. The load-bearing field: a client cannot ' +
      'derive it from a total, and a total would cost a second COUNT on every list request.',
  })
  has_more!: boolean;
  @ApiPropertyOptional({ nullable: true, description: '`offset` for the next page, or null.' })
  next_offset!: number | null;
}

/**
 * `strategy` is a free `String` column (the schema comments the three legal
 * values rather than enumerating them), so a row written before validation
 * existed — or by the CLI — can hold anything. It is narrowed here rather than
 * asserted: an unrecognised value is surfaced as-is so an operator reading the
 * response sees the actual stored garbage, which is what they need in order to
 * fix it.
 */
function strategyOf(value: string): RetryStrategy {
  return (RETRY_STRATEGIES as readonly string[]).includes(value)
    ? (value as RetryStrategy)
    : (value as RetryStrategy);
}

/** The tunable fields of a stored row, for merging a PATCH against. */
export function settingsOf(policy: RetryPolicy): RetrySettings {
  return {
    strategy: strategyOf(policy.strategy),
    maxAttempts: policy.maxAttempts,
    initialDelayMs: policy.initialDelayMs,
    maxDelayMs: policy.maxDelayMs,
    multiplier: policy.multiplier,
    jitterRatio: policy.jitterRatio,
    maxRetryDurationMs: policy.maxRetryDurationMs,
  };
}

export function toRetryPolicyDto(policy: RetryPolicy): RetryPolicyDto {
  return {
    id: policy.id,
    project_id: policy.projectId,
    name: policy.name,
    is_default: policy.isDefault,
    strategy: strategyOf(policy.strategy),
    max_attempts: policy.maxAttempts,
    initial_delay_ms: policy.initialDelayMs,
    max_delay_ms: policy.maxDelayMs,
    multiplier: policy.multiplier,
    jitter_ratio: policy.jitterRatio,
    max_retry_duration_ms: policy.maxRetryDurationMs,
    created_at: new Date(policy.createdAt).toISOString(),
    updated_at: new Date(policy.updatedAt).toISOString(),
  };
}
