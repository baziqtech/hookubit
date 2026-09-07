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
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  CreateEndpointDto,
  CreatedEndpointDto,
  DisableEndpointDto,
  EndpointDto,
  EndpointListDto,
  ListEndpointsQueryDto,
  UpdateEndpointDto,
} from './dto';
import { EndpointsService } from './endpoints.service';

const MINUTE = 60_000;

/**
 * Thin: parse, delegate, return. Every decision is in `EndpointsService`.
 *
 * The tenant comes from `:projectId` - `TenantResolver` reads the project row,
 * takes the organization off it and checks membership against THAT, so the id in
 * the path is a lookup key and never an authorization claim. Nothing in this
 * file mentions an organization or a project id for that reason.
 */
@ApiTags('endpoints')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project or endpoint does not exist, or belongs to another tenant. The two are one ' +
    'answer, with one message, on purpose: a 403 here would confirm that an id scraped from ' +
    'somewhere else is live infrastructure belonging to another customer.',
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
@Controller('projects/:projectId/endpoints')
@UseGuards(ThrottleGuard)
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get()
  @Authorized('endpoints.read')
  @ApiOperation({
    summary: 'List the endpoints in a project',
    description:
      'Soft-deleted endpoints are hidden unless asked for; they are never erased. Paged with ' +
      'the canonical envelope `{ data, has_more, next_offset }`; `next_offset` is null on the ' +
      'last page.',
  })
  @ApiOkResponse({ type: EndpointListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListEndpointsQueryDto,
  ): Promise<EndpointListDto> {
    return this.endpoints.list(context, query);
  }

  @Post()
  @Authorized('endpoints.write')
  @HttpCode(HttpStatus.CREATED)
  // A create is an insert plus a minted, encrypted signing secret plus a
  // per-endpoint slice of the data plane's concurrency and rate-limit
  // bookkeeping. `MAX_ENDPOINTS_PER_PROJECT` bounds how many can exist; this
  // bounds how fast a loop can get there, and keeps the argon2-adjacent crypto
  // work off a single caller's spray.
  @Throttle({ name: 'endpoints.create', limit: 60, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Create an endpoint and its first signing secret',
    description:
      'The URL is checked for schemes, embedded credentials and literal private, loopback, ' +
      'link-local or cloud-metadata addresses so an unusable URL is refused now rather than ' +
      'becoming silent delivery failures later. A version 1 signing secret is minted with the ' +
      'endpoint - it is returned in this response only, and only to a caller who also holds ' +
      '`endpoint-secrets.write` (owner or admin).',
  })
  @ApiOkResponse({ type: CreatedEndpointDto })
  @ApiConflictResponse({
    description:
      '`limit_exceeded` - the project is at its endpoint ceiling; `details` carries ' +
      '`{ limit, current, resource }`. Every other 409 on this controller is a plain ' +
      '`conflict` (the endpoint is deleted, or has no active signing secret). Match on ' +
      '`error.code`, never on the message.',
  })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateEndpointDto,
  ): Promise<CreatedEndpointDto> {
    return this.endpoints.create(context, dto);
  }

  @Get(':endpointId')
  @Authorized('endpoints.read')
  @ApiOperation({
    summary: 'Fetch one endpoint',
    description:
      'Returns soft-deleted endpoints too, with `status: "deleted"`, so a delivery in the ' +
      'ledger that points at a removed endpoint is still readable.',
  })
  @ApiOkResponse({ type: EndpointDto })
  get(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
  ): Promise<EndpointDto> {
    return this.endpoints.get(context, endpointId);
  }

  @Patch(':endpointId')
  @Authorized('endpoints.write')
  @ApiOperation({
    summary: 'Update an endpoint',
    description:
      '`status` is not writable here. Enabling, disabling and deleting have their own routes ' +
      'because each has a precondition a PATCH would walk past.',
  })
  @ApiOkResponse({ type: EndpointDto })
  @ApiConflictResponse({ description: 'The endpoint has been deleted.' })
  update(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
    @Body() dto: UpdateEndpointDto,
  ): Promise<EndpointDto> {
    return this.endpoints.update(context, endpointId, dto);
  }

  @Post(':endpointId/enable')
  @Authorized('endpoints.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume deliveries to an endpoint',
    description:
      'Refused when the endpoint has no active signing secret: the data plane fails closed ' +
      'rather than delivering unsigned, so enabling would only queue failures.',
  })
  @ApiOkResponse({ type: EndpointDto })
  @ApiConflictResponse({ description: 'Deleted, or no active signing secret.' })
  enable(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
  ): Promise<EndpointDto> {
    return this.endpoints.enable(context, endpointId);
  }

  @Post(':endpointId/disable')
  @Authorized('endpoints.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause deliveries to an endpoint',
    description:
      'Queued deliveries are not discarded. The circuit breaker`s own `disabled_reason` and ' +
      '`disabled_at` are left untouched; the reason given here goes to the audit log.',
  })
  @ApiOkResponse({ type: EndpointDto })
  @ApiConflictResponse({ description: 'The endpoint has been deleted.' })
  disable(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
    @Body() dto: DisableEndpointDto,
  ): Promise<EndpointDto> {
    return this.endpoints.disable(context, endpointId, dto.reason);
  }

  @Delete(':endpointId')
  @Authorized('endpoints.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an endpoint (soft delete)',
    description:
      'Sets `status` to `deleted`. The row is kept forever: `deliveries.endpoint_id` is ' +
      'ON DELETE RESTRICT precisely so that removing an endpoint cannot erase the record of ' +
      'what it was sent. Idempotent.',
  })
  @ApiNoContentResponse()
  remove(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
  ): Promise<void> {
    return this.endpoints.remove(context, endpointId);
  }
}
