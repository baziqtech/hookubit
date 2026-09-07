import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RateLimitScope } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { RATE_LIMIT_LIMITS, RATE_LIMIT_SCOPES } from '../rate-limit-limits';

export class CreateRateLimitDto {
  @ApiProperty({
    enum: RATE_LIMIT_SCOPES,
    description:
      'What the ceiling applies to. `endpoint` and `project` bound outbound delivery; ' +
      '`organization` bounds it across every project in the org; `ingest` bounds inbound ' +
      'event acceptance.',
  })
  @IsIn(RATE_LIMIT_SCOPES)
  scope!: RateLimitScope;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 64,
    description:
      'The specific resource this limit covers, or null for EVERY resource in this scope. ' +
      'What it names depends on `scope`: an endpoint id, an API key id (`ingest`), this ' +
      'project’s id, or this organization’s id. It is resolved through the scoped repository ' +
      'for that table, so an id belonging to another tenant is a 404.',
  })
  @IsOptional()
  // ValidateIf rather than plain @IsOptional: an explicit `null` is MEANINGFUL
  // here ("every resource in this scope") and must reach the service, so it has
  // to survive validation rather than be treated as absent.
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(64)
  resource_id?: string | null;

  @ApiProperty({
    minimum: RATE_LIMIT_LIMITS.limit.min,
    maximum: RATE_LIMIT_LIMITS.limit.max,
    description:
      'Requests allowed per window. Never 0 or negative: 0 would disable delivery or ' +
      'ingestion entirely for whatever this policy covers.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(RATE_LIMIT_LIMITS.limit.min)
  @Max(RATE_LIMIT_LIMITS.limit.max)
  limit!: number;

  @ApiPropertyOptional({
    minimum: RATE_LIMIT_LIMITS.windowSeconds.min,
    maximum: RATE_LIMIT_LIMITS.windowSeconds.max,
    default: RATE_LIMIT_LIMITS.windowSeconds.default,
    description:
      'Window length. Never 0: the refill rate is `limit / window`, so a zero window is a ' +
      'division by zero downstream.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RATE_LIMIT_LIMITS.windowSeconds.min)
  @Max(RATE_LIMIT_LIMITS.windowSeconds.max)
  window_seconds?: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: RATE_LIMIT_LIMITS.burst.min,
    maximum: RATE_LIMIT_LIMITS.burst.max,
    description:
      'Bucket capacity. Null means "the same as `limit`". When set it must be at least ' +
      '`limit`, or the bucket could never hold one window’s worth of tokens and the ' +
      'configured limit would be unreachable.',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(RATE_LIMIT_LIMITS.burst.min)
  @Max(RATE_LIMIT_LIMITS.burst.max)
  burst?: number | null;
}
