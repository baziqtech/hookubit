import { Prisma } from '@prisma/client';
import { RequestContext } from './tenant-context';

/**
 * The one data-returning raw statement in this layer: the first N bytes of a set
 * of event payloads, sliced by PostgreSQL.
 *
 * ## Why it is raw at all
 *
 * `events.payload_raw` is a `bytea` holding up to `PAYLOAD_MAX_BYTES` (1 MiB,
 * services/data-plane/internal/config/config.go:265). The deliveries list is the
 * hottest read path in the product and pages up to `MAX_PAGE_SIZE` (200) rows,
 * and it now carries a short preview of each body. Prisma has no way to express
 * a partial read of a column: `select: { payloadRaw: true }` fetches the whole
 * value, so the preview would cost up to 200 x 64 KiB (the inline ceiling) of
 * bytes pulled out of PostgreSQL and thrown away on every list request - the
 * same memory and connection-pool exhaustion vector `MAX_PAGE_SIZE` and the
 * `findMany` clamp exist to close, reintroduced one column over.
 *
 * `substring(payload_raw from 1 for N)` costs 640 bytes per row instead, which
 * is why this is the one place the layer drops to SQL.
 *
 * ## Why it is HERE
 *
 * Because a hand-written tenant predicate is exactly what `ScopedRepository`
 * exists to make impossible to forget, so it does not get to live in a feature
 * module. The predicate below is the SQL spelling of
 * `tenantPredicate('projectAndOrganization', context)` - the same strategy
 * `scope.events` uses - and it sits next to it, in the directory the eslint
 * fence already allows to touch the unscoped client, where a review of "is this
 * scoped?" is one file away from the thing it is being compared against.
 *
 * It is reached as `scope.eventPayloadHeads(...)`, so a feature module still
 * injects `TenantScopeFactory` and nothing else from the data layer.
 */

/**
 * A marker the statement carries so a test double can recognise it.
 *
 * `FakeTenantPrisma.$queryRaw` emulates this one query and refuses anything
 * else. Without the tag it would have to guess from the SQL text, and a second
 * raw query added later would silently be answered with payload heads.
 */
export const EVENT_PAYLOAD_HEAD_TAG = 'event_payload_head';

/** One row of the statement, as PostgreSQL returns it. */
export interface EventPayloadHeadRow {
  id: string;
  /** First `maxBytes` bytes of `payload_raw`, or null when the column is NULL. */
  head: Uint8Array | null;
  /** `octet_length(payload_raw)`: the FULL inline length, not the slice's. */
  inline_bytes: number | null;
  /** `events.payload_size`: the whole body, recorded at ingest. Never null. */
  payload_size: number;
  payload_location: string | null;
}

/**
 * The statement, with its parameters in a FIXED order:
 *
 *   $1 maxBytes, $2 event ids, $3 organization id, [$4 project id]
 *
 * Fixed because `FakeTenantPrisma` reads them positionally. An `= ANY($2)` over
 * one array parameter rather than an `IN (...)` list is what keeps the arity
 * fixed however many ids are passed - and it is one plan in PostgreSQL rather
 * than a new one per distinct id count.
 */
export function eventPayloadHeadQuery(
  context: RequestContext,
  eventIds: readonly string[],
  maxBytes: number,
): Prisma.Sql {
  const projectId = context.project?.id ?? null;

  // The project column when the route resolved a project, the organization
  // alone when it did not - which is still a complete tenant boundary. Branched
  // here rather than as `($4 IS NULL OR project_id = $4)` so the emitted SQL
  // says which of the two predicates ran.
  const project = projectId === null ? Prisma.empty : Prisma.sql`AND project_id = ${projectId}`;

  return Prisma.sql`
    -- ${Prisma.raw(EVENT_PAYLOAD_HEAD_TAG)}
    SELECT id,
           substring(payload_raw from 1 for ${maxBytes}::int) AS head,
           octet_length(payload_raw) AS inline_bytes,
           payload_size,
           payload_location
    FROM events
    WHERE id = ANY(${[...eventIds]}::text[])
      AND organization_id = ${context.organization.id}
      ${project}
  `;
}

/**
 * Payload heads for these event ids, keyed by id, fenced to the caller's tenant.
 *
 * An id from another tenant is simply absent from the map - the same answer the
 * scoped repositories give, so this cannot be used to probe for event ids - and
 * so is an id whose event has been deleted. A caller must treat a missing key as
 * "no preview", never as an error: the list row is still the record of a
 * delivery that was made.
 */
export async function readEventPayloadHeads(
  client: { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> },
  context: RequestContext,
  eventIds: readonly string[],
  maxBytes: number,
): Promise<Map<string, EventPayloadHeadRow>> {
  // No ids means no statement. A `= ANY('{}')` would be a round trip that can
  // only return nothing, on the path whose whole point is being cheap.
  if (eventIds.length === 0) return new Map();

  const rows = await client.$queryRaw<EventPayloadHeadRow[]>(
    eventPayloadHeadQuery(context, eventIds, maxBytes),
  );
  return new Map(rows.map((row) => [row.id, row]));
}
