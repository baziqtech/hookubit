import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
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
import { ApiKeysService } from './api-keys.service';
import { ApiKeyDto, CreateApiKeyDto, CreatedApiKeyDto, ListApiKeysQueryDto } from './dto';

/**
 * `/v1/projects/:projectId/api-keys` (the `v1` prefix is applied in main.ts).
 *
 * Project-only path, no `:orgId`: `TenantResolver` reads the organization off
 * the project row and checks membership against THAT, so the project id in the
 * URL is a lookup key and never an authorization claim. A project belonging to
 * another tenant simply fails the membership test and answers 404.
 *
 * There is no update route, and there should not be. The mutable properties of
 * a credential are the ones you would want audited as a re-issue: widening a
 * key's scopes, extending its expiry or renaming it in place all change what a
 * credential already in the wild can do while its holder, its prefix and its
 * audit trail stay the same. Revoke and issue a new one.
 */
@ApiTags('api-keys')
@ApiCookieAuth('session')
@ApiParam({ name: 'projectId', example: 'proj_01J8ZK...' })
@ApiNotFoundResponse({
  description:
    "The project or key is not visible to this caller - absent, deleted, or another tenant's. " +
    'All of those answer identically, so this API cannot be used to confirm that an id is real.',
})
@ApiForbiddenResponse({
  description: 'Membership is proven but the role is short of the permission.',
})
@Controller('projects/:projectId/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @Authorized('api-keys.read')
  @ApiOperation({
    summary: 'List the API keys in a project',
    description:
      'Newest first. Revoked and expired keys are included and labelled by `status`; the ' +
      'secret is never returned here, only `key_prefix`.',
  })
  @ApiOkResponse({ type: [ApiKeyDto] })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListApiKeysQueryDto,
  ): Promise<ApiKeyDto[]> {
    return this.apiKeys.list(context, query);
  }

  @Post()
  @Authorized('api-keys.write')
  @ApiOperation({
    summary: 'Issue an API key',
    description:
      'THE ONLY RESPONSE THAT EVER CONTAINS THE PLAINTEXT KEY. Only its SHA-256 hash is ' +
      'stored, so it cannot be shown again by this or any other endpoint - show it to the user ' +
      'once and let them copy it. The environment is taken from the project (wk_test_ for a ' +
      'test project, wk_live_ for a live one) and cannot be chosen.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyDto })
  create(@Tenant() context: RequestContext, @Body() dto: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    return this.apiKeys.create(context, dto);
  }

  @Post(':apiKeyId/revoke')
  @Authorized('api-keys.write')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'apiKeyId', example: 'key_01J8ZK...' })
  @ApiOperation({
    summary: 'Revoke an API key',
    description:
      'Takes effect immediately: the ingest path refuses the key on its next request. The row ' +
      'is kept with `revoked_at` set, so the delivery history it produced stays attributable. ' +
      'Idempotent - revoking an already-revoked key returns it unchanged.',
  })
  @ApiOkResponse({ type: ApiKeyDto })
  revoke(
    @Tenant() context: RequestContext,
    @Param('apiKeyId') apiKeyId: string,
  ): Promise<ApiKeyDto> {
    return this.apiKeys.revoke(context, apiKeyId);
  }
}
