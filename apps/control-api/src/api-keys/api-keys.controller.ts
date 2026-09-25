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
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { API_KEY_CREATE_THROTTLE, API_KEY_REVOKE_THROTTLE } from './api-key-limits';
import { ApiKeysService } from './api-keys.service';
import {
  ApiKeyDto,
  ApiKeyListDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  ListApiKeysQueryDto,
} from './dto';

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
 *
 * `ThrottleGuard` is mounted for the controller and limits only the handlers
 * carrying `@Throttle` (the two writes). Being a class-level guard it runs
 * BEFORE the `SessionGuard`/`TenantGuard` pair that `@Authorized` mounts per
 * route, so a flood is refused before it costs a session lookup and a tenant
 * resolution.
 */
@ApiTags('api-keys')
@ApiCookieAuth('session')
@ApiParam({ name: 'projectId', type: String, example: 'proj_01J8ZK...', description: 'Project id, `proj_…`.' })
@ApiNotFoundResponse({
  description:
    "The project or key is not visible to this caller - absent, deleted, or another tenant's. " +
    'All of those answer identically, so this API cannot be used to confirm that an id is real.',
})
@ApiForbiddenResponse({
  description: 'Membership is proven but the role is short of the permission.',
})
@ApiTooManyRequestsResponse({
  description:
    'Rate limited. Carries `Retry-After` (seconds) and `details.retry_after_seconds`. Only the ' +
    'write routes are limited; the listing is not.',
})
@UseGuards(ThrottleGuard)
@Controller('projects/:projectId/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @Authorized('api-keys.read')
  @ApiOperation({
    summary: 'List the API keys in a project',
    description:
      'Newest first. Revoked and expired keys are included and labelled by `status`; the ' +
      'secret is never returned here, only `key_prefix`. Paged with the canonical envelope ' +
      '`{ data, has_more, next_offset }` - BREAKING: `count` was removed. Read `has_more` ' +
      'before concluding you have seen every credential in the project, and pass ' +
      '`next_offset` back as `offset` to continue; it is null on the last page.',
  })
  @ApiOkResponse({ type: ApiKeyListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListApiKeysQueryDto,
  ): Promise<ApiKeyListDto> {
    return this.apiKeys.list(context, query);
  }

  @Post()
  @Authorized('api-keys.write')
  @Throttle(API_KEY_CREATE_THROTTLE)
  @ApiOperation({
    summary: 'Issue an API key',
    description:
      'THE ONLY RESPONSE THAT EVER CONTAINS THE PLAINTEXT KEY. Only its SHA-256 hash is ' +
      'stored, so it cannot be shown again by this or any other endpoint - show it to the user ' +
      'once and let them copy it. The environment is taken from the project (wk_test_ for a ' +
      'test project, wk_live_ for a live one) and cannot be chosen. Rate limited, and subject ' +
      'to a per-project ceiling (`MAX_API_KEYS_PER_PROJECT`) that counts un-revoked keys.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyDto })
  @ApiConflictResponse({
    description:
      '`limit_exceeded` - the project is at its API-key ceiling; `details` carries ' +
      '`{ limit, current, resource }`. Revoke a key to free a slot. Match on `error.code`, ' +
      'never on the message.',
  })
  create(@Tenant() context: RequestContext, @Body() dto: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    return this.apiKeys.create(context, dto);
  }

  @Post(':apiKeyId/revoke')
  @Authorized('api-keys.write')
  @Throttle(API_KEY_REVOKE_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'apiKeyId', type: String, example: 'key_01J8ZK...', description: 'API key id, `key_…`.' })
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
