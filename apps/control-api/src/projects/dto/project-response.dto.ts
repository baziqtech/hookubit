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

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    organization_id: project.organizationId,
    name: project.name,
    slug: project.slug,
    environment: project.environment,
    status: project.status,
    allowed_ips: project.allowedIps ?? [],
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}
