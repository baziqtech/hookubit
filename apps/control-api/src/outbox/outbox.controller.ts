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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  ListOutboxQueryDto,
  OutboxEntryDto,
  OutboxEntryListDto,
  RequeueOutboxDto,
  RequeueParkedDto,
  RequeueResultDto,
} from './dto';
import { MAX_REQUEUE_BATCH } from './outbox-limits';
import { OutboxService } from './outbox.service';

const MINUTE = 60_000;

/**
 * Thin: parse, delegate, return. Every decision is in `OutboxService`.
 *
 * The tenant comes from `:projectId`, resolved from the project row, so the id
 * in the path is a lookup key and never an authorization claim. Outbox rows
 * carry no tenant columns of their own; they are scoped through their event.
 */
@ApiTags('outbox')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project, outbox entry or event does not exist, or belongs to another tenant. One answer ' +
    'with one message for all of them, on purpose: these routes take an outbox id in the path AND ' +
    'an event id in the query or body, so distinguishable 404s would say which KIND of resource ' +
    "an id names - which confirms it is live infrastructure belonging to another customer.",
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
// `type: String` is not decoration. Without it `@ApiParam` emits a parameter
// with no schema, and `openapi-typescript` renders it as `unknown` - see
// `ApiKeysController_revoke` in apps/dashboard/src/types/api.d.ts, which types
// `projectId: unknown` for exactly that reason. An `unknown` in a generated path
// parameter is the cheap half of the type drift this document is supposed to
// prevent: it compiles, and it makes the client's caller do the asserting.
@ApiParam({
  name: 'projectId',
  type: String,
  example: 'proj_01J8ZK...',
  description: 'The project the events belong to. Resolved from the project row, never trusted.',
})
@Controller('projects/:projectId/outbox')
@UseGuards(ThrottleGuard)
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Get()
  @Authorized('events.read')
  @ApiOperation({
    summary: 'List outbox entries, including PARKED ones',
    description:
      'The outbox is the router\'s record of what it still owes an accepted event. Filter by ' +
      '`status=failed` for the entries that matter: those are PARKED - the router gave up, and ' +
      'the event will never be delivered until someone requeues it, even though the publisher was ' +
      'told `202 Accepted`. `last_error` says why, `attempts` versus `unaccounted_attempts` says ' +
      'whether the row was killing the router or the database was failing under it, and a ' +
      'non-null `fan_out_cursor` says the fan-out is partly done. Ordered newest first.',
  })
  @ApiOkResponse({ type: OutboxEntryListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListOutboxQueryDto,
  ): Promise<OutboxEntryListDto> {
    return this.outbox.list(context, query);
  }

  /**
   * BULK REQUEUE. Declared BEFORE `:outboxId/requeue` for readability only -
   * the two paths are different depths, so Nest cannot confuse them.
   */
  @Post('requeue')
  // BOTH permissions, exactly as event replay requires them. A requeue causes
  // real outbound HTTP to a customer's infrastructure and writes delivery rows,
  // so a role that may put events back but is not trusted with the delivery
  // ledger is not a role this product has. It is deliberately NOT gated on a
  // permission of its own: this is the same power as replay-to-all, applied to
  // an event that never fanned out, and owner/admin/developer is exactly the set
  // that should hold it.
  @Authorized('events.replay', 'deliveries.replay')
  @HttpCode(HttpStatus.OK)
  // As tight as event replay, and for the same reason: one request here can put
  // MAX_REQUEUE_BATCH fan-outs into the queue, each of which becomes real HTTP
  // calls to endpoints that were, very often, already failing.
  @Throttle({ name: 'outbox.requeue', limit: 10, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Requeue parked outbox entries',
    description:
      `Returns up to ${MAX_REQUEUE_BATCH} PARKED entries to the router's queue, oldest first, ` +
      'so the fan-out that never ran gets to run. Read `has_more` and call again until it is ' +
      'false; the bound is per request, not per incident. ' +
      '**This is not a replay.** A parked event has no delivery rows for a replay to work from, ' +
      'so the router runs the subscription match it never got to run. That match is bounded to ' +
      'the subscriptions that existed when the event was ACCEPTED - an endpoint subscribed after ' +
      'that will not receive it - but their current configuration applies, and a subscription ' +
      'deleted since is gone. The router\'s `last_error` is preserved, `attempts` keeps counting ' +
      'from where it was, and a partly-completed fan-out resumes from its cursor rather than ' +
      're-sending to endpoints it already reached.',
  })
  @ApiOkResponse({ type: RequeueResultDto })
  requeueParked(
    @Tenant() context: RequestContext,
    @Body() dto: RequeueParkedDto,
  ): Promise<RequeueResultDto> {
    return this.outbox.requeueParked(context, dto);
  }

  @Get(':outboxId')
  @Authorized('events.read')
  @ApiParam({ name: 'outboxId', type: String, example: 'obx_01J8ZK...' })
  @ApiOperation({
    summary: 'Fetch one outbox entry',
    description:
      'The full router-side state of one entry, for the detail view behind a parked row. Nothing ' +
      'here is derived: every field is what the data plane wrote.',
  })
  @ApiOkResponse({ type: OutboxEntryDto })
  get(
    @Tenant() context: RequestContext,
    @Param('outboxId') outboxId: string,
  ): Promise<OutboxEntryDto> {
    return this.outbox.get(context, outboxId);
  }

  @Post(':outboxId/requeue')
  @Authorized('events.replay', 'deliveries.replay')
  @ApiParam({ name: 'outboxId', type: String, example: 'obx_01J8ZK...' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ name: 'outbox.requeue', limit: 10, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Requeue one parked outbox entry',
    description:
      'The single-entry form of the bulk requeue above; see it for what a requeue does and how it ' +
      'differs from a replay. Only a PARKED entry (`status: failed`) can be requeued.',
  })
  @ApiOkResponse({ type: OutboxEntryDto })
  @ApiConflictResponse({
    description:
      'The entry is not parked: `pending`/`processing` means a router is already working on it, ' +
      '`processed` means the fan-out completed and the route you want is event replay.',
  })
  requeue(
    @Tenant() context: RequestContext,
    @Param('outboxId') outboxId: string,
    @Body() dto: RequeueOutboxDto,
  ): Promise<OutboxEntryDto> {
    return this.outbox.requeue(context, outboxId, dto);
  }
}
