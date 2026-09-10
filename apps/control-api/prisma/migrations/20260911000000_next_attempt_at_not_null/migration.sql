-- ---------------------------------------------------------------------------
-- deliveries.next_attempt_at becomes NOT NULL (ADR-0007; data-plane HANDOFF
-- item 7), and the two ready-set indexes are rebuilt for the ordering the
-- claim uses once NULL is impossible.
--
-- WHY THIS IS NOT TIDYING.
--
-- Until now the claim in services/data-plane/internal/queue ordered by
-- `next_attempt_at NULLS FIRST`, so NULL was not a neutral value: it sorted
-- AHEAD of every retry that was actually due. One code path writing a NULL
-- silently promoted that row to the front of the queue and nothing failed - the
-- symptom was a retry starving until max_retry_duration and being reported to
-- the customer as THEIR endpoint failing when the platform never re-attempted
-- it. NOT NULL turns that latent ordering hazard into a constraint violation at
-- the moment the mistake is made.
--
-- WHY IT COULD NOT BE DONE BEFORE, AND WHAT CHANGED.
--
-- 20260907000000_handoff_schema_requests skipped this because
-- internal/worker's advanceSQL wrote `next_attempt_at = ... ELSE NULL END` on
-- EVERY terminal transition, so the constraint would have rejected every
-- successful delivery. That ELSE branch now writes now(). A terminal row
-- therefore carries a next_attempt_at with no scheduling meaning: status alone
-- keeps it out of the ready set (claimStatuses is the five non-terminal
-- states). Every write site has been checked - advanceSQL (fixed),
-- insertDeliveriesSQL in internal/router (already now()), the control plane's
-- replay insert (already now()); releaseSQL/reclaimSQL/renewSQL do not touch
-- the column. Two integration tests pin it: TestStoreCompleteMarksTerminalStates
-- (internal/worker) and TestTerminalDeliveriesAreNeverClaimed (internal/queue).
--
-- ===========================================================================
-- DEPLOY ORDERING - THIS ONE IS NOT INTERCHANGEABLE.
--
-- The data-plane binary carrying the advanceSQL fix MUST be live everywhere
-- before the constraint below is applied. Apply the constraint first and every
-- terminal transition still in flight from an OLDER worker - including
-- successful deliveries - fails its UPDATE, the transaction rolls back, the
-- delivery_attempts row goes with it, and the delivery sits in `processing`
-- until its lease expires and it is retried against an endpoint that has
-- ALREADY received it. So:
--
--   1. Deploy the data plane (workers, scheduler, router) at a revision whose
--      advanceSQL writes now() on the terminal branch.
--   2. Confirm no older worker is still running.
--   3. Run the backfill (step 1 below). It is idempotent; run it as often as
--      you like.
--   4. Apply the rest.
--
-- Rolling the binary back after the constraint is applied has the same failure
-- mode, so the constraint must be DROPPED before any rollback past that
-- revision:  ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
--
-- Nothing is deployed anywhere at the time of writing; this is a note for the
-- first environment where the two planes roll separately.
-- ===========================================================================
--
-- SAFE ON A POPULATED TABLE - WITH ONE CAVEAT ABOUT PRISMA.
--
-- Steps 2-4 are the PostgreSQL 12+ idiom for NOT NULL without a full-table scan
-- under ACCESS EXCLUSIVE: a CHECK added NOT VALID (catalogue-only), VALIDATEd
-- under SHARE UPDATE EXCLUSIVE (the scan; concurrent writes continue), and then
-- SET NOT NULL, which skips its own scan because a validated CHECK already
-- proves the column. That idiom only pays off when the three run in SEPARATE
-- transactions, and Prisma wraps this whole file in one - so applied as-is on a
-- large populated table, the lock from step 2 is held through the scan in step
-- 3 and the index builds in step 6. On such an installation run the steps by
-- hand first, one transaction each, with `SET lock_timeout = '5s'`:
--
--     UPDATE deliveries SET next_attempt_at = created_at WHERE next_attempt_at IS NULL;
--     ALTER TABLE deliveries ADD CONSTRAINT deliveries_next_attempt_at_not_null
--         CHECK (next_attempt_at IS NOT NULL) NOT VALID;
--     ALTER TABLE deliveries VALIDATE CONSTRAINT deliveries_next_attempt_at_not_null;
--     ALTER TABLE deliveries ALTER COLUMN next_attempt_at SET NOT NULL;
--     ALTER TABLE deliveries DROP CONSTRAINT deliveries_next_attempt_at_not_null;
--     ALTER TABLE deliveries ALTER COLUMN next_attempt_at SET DEFAULT CURRENT_TIMESTAMP;
--     CREATE INDEX CONCURRENTLY deliveries_ready_idx_rebuilt
--         ON deliveries (organization_id, project_id, next_attempt_at, created_at, id)
--      WHERE status IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');
--     DROP INDEX CONCURRENTLY deliveries_ready_idx;
--     ALTER INDEX deliveries_ready_idx_rebuilt RENAME TO deliveries_ready_idx;
--     CREATE INDEX CONCURRENTLY deliveries_ready_fifo_idx_rebuilt
--         ON deliveries (next_attempt_at, created_at, id)
--      WHERE status IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');
--     DROP INDEX CONCURRENTLY deliveries_ready_fifo_idx;
--     ALTER INDEX deliveries_ready_fifo_idx_rebuilt RENAME TO deliveries_ready_fifo_idx;
--
-- Every step below then finds its work already done and does nothing: the
-- backfill matches no row, the NOT NULL block sees attnotnull and returns, the
-- index blocks see no NULLS FIRST in the existing definition and keep it.
--
-- THE INDEX REBUILD, AND WHY IT IS IN THIS MIGRATION.
--
-- Both ready-set indexes were built `(... next_attempt_at NULLS FIRST, ...)`
-- to match the claim's ORDER BY. Once the claim drops NULLS FIRST the planner
-- no longer treats those indexes as delivering its ordering - pathkey matching
-- compares the nulls direction and does NOT reason from the column being NOT
-- NULL - and adds a Sort over the whole ready set. Measured on PostgreSQL 16.2
-- before this migration: `ORDER BY next_attempt_at, created_at, id` against
-- the NULLS FIRST index planned as Index Scan -> Sort -> LockRows -> Limit,
-- where the NULLS FIRST form planned as Index Scan -> Incremental Sort. So the
-- Go change and this rebuild must land together, which is why the rebuild is
-- here rather than in a later migration.
--
-- `id` is appended as a third key. Earlier the same day the claim statements
-- gained `id` as a deterministic tiebreaker (see the comment on claimFIFOSQL):
-- a fan-out batch is inserted by ONE statement, so every row in it ties on
-- (next_attempt_at, created_at) exactly. Without `id` in the index the planner
-- serves that tiebreaker with an Incremental Sort that has to read the WHOLE
-- tie group - the whole fan-out - before it can emit the first row of a LIMIT
-- 10 claim, on every poll of every worker. With it the index delivers the
-- claim's order outright and the plan has no sort node at all;
-- TestClaimStatementsCanUseTheReadySetIndexes in internal/queue pins that.
-- Twenty-six bytes per entry over the READY set, which is bounded by backlog
-- rather than by history.
--
-- Names are unchanged, so deployments/ci/expected-schema-drift.txt still holds
-- and the CI step that looks every name up in pg_indexes still passes. The
-- rebuild is keyed on the OLD definition (`NULLS FIRST` in pg_indexes.indexdef)
-- rather than on the name, so an index already rebuilt by hand under the
-- CONCURRENTLY recipe above is left alone rather than dropped and rebuilt
-- under a lock.
--
-- CREATE INDEX IF NOT EXISTS, not CONCURRENTLY, for the reason every earlier
-- migration gives: Prisma runs this file in a transaction and CONCURRENTLY
-- cannot run inside one.
-- ---------------------------------------------------------------------------

