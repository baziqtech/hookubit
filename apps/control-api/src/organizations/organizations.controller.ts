import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
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
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  CreateOrganizationDto,
  OrganizationDto,
  OrganizationListDto,
  PageQueryDto,
  UpdateOrganizationDto,
} from './dto';
import { OrganizationsService } from './organizations.service';
import { Principal, UserPrincipal, UserScoped } from './user-scope';

/**
 * Thin by design: parse, delegate, shape. Every decision is in the service.
 *
 * Two guard postures live side by side here, and which one a route gets is
 * decided by whether it names an organization:
 *
 *   `@UserScoped()`  — the collection routes. No tenant exists yet; the caller
 *                      is scoped to their own membership graph.
 *   `@Authorized()`  — everything under `:orgId`. Membership and role are proven
 *                      by `TenantGuard` before the handler runs, and a
 *                      cross-tenant id is a 404 from the guard.
 *
 * The permissions come from `TENANT_SCOPE_PERMISSIONS` in `authz/permissions.ts`,
 * which names `projects.read` as the read gate for the `organization` accessor
 * (every role holds it) and, per that table's own rule, `projects.write` as the
 * matching write gate.
 *
 * `ThrottleGuard` is mounted for the whole controller and limits only the
 * handlers carrying `@Throttle` — it is a no-op elsewhere, so the reads are
 * untouched. Every route in `AuthModule` carries a limit and none of these did,
 * which left `POST /v1/organizations` as unlimited row creation in a GLOBAL
 * slug namespace behind nothing but a session.
 */
const HOUR = 60 * 60 * 1000;

@ApiTags('organizations')
@ApiCookieAuth('session')
@UseGuards(ThrottleGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @UserScoped()
  @ApiOperation({
    summary: 'List the organizations the caller belongs to',
    description:
      'Scoped to the session user. Soft-deleted organizations are omitted, because every ' +
      'route under them already answers 404.',
  })
  @ApiOkResponse({ type: OrganizationListDto })
  async list(
    @Principal() principal: UserPrincipal,
    @Query() page: PageQueryDto,
  ): Promise<OrganizationListDto> {
    return this.organizations.list(principal, page);
  }

  @Post()
  @UserScoped()
  // Ten an hour per address, against a per-account total cap of
  // MAX_ORGANIZATIONS_PER_USER. The limit bounds the rate, the cap bounds the
  // total, and namespace squatting needs both bounded.
  @Throttle({ name: 'organizations.create', limit: 10, windowMs: HOUR })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an organization',
    description:
      'The caller becomes its owner. The organization, the owner membership and the audit ' +
      'row are written in one transaction. An omitted slug is derived from the name and ' +
      'suffixed if it is taken; an explicitly supplied slug that is taken returns 409. ' +
      'Rate limited, and capped per account.',
  })
  @ApiCreatedResponse({ type: OrganizationDto })
  @ApiConflictResponse({
    description: 'The requested slug is already taken, or the per-account limit is reached.',
  })
  async create(
    @Principal() principal: UserPrincipal,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationDto> {
    return this.organizations.create(principal, dto);
  }

  @Get(':orgId')
  @Authorized('projects.read')
  @ApiOperation({ summary: 'Read one organization' })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiOkResponse({ type: OrganizationDto })
  @ApiNotFoundResponse({ description: 'Absent, or the caller is not a member. Same answer.' })
  async get(@Tenant() context: RequestContext): Promise<OrganizationDto> {
    return this.organizations.get(context);
  }

  @Patch(':orgId')
  @Authorized('projects.write')
  @ApiOperation({
    summary: 'Rename an organization or change its slug',
    description: 'Status is not settable here; suspension is a platform decision.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiOkResponse({ type: OrganizationDto })
  @ApiConflictResponse({ description: 'The requested slug is already taken.' })
  async update(
    @Tenant() context: RequestContext,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationDto> {
    return this.organizations.update(context, dto);
  }

  @Delete(':orgId')
  @Authorized('projects.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete an organization',
    description:
      'Owner only, and never a hard delete: the delivery ledger hangs off this chain and its ' +
      'foreign keys are ON DELETE RESTRICT. Sets status=deleted, after which every route ' +
      'under the organization answers 404 for every member.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'The caller is a member but is not an owner.' })
  async remove(@Tenant() context: RequestContext): Promise<void> {
    await this.organizations.remove(context);
  }
}
