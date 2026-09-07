import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  CreateSubscriptionDto,
  DisableSubscriptionDto,
  ListSubscriptionsQueryDto,
  SubscriptionDto,
  SubscriptionListDto,
  UpdateSubscriptionDto,
} from './dto';
import {
  SUBSCRIPTION_CREATE_THROTTLE,
  SUBSCRIPTION_MUTATE_THROTTLE,
} from './subscription-limits';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';

/**
 * `/v1/projects/:projectId/subscriptions` (the `v1` prefix is set in main.ts).
 *
 * Thin: parse, delegate, return. Every decision is in the service.
 *
 * Project-only path, no `:orgId`: `TenantResolver` reads the project row, takes
 * the organization off it and checks membership against THAT, so the id in the
 * path is a lookup key and never an authorization claim. Nothing in this file
 * mentions an organization or a project id for that reason.
 *
 * `ThrottleGuard` is mounted for the whole controller and limits only the
 * handlers carrying `@Throttle` - the five writes. Being a class-level guard it
 * runs BEFORE the `SessionGuard`/`TenantGuard` pair `@Authorized` mounts per
 * route, so a flood is refused before it costs a session lookup and a tenant
 * resolution.
 */
@ApiTags('subscriptions')
@ApiCookieAuth('session')
@ApiParam({ name: 'projectId', example: 'proj_01J8ZK...' })
@ApiNotFoundResponse({
  description:
    'The project, subscription or endpoint is not visible to this caller - absent, or another ' +
    "tenant's. Those answer identically, with one message, so this API cannot be used to " +
    'confirm that an id scraped from a log or an old dashboard URL is live infrastructure ' +
    'belonging to another customer.',
})
@ApiForbiddenResponse({
  description: 'Membership is proven but the role is short of the permission.',
})
@ApiTooManyRequestsResponse({
  description:
    'Rate limited. Carries `Retry-After` (seconds) and `details.retry_after_seconds`. Only the ' +
    'write routes are limited; the listing and the fetch are not.',
})
@UseGuards(ThrottleGuard)
@Controller('projects/:projectId/subscriptions')
export class WebhookSubscriptionsController {
  constructor(private readonly subscriptions: WebhookSubscriptionsService) {}

  @Get()
  @Authorized('subscriptions.read')
  @ApiOperation({
    summary: 'List the subscriptions in a project',
    description:
      'Newest first. `event_types` comes back exactly as it was stored. The envelope is ' +
      '`{ data, has_more, next_offset }` - there is no `total`, because it would cost a second ' +
      'COUNT on every request and a client pages on `has_more`. Read `has_more` before ' +
      'concluding you have seen every route out of this project, and pass `next_offset` back ' +
      'as `offset` to continue.',
  })
  @ApiOkResponse({ type: SubscriptionListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListSubscriptionsQueryDto,
  ): Promise<SubscriptionListDto> {
    return this.subscriptions.list(context, query);
  }

  @Post()
  @Authorized('subscriptions.write')
  @Throttle(SUBSCRIPTION_CREATE_THROTTLE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Subscribe an endpoint to a set of event types',
    description:
      'The filter is stored EXACTLY as sent. A pattern the router cannot honour is a 400 - it ' +
      'is never coerced to "*", and an empty `event_types` array is refused rather than ' +
      'guessed at. Subject to a per-project ceiling ' +
      '(`MAX_SUBSCRIPTIONS_PER_PROJECT`), enforced inside a serializable transaction because ' +
      'each subscription multiplies the deliveries one event produces.',
  })
  @ApiCreatedResponse({ type: SubscriptionDto })
  @ApiBadRequestResponse({
    description:
      'An event-type pattern is not one of "*", "prefix.*" or an exact type; `event_types` is ' +
      'empty; "*" appears alongside other patterns; or `payload_filter` is not a valid, ' +
      'bounded predicate. `details.field` names which.',
  })
  @ApiConflictResponse({
    description:
      'Two different 409s, told apart by `error.code`, never by the message. ' +
      '`limit_exceeded` - the project is at its subscription ceiling; ' +
      '`details` carries `{ limit, current, resource }`. ' +
      '`conflict` - the endpoint named by `endpoint_id` has been deleted.',
  })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateSubscriptionDto,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.create(context, dto);
  }

  @Get(':subscriptionId')
  @Authorized('subscriptions.read')
  @ApiParam({ name: 'subscriptionId', example: 'sub_01J8ZK...' })
  @ApiOperation({ summary: 'Fetch one subscription' })
  @ApiOkResponse({ type: SubscriptionDto })
  get(
    @Tenant() context: RequestContext,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.get(context, subscriptionId);
  }

  @Patch(':subscriptionId')
  @Authorized('subscriptions.write')
  @Throttle(SUBSCRIPTION_MUTATE_THROTTLE)
  @ApiParam({ name: 'subscriptionId', example: 'sub_01J8ZK...' })
  @ApiOperation({
    summary: 'Update a subscription',
    description:
      '`event_types` and `payload_filter` are REPLACED wholesale, not merged. `enabled` is not ' +
      'writable here - enabling and disabling have their own routes so that pausing a route ' +
      'is a distinct, separately auditable act rather than a field riding along in a rename. ' +
      'Both sides of a filter change are recorded in the audit log.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiBadRequestResponse({ description: 'Same validation as create. `details.field` names it.' })
  @ApiConflictResponse({ description: 'The new endpoint has been deleted.' })
  update(
    @Tenant() context: RequestContext,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: UpdateSubscriptionDto,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.update(context, subscriptionId, dto);
  }

  @Post(':subscriptionId/enable')
  @Authorized('subscriptions.write')
  @Throttle(SUBSCRIPTION_MUTATE_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'subscriptionId', example: 'sub_01J8ZK...' })
  @ApiOperation({
    summary: 'Resume matching for a subscription',
    description: 'Idempotent. The filter is untouched.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  enable(
    @Tenant() context: RequestContext,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.enable(context, subscriptionId);
  }

  @Post(':subscriptionId/disable')
  @Authorized('subscriptions.write')
  @Throttle(SUBSCRIPTION_MUTATE_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'subscriptionId', example: 'sub_01J8ZK...' })
  @ApiOperation({
    summary: 'Stop matching, keep the filter',
    description:
      'A disabled subscription is skipped before the event-type test, so it matches nothing at ' +
      'all. This - not an empty `event_types` array - is how you stop deliveries down one ' +
      'route. Deliveries already queued are not discarded. Idempotent; the reason goes to the ' +
      'audit log.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  disable(
    @Tenant() context: RequestContext,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: DisableSubscriptionDto,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.disable(context, subscriptionId, dto.reason);
  }

  @Delete(':subscriptionId')
  @Authorized('subscriptions.write')
  @Throttle(SUBSCRIPTION_MUTATE_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'subscriptionId', example: 'sub_01J8ZK...' })
  @ApiOperation({
    summary: 'Remove a subscription (hard delete)',
    description:
      'The row is really deleted, unlike endpoints and projects. Nothing has a foreign key to ' +
      '`webhook_subscriptions`, the delivery ledger keeps its own `endpoint_id` and `event_id`, ' +
      'and the whole routing rule is written to the audit log on the way out so a historical ' +
      "delivery's `subscription_id` stays explainable. Idempotent: deleting an " +
      'already-deleted subscription still answers 204.',
  })
  @ApiNoContentResponse()
  remove(
    @Tenant() context: RequestContext,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<void> {
    return this.subscriptions.remove(context, subscriptionId);
  }
}
