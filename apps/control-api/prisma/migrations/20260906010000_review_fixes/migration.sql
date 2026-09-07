-- ---------------------------------------------------------------------------
-- Review fixes: delivery-ledger integrity, NULL-safe uniqueness, raw payload
-- bytes, ordering key, revocable sessions.
--
-- Several statements here CANNOT be expressed in schema.prisma (partial unique
-- indexes, NULLS NOT DISTINCT). They are hand-written and must be preserved
-- verbatim if this migration is ever regenerated. `prisma migrate diff` will
-- report the partial index as drift; that is expected, not a mistake.
--
-- Requires PostgreSQL 15+ for NULLS NOT DISTINCT. The dev compose runs
-- postgres:16.
-- ---------------------------------------------------------------------------

-- Fail fast and legibly on an unsupported server. Without this the migration
-- runs until the first NULLS NOT DISTINCT statement and then aborts partway,
-- leaving a failed row in _prisma_migrations that needs a manual
-- `prisma migrate resolve` before anything can deploy again.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'webhook-platform requires PostgreSQL 15 or newer (NULLS NOT DISTINCT); this server reports %',
      current_setting('server_version');
  END IF;
END
$$;


-- ===========================================================================
-- FIX 1 - fan-out idempotency arbiter
--
-- docs/DEVELOPMENT.md and the Phase 3 router both insert delivery rows "keyed
-- on (event_id, endpoint_id)", but only a non-unique index existed, so the
-- router's ON CONFLICT had no arbiter to name. A router that inserted its
-- deliveries and then died before marking the outbox row processed would be
-- re-run, and every subscriber would receive the event twice.
--
-- PARTIAL, because replay legitimately creates a second row for the same pair:
-- a replayed delivery carries replay_of_delivery_id and is excluded.
-- ===========================================================================
CREATE UNIQUE INDEX "deliveries_event_endpoint_original_key"
    ON "deliveries" ("event_id", "endpoint_id")
    WHERE "replay_of_delivery_id" IS NULL;

-- ===========================================================================
-- FIX 2 - the delivery ledger is not cascade-deletable
--
-- Organization -> Project -> Endpoint -> Delivery -> DeliveryAttempt and
-- Organization -> Project -> Event -> Delivery -> DeliveryAttempt were both ON
-- DELETE CASCADE. One prisma.endpoint.delete() therefore erased months of
-- attempt history, contradicting the append-only invariant on
-- delivery_attempts and the product question the table exists to answer.
--
-- Endpoint and project removal goes through status = 'deleted' (EndpointStatus
-- and ProjectStatus both already carry a `deleted` member); a hard delete of an
-- endpoint that has ever delivered now fails loudly instead of silently
-- shredding the ledger.
-- ===========================================================================
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_event_id_fkey";
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_endpoint_id_fkey";
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_fkey"
    FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- delivery_attempts -> deliveries stays ON DELETE CASCADE deliberately: nothing
-- can cascade into `deliveries` any more, so attempts can only disappear via an
-- explicit, deliberate delete of the parent delivery (retention jobs).

-- ===========================================================================
-- FIX 3 - unique constraints that were unenforceable on NULL
--
-- PostgreSQL indexes are NULLS DISTINCT by default: two rows whose indexed
-- column is NULL never collide. Both constraints below used NULL as a real
-- value with a real meaning, so the rows that most needed uniqueness were the
-- only ones exempt from it.
-- ===========================================================================

-- resource_id NULL means "every resource in this scope" - exactly the row that
-- must be unique per (project, scope).
DROP INDEX "rate_limit_policies_project_id_scope_resource_id_key";
CREATE UNIQUE INDEX "rate_limit_policies_project_id_scope_resource_id_key"
    ON "rate_limit_policies" ("project_id", "scope", "resource_id")
    NULLS NOT DISTINCT;

-- project_id NULL marks an org-level aggregate. The hourly aggregator upserts
-- on this key; under NULLS DISTINCT the upsert never matched and INSERTed a
-- fresh duplicate every run, so billing summed the same hour once per
-- aggregation pass and over-billed the customer.
DROP INDEX "usage_records_organization_id_project_id_metric_period_star_key";
CREATE UNIQUE INDEX "usage_records_organization_id_project_id_metric_period_star_key"
    ON "usage_records" ("organization_id", "project_id", "metric", "period_start")
    NULLS NOT DISTINCT;

-- ===========================================================================
-- FIX 4 - raw payload bytes are authoritative for signing
--
-- events.payload is jsonb, and PostgreSQL normalises jsonb: key order,
-- insignificant whitespace and duplicate keys are not preserved. ARCHITECTURE.md
-- 28 signs the EXACT raw payload bytes, so bytes read back from jsonb are not
-- the bytes received and every inline-payload signature would fail
-- verification at the consumer.
--
-- payload_raw is now the authoritative payload: sign it, deliver it, hash it
-- into payload_hash. payload (jsonb) is retained ONLY as a queryable projection
-- for filtering, search and the operator UI. Section 32 mentions jsonb;
-- section 28 governs.
-- ===========================================================================
ALTER TABLE "events" ADD COLUMN "payload_raw" BYTEA;

-- ===========================================================================
-- FIX 5 - ordering_key on events
--
-- docs/API.md documents the ingest API accepting ordering_key and
-- deliveries.ordering_key already exists, but events had nowhere to record it,
-- so the data plane was stashing it inside the headers JSON.
-- ===========================================================================
ALTER TABLE "events" ADD COLUMN "ordering_key" TEXT;

-- ===========================================================================
-- FIX 8 - revocable sessions
--
-- Sessions were stateless JWTs: logout cleared the cookie but could not
-- withdraw a token already copied off the machine, and there was no
-- "sign out everywhere" after a password reset.
-- ===========================================================================
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
