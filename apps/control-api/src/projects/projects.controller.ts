import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
import {
  CreateProjectDto,
  ListProjectsQueryDto,
  ProjectDto,
  UpdateProjectDto,
} from './dto';
import { ProjectsService } from './projects.service';

/**
 * Thin: parse, delegate, return. Every rule lives in `ProjectsService`.
 *
 * Nothing here mentions an organization id. `@Authorized` mounts SessionGuard
 * then TenantGuard, which resolves `:orgId` (and `:projectId` where present)
 * against the database and proves membership before the handler runs; the
 * service then queries through a repository that has the tenant predicate baked
 * into every statement.
 *
 * The global prefix `v1` is applied in main.ts, so these routes are served at
 * `/v1/organizations/:orgId/projects`.
 */
@ApiTags('projects')
@ApiCookieAuth('session')
@ApiParam({ name: 'orgId', example: 'org_01J8ZK...' })
@ApiNotFoundResponse({
  description:
    'The organization or project is not visible to this caller - it does not exist, it is ' +
    'deleted, or it belongs to another tenant. All three answer identically and with the same ' +
    'message, so the response cannot be used to prove another customer\'s ids are real.',
})
@ApiForbiddenResponse({
  description: 'Membership is proven but the role is short of the permission.',
})
@Controller('organizations/:orgId/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @Authorized('projects.read')
  @ApiOperation({
    summary: 'List the projects in an organization',
    description: 'Newest first. Soft-deleted projects are hidden unless `status=deleted`.',
  })
  @ApiOkResponse({ type: [ProjectDto] })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListProjectsQueryDto,
  ): Promise<ProjectDto[]> {
    return this.projects.list(context, query);
  }

  @Post()
  @Authorized('projects.write')
  @ApiOperation({
    summary: 'Create a project',
    description:
      'The `environment` chosen here is permanent. `slug` defaults to a normalised form of ' +
      '`name` and must be unique within the organization.',
  })
  @ApiCreatedResponse({ type: ProjectDto })
  @ApiConflictResponse({ description: 'The slug is already taken in this organization.' })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateProjectDto,
  ): Promise<ProjectDto> {
    return this.projects.create(context, dto);
  }

  @Get(':projectId')
  @Authorized('projects.read')
  @ApiParam({ name: 'projectId', example: 'proj_01J8ZK...' })
  @ApiOperation({ summary: 'Fetch one project' })
  @ApiOkResponse({ type: ProjectDto })
  get(
    @Tenant() context: RequestContext,
    @Param('projectId') projectId: string,
  ): Promise<ProjectDto> {
    return this.projects.get(context, projectId);
  }

  @Patch(':projectId')
  @Authorized('projects.write')
  @ApiParam({ name: 'projectId', example: 'proj_01J8ZK...' })
  @ApiOperation({
    summary: 'Rename a project or change its slug',
    description:
      '`name` and `slug` only. `environment` is immutable and `status` is not editable here ' +
      '(use DELETE); both are refused with `invalid_request` rather than ignored.',
  })
  @ApiOkResponse({ type: ProjectDto })
  @ApiConflictResponse({ description: 'The slug is already taken in this organization.' })
  update(
    @Tenant() context: RequestContext,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<ProjectDto> {
    return this.projects.update(context, projectId, dto);
  }

  @Delete(':projectId')
  @Authorized('projects.write')
  @ApiParam({ name: 'projectId', example: 'proj_01J8ZK...' })
  @ApiOperation({
    summary: 'Soft-delete a project',
    description:
      'Sets `status = deleted`. Nothing is erased: endpoints, API keys and the whole delivery ' +
      'ledger survive, the project stops being visible to this API, and the ingest path refuses ' +
      'its API keys. The slug stays taken. Returns the project in its deleted state.',
  })
  @ApiOkResponse({ type: ProjectDto })
  remove(
    @Tenant() context: RequestContext,
    @Param('projectId') projectId: string,
  ): Promise<ProjectDto> {
    return this.projects.remove(context, projectId);
  }
}
