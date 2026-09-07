import {
  Body,
  Controller,
  Delete,
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
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, ResolveTenantFrom, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  EndpointSecretDto,
  EndpointSecretListDto,
  ListSecretsQueryDto,
  RotateSecretDto,
  RotatedSecretDto,
} from './dto';
import { EndpointSecretsService } from './endpoint-secrets.service';
import { DEFAULT_OVERLAP_SECONDS } from './secret-generator';

const MINUTE = 60_000;

/**
 * `/v1/endpoints/:endpointId/secrets` - addressed by endpoint, not nested under
 * a project, so `@ResolveTenantFrom('endpoint', 'endpointId')` walks
 * endpoint -> project -> organization in the database and checks membership at
 * the top of that chain. The id in the path is never an authorization claim.
 *
 * Every route needs `endpoint-secrets.*`, which is **owner and admin only** and
 * is deliberately NOT implied by `endpoints.read`. A viewer or a developer can
 * see the endpoint and gets a 403 here: an HMAC signing secret authenticates
 * every outbound call the platform makes on the customer's behalf, so whoever
 * holds it can forge a webhook into the customer's own consumers. It is a
 * strictly stronger credential than the API-key inventory the same matrix
 * already withholds from a viewer.
 */
@ApiTags('endpoint-secrets')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description: 'No such endpoint, or it belongs to another tenant - one answer for both.',
})
@ApiForbiddenResponse({
  description: 'You are in this tenant, but signing secrets are owner/admin only.',
})
@Controller('endpoints/:endpointId/secrets')
@ResolveTenantFrom('endpoint', 'endpointId')
@UseGuards(ThrottleGuard)
export class EndpointSecretsController {
  constructor(private readonly secrets: EndpointSecretsService) {}

  @Get()
  @Authorized('endpoint-secrets.read')
  @ApiOperation({
    summary: 'List signing secret metadata',
    description:
      'Metadata only. No response on this route can contain a plaintext secret - the ' +
      'response type has no field it could occupy. A secret is shown exactly once, when it ' +
      'is created.',
  })
  @ApiOkResponse({ type: EndpointSecretListDto })
  list(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
    @Query() query: ListSecretsQueryDto,
  ): Promise<EndpointSecretListDto> {
    return this.secrets.list(context, endpointId, query);
  }

  @Post('rotate')
  @Authorized('endpoint-secrets.write')
  @HttpCode(HttpStatus.CREATED)
  // Every rotation mints a credential, encrypts it and re-times every live
  // secret on the endpoint, under a row lock the whole endpoint contends on.
  // A loop over this route is both a write amplifier and a way to churn a
  // consumer's secrets faster than they can redeploy - so it is charged per
  // address, like every AuthModule write.
  @Throttle({ name: 'endpoint-secrets.rotate', limit: 30, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Issue a new signing secret, keeping the old one valid',
    description:
      'The new secret becomes active immediately and the current ones keep signing until ' +
      `\`overlap_seconds\` (default ${DEFAULT_OVERLAP_SECONDS}) elapses. During that window ` +
      'every delivery carries one `v1=` signature per active secret and a consumer that ' +
      'verifies with either one succeeds, so consumers can be rolled without dropping a ' +
      'delivery. The plaintext is in this response and nowhere else, ever.',
  })
  @ApiOkResponse({ type: RotatedSecretDto })
  @ApiConflictResponse({
    description: 'The endpoint is deleted, or a concurrent rotation took the next version.',
  })
  rotate(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
    @Body() dto: RotateSecretDto,
  ): Promise<RotatedSecretDto> {
    return this.secrets.rotate(context, endpointId, dto.overlap_seconds);
  }

  @Delete(':secretId')
  @Authorized('endpoint-secrets.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop one secret signing',
    description:
      'Refused when it is the only secret still signing for a live endpoint: that state ' +
      'makes every delivery fail closed rather than go out unsigned. To retire a leaked ' +
      'secret immediately, rotate with `overlap_seconds: 0`.',
  })
  @ApiOkResponse({ type: EndpointSecretDto })
  @ApiConflictResponse({ description: 'This is the endpoint`s last active secret.' })
  revoke(
    @Tenant() context: RequestContext,
    @Param('endpointId') endpointId: string,
    @Param('secretId') secretId: string,
  ): Promise<EndpointSecretDto> {
    return this.secrets.revoke(context, endpointId, secretId);
  }
}
