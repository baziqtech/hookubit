-- ===========================================================================
-- event_outbox: resumable fan-out, and a poison bound that can tell a broken
-- row from a broken database.
--
-- Closes two HIGH-severity data-loss paths in the router. Both were paths where
-- an event that had already been answered `202 Accepted` was silently never
-- delivered, with no recovery available through any API.
--
--   1. FAN-OUT CAP TRUNCATION. `loadCandidates` took the first
--      ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT subscriptions `ORDER BY s.id`,
--      discarded the rest, logged at ERROR - and then COMMITTED: the event was
--      marked `processed`, the outbox row retired, and the dropped endpoints had
--      no delivery row. Because ids are ULIDs, `ORDER BY s.id` is creation
--      order, so the endpoints dropped were always the NEWEST: a project with
--      1,500 subscriptions had 500 that never received any event, ever. Replay
--      could not reach them either - it is built on existing delivery rows.
--
--      `fan_out_cursor` turns the cap into a BATCH bound. The router walks the
--      subscription list by keyset, one bounded transaction per batch, and only
--      marks the event `processed` when the last batch commits. The reason the
--      cap existed - bounding one transaction's size and memory - is preserved
--      exactly; the bound on the TOTAL, which is what dropped endpoints, is
--      gone. Committing a partial fan-out is safe because
--      `deliveries_event_endpoint_original_key` already makes delivery creation
--      idempotent per (event, endpoint).
--
--   2. FALSE PARKING. `attempts` is incremented on CLAIM, not on failure, and
--      that is correct: a row whose event kills the process never reaches a
--      failure handler, so an increment on the failure path would let it be
--      reclaimed and re-run forever. But it meant a degraded-Postgres window
--      burned all ROUTER_MAX_OUTBOX_ATTEMPTS claims without fan-out ever being
--      attempted, and the router then parked the row and failed the event.
--
--      `unaccounted_attempts` is incremented by the same claim and DECREMENTED
--      by any write the lease holder commits (a recorded release, or a batch
--      that made progress). What survives is exactly "claims that ended with the
--      router writing nothing at all" - which is the poison signal, intact.
--      `failing_since` bounds the other case by TIME instead, because no count
--      can tell "the database was unavailable for twenty minutes" from "this row
--      errors every time", and elapsed time can.
--
-- Additive and reversible. Every column is nullable or carries a default, no
-- existing column changes type or nullability, and nothing is rewritten: on
-- PostgreSQL 11+ an ADD COLUMN with a non-volatile default is a catalogue-only
-- change, so this does not lock `event_outbox` for a table rewrite.
-- ===========================================================================

ALTER TABLE "event_outbox"
    ADD COLUMN IF NOT EXISTS "fan_out_cursor" TEXT,
    ADD COLUMN IF NOT EXISTS "unaccounted_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "failing_since" TIMESTAMP(3);

-- Existing rows start with a full unaccounted budget rather than inheriting
-- `attempts`. Deliberate, and in the generous direction: the historical
-- `attempts` value conflates "crashed" with "the database was down", which is
-- precisely the distinction this migration introduces, so carrying it over would
-- park rows on evidence that is now known not to mean what it was read as.
-- Rows that really are poison re-earn their increments within minutes.

-- The control plane's parked-row listing and requeue
-- (apps/control-api/src/outbox) reach event_outbox THROUGH its event, because
-- that is where the tenancy is: `event_outbox` carries no organization_id or
-- project_id and must not - the router claims globally, and a denormalised
-- tenant column on a queue table is a column that can disagree with the row it
-- points at.
--
-- So the listing predicate is `event_id IN (SELECT id FROM events WHERE ...)`,
-- and PostgreSQL does not index a foreign key for you. Without this, requeueing
-- during an incident - when the parked set is largest and the events table is at
-- its busiest - is a sequential scan of event_outbox.
CREATE INDEX IF NOT EXISTS "event_outbox_event_id_idx"
    ON "event_outbox" ("event_id");

-- The operator's "what is stuck?" query: parked rows, newest first, within one
-- project. `status` first because the parked set is a tiny fraction of the
-- table, and `created_at` second so the page comes back already ordered.
-- Partial on the two statuses an operator ever asks about, so it stays small as
-- processed rows accumulate.
CREATE INDEX IF NOT EXISTS "event_outbox_attention_idx"
    ON "event_outbox" ("status", "created_at" DESC)
    WHERE "status" IN ('failed', 'pending');


-- ===========================================================================
-- CORRECTION to a comment in 20260907000000_handoff_schema_requests.
--
-- That migration's note beside `deliveries_ready_idx` (:390-396) says the Go
-- data plane "writes NULL to next_attempt_at on every TERMINAL transition", and
-- concludes that `deliveries.next_attempt_at` cannot be made NOT NULL until the
-- Go change lands. That is no longer true, and it is the kind of stale note that
-- makes someone abandon a constraint that is actually available:
-- `services/data-plane/internal/worker/store.go` writes `now()` on the terminal
-- branch of `advanceSQL`, and its own comment says the change was made precisely
-- to clear the way for NOT NULL.
--
-- The correction is recorded HERE rather than by editing that file, because
-- Prisma checksums each migration.sql into `_prisma_migrations`: editing an
-- applied migration - even only its comments - makes `prisma migrate deploy`
-- refuse to run against every environment that has already applied it. Migration
-- history is append-only, so a correction is an append. The same note has been
-- written into `model Delivery` in schema.prisma, which is where anyone weighing
-- the constraint will actually look.
--
-- What still blocks NOT NULL is data, not code: the column is nullable today, so
-- rows written before that Go change (or by an older build) may hold NULL, and
-- `SET NOT NULL` validates the whole table. The migration to write is a backfill
-- (`UPDATE deliveries SET next_attempt_at = COALESCE(next_attempt_at,
-- completed_at, created_at) WHERE next_attempt_at IS NULL`) followed by
-- `ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT`, so the largest table in
-- the system is not locked for a full scan. It is deliberately NOT done here:
-- this migration is about the outbox, and bundling a rewrite of `deliveries` into
-- it would make a small additive change something an operator has to schedule.
-- ===========================================================================
