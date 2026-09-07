import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { DeliveriesService } from './deliveries.service';
import { MAX_REPLAY_FAN_OUT } from './delivery-limits';
import {
  DeliveryAttemptListDto,
  DeliveryDetailDto,
  DeliveryListDto,
  ListAttemptsQueryDto,
  ListDeliveriesQueryDto,
  ReplayDeliveryDto,
  ReplayResultDto,
} from './dto';

const MINUTE = 60_000;

/**
 * Thin: parse, delegate, return. Every decision is in `DeliveriesService` and
 * `DeliveryReplayService`.
 *
 * The tenant comes from `:projectId` - `TenantResolver` reads the project row,
 * takes the organization off it and checks membership against THAT, so the id
 * in the path is a lookup key and never an authorization claim.
 */
@ApiTags('deliveries')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project or delivery does not exist, or belongs to another tenant. The two are one ' +
    'answer, with one message, on purpose: a 403 here would confirm that an id scraped from ' +
    'somewhere else names a live delivery belonging to another customer.',
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
@Controller('projects/:projectId/deliveries')
@UseGuards(ThrottleGuard)
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @Authorized('deliveries.read')
  @ApiOperation({
    summary: 'List deliveries in a project',
    description:
      'Filter by status, endpoint, event, event type and date range, or by `failing_now` - ' +
      'everything that has failed and not recovered. Every filter is either index-supported or ' +
      'documented as a scan; see the parameter descriptions before running one on a busy ' +
      'project. Replays are included by default: a replay is a real delivery, and hiding it ' +
      'would make the ledger lie.',
  })
  @ApiOkResponse({ type: DeliveryListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<DeliveryListDto> {
    return this.deliveries.list(context, query);
  }

  @Get(':deliveryId')
  @Authorized('deliveries.read')
  @ApiOperation({
    summary: 'Fetch one delivery with its full attempt history',
    description:
      'The single most useful response in this API: the delivery, the event it came from, the ' +
      'endpoint as it stands now, and every attempt in order - number, HTTP status, duration, ' +
      'request and response headers, the truncated response body, the error code and message, ' +
      'and when the next attempt is due. Credential-shaped request header VALUES are redacted; ' +
      'the signature header is not.',
  })
  @ApiOkResponse({ type: DeliveryDetailDto })
  get(
    @Tenant() context: RequestContext,
    @Param('deliveryId') deliveryId: string,
  ): Promise<DeliveryDetailDto> {
    return this.deliveries.get(context, deliveryId);
  }

  @Get(':deliveryId/attempts')
  @Authorized('deliveries.read')
  @ApiOperation({
    summary: 'Page the attempt history',
    description:
      'For a delivery with more attempts than `GET /deliveries/:id` inlines. Ascending by ' +
      'attempt number. `delivery_attempts` is append-only, so a page fetched twice is identical ' +
      'unless a new attempt has been made.',
  })
  @ApiOkResponse({ type: DeliveryAttemptListDto })
  attempts(
    @Tenant() context: RequestContext,
    @Param('deliveryId') deliveryId: string,
    @Query() query: ListAttemptsQueryDto,
  ): Promise<DeliveryAttemptListDto> {
    return this.deliveries.listAttempts(context, deliveryId, query);
  }

  @Post(':deliveryId/replay')
  @Authorized('deliveries.replay')
  @HttpCode(HttpStatus.CREATED)
  // The tightest limit in the API, and it is not about CPU. Every accepted
  // request here becomes a real HTTP call to a customer's own infrastructure,
  // so an unbounded loop over this route is a way to use this platform to
  // hammer a third party. `viewer` cannot reach it at all (the permission
  // matrix), `MAX_REPLAY_FAN_OUT` bounds one request, and this bounds the rate.
  @Throttle({ name: 'deliveries.replay', limit: 30, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Replay one delivery',
    description:
      'Creates a NEW delivery row carrying `replay_of_delivery_id` and `replayed_by`. The ' +
      'original is not modified in any way - not its status, not its attempt count, and not one ' +
      'row of its append-only attempt history. Refused with a 409 when the endpoint has since ' +
      'been deleted or disabled, because such a replay would be abandoned by the worker rather ' +
      'than delivered. Replaying a replay is allowed and chains.',
  })
  @ApiCreatedResponse({ type: ReplayResultDto })
  @ApiConflictResponse({
    description: `The endpoint is deleted or disabled, or the replay would exceed ${MAX_REPLAY_FAN_OUT} deliveries.`,
  })
  replay(
    @Tenant() context: RequestContext,
    @Param('deliveryId') deliveryId: string,
    @Body() dto: ReplayDeliveryDto,
  ): Promise<ReplayResultDto> {
    return this.deliveries.replay(context, deliveryId, dto);
  }
}
