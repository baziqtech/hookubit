import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { MAX_WINDOW_HOURS } from './analytics-window';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsWindowQueryDto,
  AttemptLatencyDto,
  DeliveryOutcomesDto,
  EventVolumeDto,
  EventVolumeQueryDto,
  FailingEndpointsDto,
  FailingEndpointsQueryDto,
} from './dto';

const MINUTE = 60_000;

/**
 * Thin: parse, delegate, return. Every decision is in `AnalyticsService`.
 *
 * ## Four routes, not one dashboard payload
 *
 * The speculative shape the dashboard was built against was a single
 * `GET /analytics` returning everything. These are four routes because the four
 * questions cost different amounts and fail differently: the latency sample is
 * an order of magnitude dearer than the event count, and one combined route
 * makes the cheapest tile on the page wait for the dearest query and blanks the
 * whole panel when one of them is slow. Four requests render as they land, are
 * throttled separately, and can be cached separately later.
 *
 * ## Throttling
 *
 * Every route carries `@Throttle`. These are aggregates over `deliveries`,
 * `events` and `delivery_attempts` - the three largest tables in the product -
 * and at the 720h ceiling the outcome query is a deliberate parallel sequential
 * scan. Unthrottled, a tab left on auto-refresh is a self-inflicted load test,
 * and a loop over the window parameter is a cheap way to occupy every
 * connection in the pool. The limits below are set for a human looking at a
 * screen, not for a polling agent: a dashboard refreshing every 30s uses a
 * tenth of the outcomes budget.
 *
 * NOTE for whoever tunes these: `ThrottleGuard` buckets per client IP, not per
 * tenant or per session. Behind a proxy with `TRUST_PROXY_HOPS` set correctly
 * that is per user; set wrongly, it is one bucket for everyone. See
 * `config/trust-proxy.ts`.
 */
@ApiTags('analytics')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project does not exist, or belongs to another tenant. One answer with one message, ' +
    'on purpose: a 403 here would confirm that a project id scraped from somewhere else names ' +
    'live infrastructure belonging to another customer.',
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
@ApiBadRequestResponse({
  description: `\`window_hours\` was out of range - above ${MAX_WINDOW_HOURS} is REFUSED, never clamped.`,
})
// A controller-level route parameter is emitted with NO `parameters` entry unless
// it is declared here, and `type: String` is not decoration: without it the
// generated client types the parameter as `unknown`.
@ApiParam({
  name: 'projectId',
  type: String,
  example: 'proj_01J8ZK...',
  description: 'Project id, `proj_…`. Resolved from the project row, never trusted as a claim.',
})
@Controller('projects/:projectId/analytics')
@UseGuards(ThrottleGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('deliveries')
  @Authorized('deliveries.read')
  @Throttle({ name: 'analytics.deliveries', limit: 120, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Delivery outcomes over a window, beside the window before it',
    description:
      'Every `DeliveryStatus` counted exactly, rolled up into succeeded / failing / exhausted / ' +
      'in-flight, with `success_rate` over SETTLED deliveries only. The same numbers are ' +
      'returned for the immediately preceding window of equal length, so "is it getting worse?" ' +
      'is one request rather than two and a subtraction. `success_rate` is NULL, never 0, when ' +
      'nothing settled: 0 means everything failed.',
  })
  @ApiOkResponse({ type: DeliveryOutcomesDto })
  deliveries(
    @Tenant() context: RequestContext,
    @Query() query: AnalyticsWindowQueryDto,
  ): Promise<DeliveryOutcomesDto> {
    return this.analytics.deliveryOutcomes(context, query);
  }

  @Get('endpoints')
  @Authorized('deliveries.read')
  @Throttle({ name: 'analytics.endpoints', limit: 120, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Which endpoints are failing, ranked worst first',
    description:
      'Ranked by `failed + exhausted` in the window, with the per-status split, the total ' +
      'delivered to each, and a failure rate. Read the rate beside the count: one endpoint at ' +
      '100% of two deliveries is not the outage. The current endpoint name, URL, status and ' +
      '`enabled` flag are included so a disabled endpoint is not mistaken for a broken one.',
  })
  @ApiOkResponse({ type: FailingEndpointsDto })
  endpoints(
    @Tenant() context: RequestContext,
    @Query() query: FailingEndpointsQueryDto,
  ): Promise<FailingEndpointsDto> {
    return this.analytics.failingEndpoints(context, query);
  }

  @Get('latency')
  @Authorized('deliveries.read')
  // The dearest of the four: a bounded delivery scan followed by one index
  // lookup per sampled delivery. Half the budget of the others, deliberately.
  @Throttle({ name: 'analytics.latency', limit: 60, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Attempt latency percentiles (p50/p95/p99) over measured attempt durations',
    description:
      'Computed over a BOUNDED SAMPLE of the most recent measured attempts in the window. ' +
      '`exact` says whether the sample was the whole window; when it is false the numbers ' +
      'describe the most recent traffic in the window, and `sample_size` says how much was ' +
      'measured. Nearest-rank, so every value returned is a duration something actually took. ' +
      'An exact percentile over the whole window is not offered today; the sample cap is what ' +
      'keeps this query bounded.',
  })
  @ApiOkResponse({ type: AttemptLatencyDto })
  latency(
    @Tenant() context: RequestContext,
    @Query() query: AnalyticsWindowQueryDto,
  ): Promise<AttemptLatencyDto> {
    return this.analytics.attemptLatency(context, query);
  }

  @Get('events')
  // `events.read`, not `deliveries.read`: this route reads the `events` table
  // and nothing else. The two grants are identical in today's matrix, which is
  // exactly why naming the right one matters - the day they diverge, this route
  // must move with the table it reads, not with the module it lives in.
  @Authorized('events.read')
  @Throttle({ name: 'analytics.events', limit: 120, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Event volume over a window, with the busiest event types',
    description:
      'Events PUBLISHED in the window - not deliveries. One event fans out to one delivery per ' +
      'matching subscription, so these two numbers are expected to differ and their ratio is ' +
      'the project\'s fan-out. The preceding window of equal length is returned alongside.',
  })
  @ApiOkResponse({ type: EventVolumeDto })
  events(
    @Tenant() context: RequestContext,
    @Query() query: EventVolumeQueryDto,
  ): Promise<EventVolumeDto> {
    return this.analytics.eventVolume(context, query);
  }
}
