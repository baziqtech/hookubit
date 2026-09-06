import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  MAX_CUSTOM_HEADERS,
  MAX_HEADER_VALUE_LENGTH,
  rejectCustomHeaders,
} from '../endpoint-headers';
import {
  ENDPOINT_LIMITS,
  MAX_ENDPOINT_DESCRIPTION_LENGTH,
  MAX_ENDPOINT_NAME_LENGTH,
} from '../endpoint-limits';
import { MAX_URL_LENGTH, rejectEndpointUrl } from '../endpoint-url';

/**
 * The SSRF usability mirror, wired in at the DTO edge so the customer is told
 * their URL is unusable in the same response that would have told them the name
 * was too long. `endpoint-url.ts` explains why this is a mirror and not the
 * authority - the Go dial-time guard remains the one that actually stops SSRF.
 */
@ValidatorConstraint({ name: 'deliverableUrl', async: false })
export class DeliverableUrlConstraint implements ValidatorConstraintInterface {
  private reason = 'is not a deliverable URL';

  validate(value: unknown): boolean {
    const rejection = rejectEndpointUrl(value);
    if (!rejection) return true;
    this.reason = rejection;
    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property}: ${this.reason}`;
  }
}

/** Reserved keys, header-injection characters and the size ceilings. */
@ValidatorConstraint({ name: 'safeCustomHeaders', async: false })
export class SafeCustomHeadersConstraint implements ValidatorConstraintInterface {
  private reason = 'contains a header that is not allowed';

  validate(value: unknown): boolean {
    const rejection = rejectCustomHeaders(value);
    if (!rejection) return true;
    this.reason = rejection.header ? `"${rejection.header}": ${rejection.reason}` : rejection.reason;
    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property}: ${this.reason}`;
  }
}

export class CreateEndpointDto {
  @ApiProperty({ maxLength: MAX_ENDPOINT_NAME_LENGTH, example: 'Finance ledger' })
  @IsString()
  @Length(1, MAX_ENDPOINT_NAME_LENGTH)
  name!: string;

  @ApiProperty({
    maxLength: MAX_URL_LENGTH,
    example: 'https://finance.example.com/webhooks/payments',
    description:
      'http or https only. Credentials in the URL and literal private, loopback, link-local ' +
      'or cloud-metadata addresses are refused here so the failure is visible at save time; ' +
      'hostnames are re-checked against their RESOLVED address at dial time in the data plane, ' +
      'which is where DNS rebinding is actually stopped.',
  })
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
  @Validate(DeliverableUrlConstraint)
  url!: string;

  @ApiPropertyOptional({ maxLength: MAX_ENDPOINT_DESCRIPTION_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ENDPOINT_DESCRIPTION_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    minimum: ENDPOINT_LIMITS.timeoutMs.min,
    maximum: ENDPOINT_LIMITS.timeoutMs.max,
    default: ENDPOINT_LIMITS.timeoutMs.default,
    description: 'How long one delivery attempt may hold a worker slot.',
  })
  @IsOptional()
  @IsInt()
  @Min(ENDPOINT_LIMITS.timeoutMs.min)
  @Max(ENDPOINT_LIMITS.timeoutMs.max)
  timeout_ms?: number;

  @ApiPropertyOptional({
    minimum: ENDPOINT_LIMITS.maxConcurrency.min,
    maximum: ENDPOINT_LIMITS.maxConcurrency.max,
    default: ENDPOINT_LIMITS.maxConcurrency.default,
    description: 'In-flight attempts allowed against this endpoint at once.',
  })
  @IsOptional()
  @IsInt()
  @Min(ENDPOINT_LIMITS.maxConcurrency.min)
  @Max(ENDPOINT_LIMITS.maxConcurrency.max)
  max_concurrency?: number;

  @ApiPropertyOptional({
    minimum: ENDPOINT_LIMITS.rateLimit.min,
    maximum: ENDPOINT_LIMITS.rateLimit.max,
    nullable: true,
    description: 'Deliveries per window. Null means no per-endpoint limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(ENDPOINT_LIMITS.rateLimit.min)
  @Max(ENDPOINT_LIMITS.rateLimit.max)
  rate_limit?: number | null;

  @ApiPropertyOptional({
    minimum: ENDPOINT_LIMITS.rateLimitWindowSeconds.min,
    maximum: ENDPOINT_LIMITS.rateLimitWindowSeconds.max,
    default: ENDPOINT_LIMITS.rateLimitWindowSeconds.default,
  })
  @IsOptional()
  @IsInt()
  @Min(ENDPOINT_LIMITS.rateLimitWindowSeconds.min)
  @Max(ENDPOINT_LIMITS.rateLimitWindowSeconds.max)
  rate_limit_window_seconds?: number;

  @ApiPropertyOptional({
    description: 'Retry policy in THIS project. Resolved through the tenant scope.',
    maxLength: 64,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  retry_policy_id?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', maxLength: MAX_HEADER_VALUE_LENGTH },
    description:
      `Up to ${MAX_CUSTOM_HEADERS} extra request headers. Webhook-*, Authorization, Host, ` +
      'Content-Length and Transfer-Encoding are reserved and rejected.',
  })
  @IsOptional()
  @IsObject()
  @Validate(SafeCustomHeadersConstraint)
  custom_headers?: Record<string, string> | null;
}
