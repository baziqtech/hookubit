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

/**
 * The one list envelope this API has: `{ data, has_more, next_offset }`.
 *
 * This route used to answer `{ data, total, limit, offset }` and was the worst
 * of the three shapes the backend shipped, because it had no `has_more` at all.
 * A client cannot reliably derive one from `total`: the count and the page are
 * two reads, so a membership created between them makes `offset + data.length <
 * total` say "more" when there is none, or the reverse. `has_more` comes from
 * the same bounded read as the rows - the probe row `findPage` takes and
 * discards - so it is a fact about THIS page rather than an inference across
 * two.
 *
 * `total` is gone rather than renamed. It cost a second COUNT on every request
 * and bought a client paging on `has_more` nothing.
 */
export class OrganizationListDto {
  @ApiProperty({ type: [OrganizationDto] })
  data!: OrganizationDto[];

  @ApiProperty({
    description:
      'True when more organizations match than this page carries. Read this, never a row ' +
      'count compared against `limit`, to decide whether you have seen them all.',
    example: false,
  })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pass back as `offset` to fetch the next page. NULL - never absent, never 0 - when ' +
      'this page was the last one, so a client branches on one thing.',
    example: null,
  })
  next_offset!: number | null;
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
