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
const outboxRecovery = read(
  'migrations',
  '20260909000000_outbox_fan_out_resume_and_recovery',
  'migration.sql',
);
const flatOutboxRecovery = flatten(outboxRecovery);
const flatRenameToRouting = flatten(
  read('migrations', '20260923000000_rename_fan_out_to_routing', 'migration.sql'),
);
/**
 * The DDL with `--` comments removed. These migrations carry long rationale
 * comments that legitimately NAME the statements they are explaining ("what
 * still blocks NOT NULL is..."), so a check for a forbidden statement has to
 * read the SQL rather than the prose about it.
 */
function statementsOnly(sql: string): string {
  return flatten(sql.replace(/--[^\n]*/g, ' '));
}
const flatFixes = flatten(fixes);
const allMigrations = flatten(`${init}\n${fixes}`);

describe('FIX 1 - routing cannot double-deliver', () => {
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

describe('the outbox can resume a routing, and a parked row can be recovered', () => {
  it('adds the resume cursor that turns the routing cap into a BATCH bound', () => {
    // Without this column the router took the first `cap` subscriptions
    // ORDER BY s.id, dropped the rest and COMMITTED - marking the event
    // `processed` while the newest endpoints (ULIDs sort by creation) held no
    // delivery row, permanently, with replay unable to reach them.
    // The column was ADDED as `fan_out_cursor` and RENAMED by
    // 20260923000000_rename_fan_out_to_routing. Applied migrations are
    // checksummed, so the original keeps the original name for ever; this
    // asserts the pair, because either half alone would pass against a
    // database whose column does not exist.
    expect(flatOutboxRecovery).toContain('ADD COLUMN IF NOT EXISTS "fan_out_cursor" TEXT');
    expect(flatRenameToRouting).toContain(
      'ALTER TABLE "event_outbox" RENAME COLUMN "fan_out_cursor" TO "routing_cursor"',
    );
    expect(schema).toContain('routingCursor String?     @map("routing_cursor")');
  });

  it('splits the poison bound off the monotonic claim count', () => {
    // `attempts` increments on CLAIM, which is right - a row that kills the
    // process never reaches a failure handler. But it meant a degraded-Postgres
    // window burned the whole budget on rows whose routing was never attempted.
    expect(flatOutboxRecovery).toContain(
      'ADD COLUMN IF NOT EXISTS "unaccounted_attempts" INTEGER NOT NULL DEFAULT 0',
    );
    expect(flatOutboxRecovery).toContain('ADD COLUMN IF NOT EXISTS "failing_since" TIMESTAMP(3)');
    expect(schema).toContain('unaccountedAttempts Int   @default(0) @map("unaccounted_attempts")');
    expect(schema).toContain('failingSince DateTime?   @map("failing_since")');
  });

  it('indexes the tenant path the control plane reaches parked rows through', () => {
    // event_outbox carries no organization_id/project_id - deliberately - so the
    // scoped listing is `event_id IN (SELECT id FROM events WHERE ...)`, and
    // PostgreSQL does not index a foreign key for you.
    expect(flatOutboxRecovery).toContain(
      'CREATE INDEX IF NOT EXISTS "event_outbox_event_id_idx" ON "event_outbox" ("event_id")',
    );
  });

  it('indexes the operator\'s "what is stuck?" page, partially', () => {
    expect(flatOutboxRecovery).toMatch(
      /CREATE INDEX IF NOT EXISTS "event_outbox_attention_idx" ON "event_outbox" \("status", "created_at" DESC\) WHERE "status" IN \('failed', 'pending'\);/,
    );
  });

  it('is additive only - no column changes type or nullability', () => {
    // The dev database is live and a load test may be running against it. An
    // ADD COLUMN with a non-volatile default is catalogue-only on PostgreSQL
    // 11+; an ALTER TYPE or SET NOT NULL here would rewrite or lock the table.
    const ddl = statementsOnly(outboxRecovery);
    expect(ddl).not.toMatch(/ALTER COLUMN/);
    expect(ddl).not.toMatch(/DROP COLUMN/);
    expect(ddl).not.toMatch(/SET NOT NULL/);
  });

  it('records the next_attempt_at correction here rather than editing an applied migration', () => {
    // Prisma checksums each migration.sql into `_prisma_migrations`; editing an
    // applied one - even only its comments - makes `migrate deploy` refuse to
    // run against every environment that already has it. Corrections append.
    const handoff = read('migrations', '20260907000000_handoff_schema_requests', 'migration.sql');
    // The stale claim, still on disk and deliberately not edited.
    expect(handoff).toContain('NOT NULL would fail every succeed');
    expect(flatOutboxRecovery).toContain('CORRECTION to a comment in 20260907000000');
    // Superseded in turn by 20260911000000_next_attempt_at_not_null, which
    // ALSO appended rather than editing: the constraint landed, and the schema
    // says where the stale sentence is and why it is still there.
    expect(schema).toContain('NOT NULL, and it was made so by APPENDING a migration');
    expect(schema).toContain('nextAttemptAt  DateTime       @default(now()) @map("next_attempt_at")');
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
    expect(flatten(init)).not.toContain('unaccounted_attempts');
    expect(flatFixes).not.toContain('unaccounted_attempts');
  });

  it('says out loud that `prisma migrate diff` will report drift here', () => {
    expect(fixes).toMatch(/migrate diff/);
    expect(schema).toMatch(/Prisma cannot express a\s+\/\/\/ partial unique index/);
  });
});
