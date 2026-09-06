import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Schema regression tests.
 *
 * No database is available in CI for this suite, and several of these fixes
 * CANNOT be expressed in schema.prisma at all - a partial unique index and
 * NULLS NOT DISTINCT are hand-written SQL. A regenerated migration, or a
 * well-meaning `prisma migrate dev` that "tidies" the folder, would silently
 * drop them and the defect would come back invisibly. These tests assert the
 * SQL text itself, which is the artefact that actually reaches PostgreSQL.
 *
 * Whitespace is normalised so formatting changes do not fail the build.
 */
const PRISMA_DIR = join(__dirname, '..', '..', '..', 'prisma');

function read(...parts: string[]): string {
  return readFileSync(join(PRISMA_DIR, ...parts), 'utf8');
}

/** Collapse runs of whitespace so multi-line DDL matches a single-line pattern. */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

const schema = read('schema.prisma');
const init = read('migrations', '20260906000000_init', 'migration.sql');
const fixes = read('migrations', '20260906010000_review_fixes', 'migration.sql');
const flatFixes = flatten(fixes);
const allMigrations = flatten(`${init}\n${fixes}`);

describe('FIX 1 - fan-out cannot double-deliver', () => {
  it('has a unique index on (event_id, endpoint_id) for the router to name as an ON CONFLICT arbiter', () => {
    expect(flatFixes).toContain(
      'CREATE UNIQUE INDEX "deliveries_event_endpoint_original_key" ON "deliveries" ("event_id", "endpoint_id")',
    );
  });

  it('makes that index PARTIAL, so replay may legitimately re-create the pair', () => {
    expect(flatFixes).toMatch(
      /CREATE UNIQUE INDEX "deliveries_event_endpoint_original_key" ON "deliveries" \("event_id", "endpoint_id"\) WHERE "replay_of_delivery_id" IS NULL;/,
    );
  });

  it('did not exist before, which is the bug', () => {
    expect(flatten(init)).not.toContain('deliveries_event_endpoint_original_key');
  });
});

describe('FIX 2 - the delivery ledger is not cascade-deletable', () => {
  it('restricts deletion of an event that has deliveries', () => {
    expect(flatFixes).toContain(
      'ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT',
    );
  });

  it('restricts deletion of an endpoint that has deliveries', () => {
    expect(flatFixes).toContain(
      'ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE RESTRICT',
    );
  });

  it('drops the cascading constraints rather than adding a second one', () => {
    expect(flatFixes).toContain('ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_event_id_fkey"');
    expect(flatFixes).toContain('ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_endpoint_id_fkey"');
  });

  it('leaves no cascading path from events or endpoints into deliveries', () => {
    // The last constraint definition wins; assert none of them cascade.
    const definitions = allMigrations.match(
      /ADD CONSTRAINT "deliveries_(?:event|endpoint)_id_fkey"[^;]*/g,
    );
    expect(definitions).not.toBeNull();
    expect(definitions!.filter((d) => d.includes('ON DELETE RESTRICT'))).toHaveLength(2);
  });

  it('is reflected in schema.prisma so `prisma generate` agrees with the database', () => {
    expect(schema).toContain(
      'event    Event             @relation(fields: [eventId], references: [id], onDelete: Restrict)',
    );
    expect(schema).toContain(
      'endpoint Endpoint          @relation(fields: [endpointId], references: [id], onDelete: Restrict)',
    );
  });

  it('keeps a soft-delete state to remove endpoints through', () => {
    expect(schema).toMatch(/enum EndpointStatus \{[^}]*deleted/);
    expect(schema).toMatch(/enum ProjectStatus \{[^}]*deleted/);
  });
});

