import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ format: 'date-time' })
  updated_at!: string;
}

export class ProjectListDto {
  @ApiProperty({ type: [ProjectDto] })
  data!: ProjectDto[];

  @ApiPropertyOptional({
    description: 'Rows returned by this page. Compare against `limit` to detect the last page.',
  })
  count!: number;
}

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    organization_id: project.organizationId,
    name: project.name,
    slug: project.slug,
    environment: project.environment,
    status: project.status,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}
