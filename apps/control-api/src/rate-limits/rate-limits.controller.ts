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
  CreateRateLimitDto,
  ListRateLimitsQueryDto,
  RateLimitDto,
  RateLimitListDto,
  UpdateRateLimitDto,
} from './dto';
import { RATE_LIMIT_WRITE_THROTTLE } from './rate-limit-limits';
import { RateLimitsService } from './rate-limits.service';

/**
 * Thin: parse, delegate, return. Every decision is in `RateLimitsService`.
 *
 * The tenant comes from `:projectId`, so the id in the path is a lookup key and
 * never an authorization claim. Every write carries `@Throttle`: each one is a
 * SERIALIZABLE transaction plus a uniqueness probe, and a loop on the create
 * route is contention as well as rows.
 */
@ApiTags('rate-limits')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project, the policy, or the resource named by `resource_id` does not exist or ' +
    'belongs to another tenant. One answer, one message: a 403 here would confirm that an id ' +
    'scraped from somewhere else is live infrastructure belonging to another customer.',
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
@Controller('projects/:projectId/rate-limits')
@UseGuards(ThrottleGuard)
export class RateLimitsController {
  constructor(private readonly rateLimits: RateLimitsService) {}

  @Get()
  @Authorized('policies.read')
  @ApiOperation({ summary: 'List the rate-limit policies in a project' })
  @ApiOkResponse({ type: RateLimitListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListRateLimitsQueryDto,
  ): Promise<RateLimitListDto> {
    return this.rateLimits.list(context, query);
  }

  @Post()
  @Authorized('policies.write')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(RATE_LIMIT_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Create a rate-limit policy',
    description:
      'One policy per `(scope, resource_id)`, including the `resource_id: null` row that ' +
      'means "every resource in this scope". A non-null `resource_id` is resolved through the ' +
      'scoped repository for whatever the scope names, so another tenant’s endpoint is a 404.',
  })
  @ApiOkResponse({ type: RateLimitDto })
  @ApiConflictResponse({
    description: 'A policy already covers this scope and resource, or the project is at its ceiling.',
  })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateRateLimitDto,
  ): Promise<RateLimitDto> {
    return this.rateLimits.create(context, dto);
  }

  @Get(':policyId')
  @Authorized('policies.read')
  @ApiOperation({ summary: 'Fetch one rate-limit policy' })
  @ApiOkResponse({ type: RateLimitDto })
  get(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
  ): Promise<RateLimitDto> {
    return this.rateLimits.get(context, policyId);
  }

  @Patch(':policyId')
  @Authorized('policies.write')
  @Throttle(RATE_LIMIT_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Update a rate-limit policy',
    description:
      '`scope` and `resource_id` are the row’s identity; changing either re-resolves the ' +
      'resource and re-checks uniqueness in the same transaction.',
  })
  @ApiOkResponse({ type: RateLimitDto })
  @ApiConflictResponse({ description: 'Another policy already covers the new scope and resource.' })
  update(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
    @Body() dto: UpdateRateLimitDto,
  ): Promise<RateLimitDto> {
    return this.rateLimits.update(context, policyId, dto);
  }

  @Delete(':policyId')
  @Authorized('policies.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(RATE_LIMIT_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Delete a rate-limit policy',
    description:
      'A hard delete: nothing in the delivery ledger references a rate-limit policy. Removing ' +
      'the last policy covering a resource means it falls back to the next scope up.',
  })
  @ApiNoContentResponse()
  remove(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
  ): Promise<void> {
    return this.rateLimits.remove(context, policyId);
  }
}