describe('FIX 3 - unique constraints enforceable on NULL', () => {
  it('replaces the rate-limit policy index with a NULLS NOT DISTINCT one', () => {
    expect(flatFixes).toContain('DROP INDEX "rate_limit_policies_project_id_scope_resource_id_key"');
    expect(flatFixes).toMatch(
      /CREATE UNIQUE INDEX "rate_limit_policies_project_id_scope_resource_id_key" ON "rate_limit_policies" \("project_id", "scope", "resource_id"\) NULLS NOT DISTINCT;/,
    );
  });

  it('replaces the usage-record index with a NULLS NOT DISTINCT one', () => {
    // Org-level rows carry project_id NULL; without this the hourly aggregator
    // inserts a duplicate every run and billing over-charges.
    expect(flatFixes).toContain(
      'DROP INDEX "usage_records_organization_id_project_id_metric_period_star_key"',
    );
    expect(flatFixes).toMatch(
      /CREATE UNIQUE INDEX "usage_records_organization_id_project_id_metric_period_star_key" ON "usage_records" \("organization_id", "project_id", "metric", "period_start"\) NULLS NOT DISTINCT;/,
    );
  });

  it('keeps the Prisma @@unique so upserts still type-check against the compound key', () => {
    expect(schema).toContain('@@unique([projectId, scope, resourceId])');
    expect(schema).toContain('@@unique([organizationId, projectId, metric, periodStart])');
  });
});

describe('FIX 4 - signing reads raw bytes, not normalised jsonb', () => {
  it('adds a bytea column for the exact payload received', () => {
    expect(flatFixes).toContain('ALTER TABLE "events" ADD COLUMN "payload_raw" BYTEA;');
    expect(schema).toContain('payloadRaw     Bytes?      @map("payload_raw")');
  });

  it('keeps the jsonb projection and documents which column is authoritative', () => {
    expect(schema).toContain('payload        Json?');
    expect(schema).toContain('AUTHORITATIVE PAYLOAD');
    expect(schema).toContain('NON-AUTHORITATIVE');
    expect(schema).toMatch(/Never sign it, never\s+\/\/\/ deliver it/);
  });
});

describe('FIX 5 - ordering_key on events', () => {
  it('adds the column the ingest API documents', () => {
    expect(flatFixes).toContain('ALTER TABLE "events" ADD COLUMN "ordering_key" TEXT;');
    expect(schema).toContain('orderingKey    String?     @map("ordering_key")');
  });

  it('matches the column deliveries already had', () => {
    expect(schema).toContain('orderingKey    String?        @map("ordering_key")');
  });
});

describe('FIX 8 - sessions are revocable', () => {
  it('creates the sessions table with a revocation column', () => {
    expect(flatFixes).toContain('CREATE TABLE "sessions"');
    expect(flatFixes).toContain('"revoked_at" TIMESTAMP(3)');
    expect(flatFixes).toContain(
      'ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE',
    );
  });

  it('indexes the lookups the guard and the reaper make', () => {
    expect(flatFixes).toContain('CREATE INDEX "sessions_user_id_revoked_at_idx"');
    expect(flatFixes).toContain('CREATE INDEX "sessions_expires_at_idx"');
  });

  it('models it in schema.prisma', () => {
    expect(schema).toMatch(/model Session \{/);
    expect(schema).toContain('@@map("sessions")');
  });
});

describe('migration hygiene', () => {
  it('does not modify the already-applied initial migration', () => {
    // 20260906000000_init is checked in and may already be applied; every fix
    // belongs in the new directory.
    expect(init).not.toContain('NULLS NOT DISTINCT');
    expect(init).not.toContain('payload_raw');
    expect(init).not.toContain('deliveries_event_endpoint_original_key');
    // deliveries.ordering_key was always there; events.ordering_key was not.
    expect(flatten(init)).not.toContain('ALTER TABLE "events" ADD COLUMN');
  });

  it('says out loud that `prisma migrate diff` will report drift here', () => {
    expect(fixes).toMatch(/migrate diff/);
    expect(schema).toMatch(/Prisma cannot express a\s+\/\/\/ partial unique index/);
  });
});
