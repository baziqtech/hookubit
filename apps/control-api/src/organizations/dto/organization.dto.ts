import { ApiProperty } from '@nestjs/swagger';
import { MemberRole, Organization, OrganizationStatus } from '@prisma/client';

/**
 * The wire shape of an organization.
 *
 * Snake case, matching the rest of the public API (`email_verified`,
 * `organization_name`). `role` is the CALLER's role in this organization, not a
 * property of the organization — the dashboard needs it on every row to decide
 * what to render, and a second round trip per organization to fetch it would be
 * an N+1 across the org switcher.
 */
export class OrganizationDto {
  @ApiProperty({ example: 'org_01J...' })
  id!: string;

  @ApiProperty({ example: 'Acme', maxLength: 200 })
  name!: string;

  @ApiProperty({ example: 'acme', description: 'Globally unique, URL-safe.' })
  slug!: string;

  @ApiProperty({ enum: ['active', 'suspended', 'deleted'], example: 'active' })
  status!: OrganizationStatus;

  @ApiProperty({
    enum: ['owner', 'admin', 'developer', 'viewer', 'billing'],
    description: "The requesting user's role in this organization.",
  })
  role!: MemberRole;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ format: 'date-time' })
  updated_at!: string;
}

export class OrganizationListDto {
  @ApiProperty({ type: [OrganizationDto] })
  data!: OrganizationDto[];

  @ApiProperty({ description: 'Total organizations the caller belongs to.' })
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

export function toOrganizationDto(
  organization: Organization,
  role: MemberRole,
): OrganizationDto {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    role,
    created_at: organization.createdAt.toISOString(),
    updated_at: organization.updatedAt.toISOString(),
  };
}
