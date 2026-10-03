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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { MAX_REPLAY_DELIVERIES } from '../deliveries/delivery-limits';
import {
  DeliveryListDto,
  ListDeliveriesQueryDto,
  ReplayEventDto,
  ReplayResultDto,
} from '../deliveries/dto';
import { EventDetailDto, EventListDto, ListEventsQueryDto } from './dto';
import { EventsService } from './events.service';

const MINUTE = 60_000;

/**
 * Thin: parse, delegate, return. Every decision is in `EventsService`.
 *
 * The tenant comes from `:projectId`, resolved from the project row, so the id
 * in the path is a lookup key and never an authorization claim.
 */
@ApiTags('events')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project, event or endpoint does not exist, or belongs to another tenant. One answer ' +
    'with one message for all of them, on purpose: this route takes an event id in the path ' +
    'AND an endpoint id in the body, so distinguishable 404s would make it an oracle over ' +
    "another customer's endpoint ids.",
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
// A controller-level route parameter is emitted with NO `parameters` entry unless
// it is declared here, and `type: String` is not decoration: without it the
// generated client types the parameter as `unknown`.
@ApiParam({
  name: 'projectId',
  type: String,
  example: 'proj_01J8ZK...',
  description: 'Project id, `proj_…`. Resolved from the project row, never trusted as a claim.',
})
@Controller('projects/:projectId/events')
@UseGuards(ThrottleGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @Authorized('events.read')
  @ApiOperation({
    summary: 'List events in a project',
    description:
      'Filter by event type, ingest status, date range, and a free-text fragment of the ' +
      'idempotency key. Payloads are NOT included - `events` is the largest table in the ' +
      'system and its rows are raw request bodies; fetch one event to see one payload. Read ' +
      'the parameter descriptions before running `status` or `idempotency_key` on a busy ' +
      'project: both are scans of whatever the indexed filters left.',
  })
  @ApiOkResponse({ type: EventListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListEventsQueryDto,
  ): Promise<EventListDto> {
    return this.events.list(context, query);
  }

  @Get(':eventId')
  @Authorized('events.read')
  @ApiOperation({
    summary: 'Fetch one event, with its payload',
    description:
      'The payload is returned as `payload.body` - the AUTHORITATIVE raw bytes, decoded: what ' +
      'was hashed and what was signed. `payload.normalised_json` is the jsonb copy kept for ' +
      'filtering and is explicitly NOT what was delivered, because PostgreSQL normalises jsonb. ' +
      'A payload held in object storage is reported as such, with its location, rather than ' +
      'returned as an empty body.',
  })
  @ApiOkResponse({ type: EventDetailDto })
  get(
    @Tenant() context: RequestContext,
    @Param('eventId') eventId: string,
  ): Promise<EventDetailDto> {
    return this.events.get(context, eventId);
  }

  @Get(':eventId/deliveries')
  @Authorized('events.read', 'deliveries.read')
  @ApiOperation({
    summary: 'List the deliveries this event routed to',
    description:
      'The "did finance ever receive this?" route: one row per endpoint the event was ' +
      'materialised for, each with its own status, attempt count and next attempt. Accepts the ' +
      'same filters as the deliveries listing (the event is forced, so `event_id` in the query ' +
      'is ignored).',
  })
  @ApiOkResponse({ type: DeliveryListDto })
  deliveries(
    @Tenant() context: RequestContext,
    @Param('eventId') eventId: string,
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<DeliveryListDto> {
    return this.events.listDeliveries(context, eventId, query);
  }

  @Post(':eventId/replay')
  // BOTH permissions. Replaying an event creates deliveries, and a role that
  // may re-send an event but may not be trusted with the delivery ledger is not
  // a role this product has.
  @Authorized('events.replay', 'deliveries.replay')
  @HttpCode(HttpStatus.CREATED)
  // Tighter than the per-delivery replay, because one request here can create
  // up to MAX_REPLAY_DELIVERIES real HTTP calls to a customer's infrastructure
  // rather than one.
  @Throttle({ name: 'events.replay', limit: 10, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Replay an event to one endpoint, or to all originally matched endpoints',
    description:
      '"Originally matched" is read off the EXISTING delivery rows, never by re-running the ' +
      'subscription match - subscriptions change, and re-matching would deliver to endpoints ' +
      'that were never targeted and skip ones that were. Every replay is a NEW delivery row ' +
      'carrying `replay_of_delivery_id` and `replayed_by`; no original row and no attempt is ' +
      'modified. An endpoint that has since been deleted or disabled is refused with a 409 ' +
      'rather than queued to nowhere.',
  })
  @ApiCreatedResponse({ type: ReplayResultDto })
  @ApiConflictResponse({
    description:
      'The event reached no endpoints, the named endpoint never received it, an endpoint is ' +
      `deleted or disabled, or the routing exceeds ${MAX_REPLAY_DELIVERIES} deliveries.`,
  })
  replay(
    @Tenant() context: RequestContext,
    @Param('eventId') eventId: string,
    @Body() dto: ReplayEventDto,
  ): Promise<ReplayResultDto> {
    return this.events.replay(context, eventId, dto);
  }
}
