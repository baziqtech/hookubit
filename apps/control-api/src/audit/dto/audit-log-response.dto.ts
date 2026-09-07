import { ApiProperty } from '@nestjs/swagger';
import { AuditLog, Prisma } from '@prisma/client';

/**
 * The wire shape of one audit row.
 *
 * Built by an explicit mapper rather than by returning the Prisma row, for the
 * same reason every other module does it: a column added to `audit_logs` later
 * must not appear in a customer-facing response because nobody thought about
 * it. That argument is sharper here than anywhere else - this table is written
 * by every module in the platform, so the set of things that can end up in it
 * grows without this file being touched.
 *
 * `metadata` is passed through EXACTLY as stored. `AuditService.sanitise`
 * redacted it at write time, and nothing here may widen that: no join back to
 * the resource the row describes, no re-reading a value the writer replaced
 * with `[redacted]`, no "helpful" reconstruction. The redaction is a key-name
 * regex and it is known to be imperfect in both directions - it has replaced a
 * whole object because its key contained "secrets", and it has been
 * depth-limited - but the correct response to an over-redaction is a better
 * regex at the write site, not a read path that goes and fetches the value
 * again. A read path that could recover a redacted value would make the
 * redaction decorative.
 */
export class AuditLogDto {
  @ApiProperty({ example: 'aud_01J...' })
  id!: string;

  @ApiProperty({ example: 'org_01J...' })
  organization_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'usr_01J...',
    description:
      'The user who did it. Null for a row with no user actor. Taken from the resolved tenant ' +
      'context at write time, never from a request body, so it cannot be forged.',
  })
  user_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Set instead of `user_id` when the actor was an API key. No path currently writes it - ' +
      'the column exists for the day an API-key principal carries a resolved context - so it ' +
      'reads back null on every row today.',
  })
  api_key_id!: string | null;

  @ApiProperty({
    example: 'endpoint.created',
    description: '`<resource>.<verb>`, past tense. Not a closed enum; modules add their own.',
  })
  action!: string;

  @ApiProperty({ example: 'endpoint' })
  resource_type!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ep_01J...',
    description: 'The row that was acted on. Null when the action had no single subject.',
  })
  resource_id!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { name: 'finance', url: 'https://finance.example.com/hook' },
    description:
      'What changed, as recorded. ALREADY REDACTED at write time: values under key names that ' +
      'look like credentials read back as "[redacted]", and anything nested deeper than the ' +
      'walk goes reads back as "[truncated]". This route never reverses either. Null when the ' +
      'writer recorded nothing.',
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '203.0.113.9',
    description:
      'The address the action came from. This field, and `user_agent`, are why the permission ' +
      'is `audit.read` (owner/admin) and not `members.read`: these rows carry other members’ ' +
      'whereabouts, and viewer and billing hold `members.read`.',
  })
  ip_address!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 ...' })
  user_agent!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

/**
 * The canonical list envelope: `{ data, has_more, next_offset }`. Exactly three
 * keys, the same three every list route in this API returns.
 *
 * There is no `total`. On `audit_logs` - the largest table in the control plane
 * and the one that only grows - a COUNT for every list request is a real cost
 * on a route an investigator refreshes, and it buys a client paging on
 * `has_more` nothing.
 */
export class AuditLogListDto {
  @ApiProperty({ type: [AuditLogDto] })
  data!: AuditLogDto[];

  @ApiProperty({
    description:
      'True when more rows match this filter than the page carries. Read this, never a row ' +
      'count compared against `limit`, before concluding you have seen everything.',
    example: false,
  })
  has_more!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pass back as `offset` to fetch the next page. NULL - never absent, never 0 - when this ' +
      'page was the last one, so a client branches on one thing.',
    example: null,
  })
  next_offset!: number | null;
}

/**
 * `metadata` is `Json?`, so Prisma types it as `JsonValue`.
 *
 * A JSON array or scalar is not a shape `AuditService` can write (it sanitises
 * an object or writes SQL NULL), so anything else reads back as null rather
 * than being coerced into an object-shaped lie. The object is shallow-copied so
 * the response cannot alias a row a caller might still hold.
 */
function metadataOf(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...(value as Prisma.JsonObject) };
}

export function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    organization_id: row.organizationId,
    user_id: row.userId,
    api_key_id: row.apiKeyId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    metadata: metadataOf(row.metadata),
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    created_at: new Date(row.createdAt).toISOString(),
  };
}