-- 1. Backfill rows written before the data-plane fix. Bounded by history, not
--    by backlog; no new NULL can appear once that binary is live. created_at is
--    what a NULL meant operationally - "due since it was written" - and it is
--    the value the claim's COALESCE(next_attempt_at, created_at) used to
--    substitute for it, so the backfilled row keeps exactly the queue position
--    it had.
UPDATE "deliveries"
   SET "next_attempt_at" = "created_at"
 WHERE "next_attempt_at" IS NULL;

-- 2/3/4. Prove it, then promote it, then drop the scaffolding. Skipped as a
--        whole when the column is already NOT NULL (a hand-run of the recipe
--        above, or a re-applied migration), so this file is idempotent.
DO $$
BEGIN
  IF (SELECT attnotnull
        FROM pg_attribute
       WHERE attrelid = '"deliveries"'::regclass
         AND attname  = 'next_attempt_at') THEN
    RAISE NOTICE 'deliveries.next_attempt_at is already NOT NULL; nothing to do';
    RETURN;
  END IF;

  ALTER TABLE "deliveries"
    ADD CONSTRAINT "deliveries_next_attempt_at_not_null"
    CHECK ("next_attempt_at" IS NOT NULL) NOT VALID;
  ALTER TABLE "deliveries"
    VALIDATE CONSTRAINT "deliveries_next_attempt_at_not_null";
  ALTER TABLE "deliveries"
    ALTER COLUMN "next_attempt_at" SET NOT NULL;
  ALTER TABLE "deliveries"
    DROP CONSTRAINT "deliveries_next_attempt_at_not_null";
