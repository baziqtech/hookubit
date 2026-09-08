import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS } from '../analytics-window';

/**
 * The one query parameter every analytics route takes.
 *
 * `@Max` rather than a clamp: `main.ts` mounts a `ValidationPipe` with
 * `forbidNonWhitelisted`, so 721 is a 400 naming the constraint. See
 * `analytics-window.ts` for why refusing is the only safe answer.
 */
export class AnalyticsWindowQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_WINDOW_HOURS,
    default: DEFAULT_WINDOW_HOURS,
    description:
      'How many hours back from now to summarise. The window is `[now - window_hours, now)`. ' +
      `Values above ${MAX_WINDOW_HOURS} (30 days) are REFUSED with a 400, never shortened: a ` +
      'clamped response would carry the number for a period the caller did not ask about. ' +
      'The dashboard shorthands map to 24 (24h), 168 (7d) and 720 (30d).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WINDOW_HOURS)
  window_hours?: number;
}

/** `GET /analytics/endpoints` - the window, plus how many endpoints to rank. */
export class FailingEndpointsQueryDto extends AnalyticsWindowQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    default: 10,
    description:
      'How many endpoints to return, worst first. Bounded because the second query groups by ' +
      '(endpoint_id, status) over these ids: the group count is `limit x 9` and a rollup that ' +
      'silently loses groups is worse than a smaller one.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** `GET /analytics/events` - the window, plus how many event types to list. */
export class EventVolumeQueryDto extends AnalyticsWindowQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    default: 10,
    description: 'How many event types to return, busiest first.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
