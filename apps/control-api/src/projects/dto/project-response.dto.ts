import { ApiProperty } from '@nestjs/swagger';
import { Environment, Project, ProjectStatus } from '@prisma/client';

/**
 * The project as the dashboard sees it. Snake_case on the wire, matching
 * `AuthUserDto` and the error envelope.
 */
export class ProjectDto {
  @ApiProperty({ example: 'proj_01J8ZK...' })
  id!: string;

  @ApiProperty({ example: 'org_01J8ZK...' })
  organization_id!: string;

  @ApiProperty({ example: 'Payments' })
  name!: string;

  @ApiProperty({
    example: 'payments',
    description: 'Unique within the organization. Deleted projects keep theirs.',
  })
  slug!: string;

  @ApiProperty({
    enum: Environment,
    enumName: 'Environment',
    description:
      'IMMUTABLE after creation. It selects which API keys (wk_live_/wk_test_) and which ' +
      'ingest traffic belong to this project, so changing it would silently re-scope every ' +
      'key and endpoint underneath it.',
  })
  environment!: Environment;

  @ApiProperty({
    enum: ProjectStatus,
    enumName: 'ProjectStatus',
    description:
      '`deleted` is a soft delete: the row and its delivery ledger survive, but the project ' +
      'is invisible to this API and the ingest path refuses its API keys.',
  })
  status!: ProjectStatus;

  @ApiProperty({
    type: [String],
    example: ['203.0.113.0/24'],
    description:
      'Addresses permitted to PUBLISH events to this project. EMPTY means every address may, ' +
      'which is the default. The data plane checks this before it judges whether the API key ' +
      'is valid, so a blocked address learns nothing about the credential it presented. ' +
      'Publishing only - never consulted for reading the record or for signing in, so it ' +
      'cannot lock anyone out of the dashboard.',
  })
  allowed_ips!: string[];

  @ApiProperty({
    type: Number,
    example: 3,
    description:
      'How many endpoints in this project would actually be sent a delivery right now: ' +
      '`status = active` AND `enabled = true`, counted in the database. Both halves are ' +
      'needed - `enabled` is operator intent and `status` is the circuit breaker\'s verdict, ' +
      'so an endpoint auto-disabled after its failure window still reads `enabled: true` and ' +
      'is NOT counted here. Soft-deleted endpoints are never counted.\n\n' +
      'WHAT IT DOES NOT SAY. It is not a health number: an endpoint can be active, enabled and ' +
      'failing every attempt for as long as it takes the breaker to trip, and it is counted the ' +
      'whole time. It is a count of CONFIGURATION, not of successful deliveries - read the ' +
      'analytics routes for those.\n\n' +
      'It also describes the endpoints, not the project: a project whose own `status` is ' +
      '`deleted` can report a count above zero, because deleting a project leaves its ' +
      'endpoints exactly as they were (so undeleting it resumes them) while the ingest path ' +
      'refuses the project\'s API keys. Read `status` alongside this, or a deleted project ' +
      'reads as though it were still delivering.',
  })
  active_endpoint_count!: number;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ format: 'date-time' })
  updated_at!: string;
}

/**
 * A page of projects, and the one fact a bare array cannot carry.
 *
 * The list route used to return `ProjectDto[]`. A caller that received exactly
 * `limit` rows could not tell a full page from a complete result, so "disable
 * every project in this organization" quietly covered the first page and
 * reported success - the same defect `ScopedRepository.findMany` now throws
 * over. `has_more` is the answer; `next_offset` is the offset that returns the
 * rest, and is null on the last page.
 *
 * Exactly three keys. `count` used to sit alongside them and was removed: it
 * was `data.length` restated, it invited precisely the `count === limit`
 * last-page test `has_more` exists to replace, and it made this envelope a
 * third shape in an API that should have one.
 */
export class ProjectListDto {
  @ApiProperty({ type: [ProjectDto] })
  data!: ProjectDto[];

  @ApiProperty({
    description:
      'True when more projects match this filter than the page carries. The bound was reached; ' +
      'fetch `next_offset` to continue.',
    example: false,
  })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Pass as `offset` to fetch the next page. Null when this page was the last one.',
    example: null,
  })
  next_offset!: number | null;
}

/** What copying from another project actually produced. */
export class TemplateResultDto {
  @ApiProperty() endpoints!: number;
  @ApiProperty() subscriptions!: number;
  @ApiProperty() retry_policies!: number;

  @ApiProperty({
    description:
      'ALWAYS 0, and it is in the response so the client can say so out loud. Secrets are never ' +
      'copied — a leak in one project stays in one project — and it is why nothing this copy ' +
      'produced is delivering yet.',
  })
  signing_secrets!: number;
}

/** `POST /projects` — the project, plus what a copy produced, if one was asked for. */
export class CreatedProjectDto extends ProjectDto {
  @ApiProperty({
    type: () => TemplateResultDto,
    nullable: true,
    description: 'Null when nothing was copied.',
  })
  copied!: TemplateResultDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the copy failed, when one was asked for and did not work. The PROJECT still exists: ' +
      'an empty project is recoverable — copy again, or start from empty — and rolling the ' +
      'create back would lose it and explain nothing.',
  })
  copy_error!: string | null;
}

/**
 * `activeEndpointCount` is a REQUIRED SECOND ARGUMENT, not an optional one and
 * not a default of zero.
 *
 * The count cannot be derived from the `projects` row, so it has to be supplied
 * by whoever already knows it - and every route that returns a project is a
 * route that can afford one bounded aggregate (see
 * `ProjectsService.activeEndpointCounts`, which takes ONE grouped query for a
 * whole page). Defaulting it would make the honest case and the forgotten case
 * indistinguishable on the wire: `0` is a real answer that a dashboard renders
 * as "nothing is delivering here", and a mapper that produces it by omission
 * turns a missed query into a customer-visible lie rather than a compile error.
 */
export function toProjectDto(project: Project, activeEndpointCount: number): ProjectDto {
  return {
    id: project.id,
    organization_id: project.organizationId,
    name: project.name,
    slug: project.slug,
    environment: project.environment,
    status: project.status,
    allowed_ips: project.allowedIps ?? [],
    active_endpoint_count: activeEndpointCount,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}