END $$;

-- 5. So a future INSERT cannot omit it. ADR-0007 says "defaulted to
--    created_at"; a column default cannot reference another column, and the
--    current time IS that value for any row being inserted. CURRENT_TIMESTAMP
--    is now() under its SQL-standard name - the spelling Prisma itself emits
--    for @default(now()), so what pg_attrdef stores is byte-identical to what
--    `migrate diff` expects and the column does not register as drift.
ALTER TABLE "deliveries"
  ALTER COLUMN "next_attempt_at" SET DEFAULT CURRENT_TIMESTAMP;

-- 6. Rebuild the ready-set indexes without NULLS FIRST and with the id
--    tiebreaker. Definitions must stay in step with claimFIFOSQL,
--    claimTenantFairSQL and tenantSnapshotSQL in
--    services/data-plane/internal/queue/postgres.go, and their predicate with
--    claimStatuses there. 'processing' stays in the predicate ON PURPOSE - see
--    20260907000000 and deployments/ci/expected-schema-drift.txt.
DO $$
BEGIN
  IF EXISTS (SELECT 1
               FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname  = 'deliveries_ready_idx'
                AND indexdef LIKE '%NULLS FIRST%') THEN
    DROP INDEX "deliveries_ready_idx";
  END IF;
  IF EXISTS (SELECT 1
               FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname  = 'deliveries_ready_fifo_idx'
                AND indexdef LIKE '%NULLS FIRST%') THEN
    DROP INDEX "deliveries_ready_fifo_idx";
  END IF;
END $$;

-- CLAIM_STRATEGY=tenant_fair: the per-tenant LATERAL and the recursive
-- tenant-snapshot CTE (PostgreSQL's missing loose index scan, by hand).
CREATE INDEX IF NOT EXISTS "deliveries_ready_idx"
    ON "deliveries" ("organization_id", "project_id", "next_attempt_at", "created_at", "id")
    WHERE "status" IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');

-- CLAIM_STRATEGY=fifo, the shipping default: global order, no tenant predicate.
CREATE INDEX IF NOT EXISTS "deliveries_ready_fifo_idx"
    ON "deliveries" ("next_attempt_at", "created_at", "id")
    WHERE "status" IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');
