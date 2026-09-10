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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  CreateRetryPolicyDto,
  DeleteRetryPolicyQueryDto,
  ListRetryPoliciesQueryDto,
  RetryPolicyDto,
  RetryPolicyListDto,
  UpdateRetryPolicyDto,
} from './dto';
import { RetryPoliciesService } from './retry-policies.service';
import { RETRY_POLICY_WRITE_THROTTLE } from './retry-policy-limits';

/**
 * Thin: parse, delegate, return. Every decision is in `RetryPoliciesService`.
 *
 * The tenant comes from `:projectId` — `TenantResolver` reads the project row,
 * takes the organization off it and checks membership against THAT, so the id
 * in the path is a lookup key and never an authorization claim.
 *
 * Every write carries `@Throttle`. A policy row is cheap, but each create is an
 * insert plus a SERIALIZABLE transaction and an audit row, and `set-default` is
 * a write over every policy row in the project — a loop on that route is a
 * contention generator, not just a row generator.
 */
@ApiTags('retry-policies')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project or policy does not exist, or belongs to another tenant. The two are one ' +
    'answer, with one message, on purpose: a 403 here would confirm that an id scraped from ' +
    'somewhere else is live configuration belonging to another customer.',
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
@Controller('projects/:projectId/retry-policies')
@UseGuards(ThrottleGuard)
export class RetryPoliciesController {
  constructor(private readonly policies: RetryPoliciesService) {}

  @Get()
  @Authorized('policies.read')
  @ApiOperation({ summary: 'List the retry policies in a project' })
  @ApiOkResponse({ type: RetryPolicyListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListRetryPoliciesQueryDto,
  ): Promise<RetryPolicyListDto> {
    return this.policies.list(context, query);
  }

  @Post()
  @Authorized('policies.write')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(RETRY_POLICY_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Create a retry policy',
    description:
      'Every field is bounded to something the delivery workers can compute a positive, ' +
      'finite delay from — an unbounded `max_delay_ms` is what once overflowed the computed ' +
      'duration and scheduled retries permanently in the past. The FIRST policy in a project ' +
      'becomes its default automatically.',
  })
  @ApiOkResponse({ type: RetryPolicyDto })
  @ApiConflictResponse({ description: 'The project is at its retry-policy ceiling.' })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateRetryPolicyDto,
  ): Promise<RetryPolicyDto> {
    return this.policies.create(context, dto);
  }

  @Get(':policyId')
  @Authorized('policies.read')
  @ApiOperation({ summary: 'Fetch one retry policy' })
  @ApiOkResponse({ type: RetryPolicyDto })
  get(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
  ): Promise<RetryPolicyDto> {
    return this.policies.get(context, policyId);
  }

  @Patch(':policyId')
  @Authorized('policies.write')
  @Throttle(RETRY_POLICY_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Update a retry policy',
    description:
      '`is_default` is not writable here — it has its own route, because "exactly one default ' +
      'per project" is a property of a set of rows and needs a transaction that clears the ' +
      'old one. The patch is validated MERGED with the stored row, so a single field cannot ' +
      'walk the policy into an incoherent combination.',
  })
  @ApiOkResponse({ type: RetryPolicyDto })
  update(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
    @Body() dto: UpdateRetryPolicyDto,
  ): Promise<RetryPolicyDto> {
    return this.policies.update(context, policyId, dto);
  }

  @Post(':policyId/default')
  @Authorized('policies.write')
  @HttpCode(HttpStatus.OK)
  @Throttle(RETRY_POLICY_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Make this the project default retry policy',
    description:
      'Clears the previous default and sets this one inside a single SERIALIZABLE ' +
      'transaction. Two concurrent calls cannot both win: the schema has no partial unique ' +
      'index, so nothing else would stop a project ending up with two defaults.',
  })
  @ApiOkResponse({ type: RetryPolicyDto })
  setDefault(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
  ): Promise<RetryPolicyDto> {
    return this.policies.setDefault(context, policyId);
  }

  @Delete(':policyId')
  @Authorized('policies.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(RETRY_POLICY_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Delete a retry policy',
    description:
      'Refused while any live endpoint references it: `endpoints.retry_policy_id` is ' +
      'ON DELETE SET NULL, so the delete would silently move those endpoints onto the ' +
      'platform default backoff. Deleting the project default also requires ' +
      '`?replacement_id=`, unless it is the only policy left.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description: 'Endpoints still reference it, or it is the default and no successor was named.',
  })
  remove(
    @Tenant() context: RequestContext,
    @Param('policyId') policyId: string,
    @Query() query: DeleteRetryPolicyQueryDto,
  ): Promise<void> {
    return this.policies.remove(context, policyId, query.replacement_id);
  }
}
