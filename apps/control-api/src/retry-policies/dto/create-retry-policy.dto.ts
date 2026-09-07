import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import {
  MAX_RETRY_POLICY_NAME_LENGTH,
  RETRY_POLICY_LIMITS,
  RETRY_STRATEGIES,
  RetryStrategy,
} from '../retry-policy-limits';

/**
 * The per-field edge. `retry-policy-rules.ts` holds the cross-field rules and is
 * what actually guards the table; these decorators exist so a caller is told
 * "max_delay_ms must be between 1 and 86400000" with a field name, in the same
 * 400 that tells them the name was too long.
 *
 * Every number is `@Min`-ed above zero. `max_delay_ms = 0` is the specific value
 * that produced a large NEGATIVE `time.Duration` in the data plane and hammered
 * a dead endpoint every 250ms — see `retry-policy-limits.ts`.
 */
export class CreateRetryPolicyDto {
  @ApiProperty({ maxLength: MAX_RETRY_POLICY_NAME_LENGTH, example: 'Patient partners' })
  @IsString()
  @Length(1, MAX_RETRY_POLICY_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Make this the project default. Exactly one policy per project is the default; setting ' +
      'this clears the previous one in the same transaction. The FIRST policy created in a ' +
      'project becomes the default whether or not this is set, because a project with policies ' +
      'and no default is a state nothing can resolve.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({
    enum: RETRY_STRATEGIES,
    default: 'exponential',
    description:
      '`exponential` multiplies the previous delay; `linear` adds `initial_delay_ms` each ' +
      'time; `constant` repeats `initial_delay_ms`. `multiplier` is read by `exponential` ' +
      'only — the delivery workers ignore it for the other two.',
  })
  @IsOptional()
  @IsIn(RETRY_STRATEGIES)
  strategy?: RetryStrategy;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.maxAttempts.min,
    maximum: RETRY_POLICY_LIMITS.maxAttempts.max,
    default: RETRY_POLICY_LIMITS.maxAttempts.default,
    description: 'Total attempts including the first delivery. Never 0: 0 means "no cap" downstream.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RETRY_POLICY_LIMITS.maxAttempts.min)
  @Max(RETRY_POLICY_LIMITS.maxAttempts.max)
  max_attempts?: number;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.initialDelayMs.min,
    maximum: RETRY_POLICY_LIMITS.initialDelayMs.max,
    default: RETRY_POLICY_LIMITS.initialDelayMs.default,
    description: 'Delay before the FIRST retry. Must not exceed max_delay_ms.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RETRY_POLICY_LIMITS.initialDelayMs.min)
  @Max(RETRY_POLICY_LIMITS.initialDelayMs.max)
  initial_delay_ms?: number;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.maxDelayMs.min,
    maximum: RETRY_POLICY_LIMITS.maxDelayMs.max,
    default: RETRY_POLICY_LIMITS.maxDelayMs.default,
    description:
      'Ceiling on any computed delay. MUST be positive: an unset ceiling is what let the ' +
      'exponential term overflow int64 in the delivery workers and schedule the next attempt ' +
      'permanently in the past.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RETRY_POLICY_LIMITS.maxDelayMs.min)
  @Max(RETRY_POLICY_LIMITS.maxDelayMs.max)
  max_delay_ms?: number;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.multiplier.min,
    maximum: RETRY_POLICY_LIMITS.multiplier.max,
    default: RETRY_POLICY_LIMITS.multiplier.default,
    description:
      'Exponential growth factor. Must be strictly greater than 1 when strategy is ' +
      '`exponential` — the delivery workers replace any multiplier <= 1 with 2, so storing 1 ' +
      'would store a policy that does not describe what happens.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(RETRY_POLICY_LIMITS.multiplier.min)
  @Max(RETRY_POLICY_LIMITS.multiplier.max)
  multiplier?: number;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.jitterRatio.min,
    maximum: RETRY_POLICY_LIMITS.jitterRatio.max,
    default: RETRY_POLICY_LIMITS.jitterRatio.default,
    description:
      'Symmetric jitter as a fraction of the computed delay, so a thousand deliveries to one ' +
      'recovering endpoint do not stampede in lockstep. Above 1 the delay goes negative and ' +
      'is clamped to zero, which is the stampede again.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(RETRY_POLICY_LIMITS.jitterRatio.min)
  @Max(RETRY_POLICY_LIMITS.jitterRatio.max)
  jitter_ratio?: number;

  @ApiPropertyOptional({
    minimum: RETRY_POLICY_LIMITS.maxRetryDurationMs.min,
    maximum: RETRY_POLICY_LIMITS.maxRetryDurationMs.max,
    default: RETRY_POLICY_LIMITS.maxRetryDurationMs.default,
    description:
      'Wall-clock budget from the first attempt. Capped at 7 days because the column is a ' +
      'PostgreSQL integer. Never 0: 0 means "no budget cap" downstream, and eight attempts ' +
      'with an hour ceiling would keep a dead endpoint hot for days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RETRY_POLICY_LIMITS.maxRetryDurationMs.min)
  @Max(RETRY_POLICY_LIMITS.maxRetryDurationMs.max)
  max_retry_duration_ms?: number;
}
