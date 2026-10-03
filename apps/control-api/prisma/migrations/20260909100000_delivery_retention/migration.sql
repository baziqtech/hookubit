-- ---------------------------------------------------------------------------
-- Delivery ledger retention (docs/FAILURE_RECOVERY.md G14, second half).
--
-- Nothing has ever pruned `deliveries` or `delivery_attempts`. Every other
-- table in the system is bounded by something - the outbox drains, the queue's
-- ready set is bounded by max_retry_duration, idempotency_keys expire - and
-- these two grow for the life of the installation. This migration adds the one
-- column and the two indexes the sweep in services/data-plane/internal/retention
-- needs; the sweep itself is on the scheduler role.
--
-- TWO HORIZONS, WHICH IS WHY THERE IS A COLUMN AND NOT JUST AN INDEX.
--
-- The bytes and the answers are not in the same place. `delivery_attempts`
-- carries two header maps and a truncated response body per attempt - that is
-- the storage. A `deliveries` row carries the summary an operator actually asks
-- for at 2am: which endpoint, which event, what status, how many attempts, the
-- last error. So the detail is reclaimed at a short horizon (30 days by
-- default) and the summary survives to a long one (90 days). Most of the bytes
-- go early; most of the answers stay.
--
-- That split needs a marker, because deleting rows from `delivery_attempts`
-- changes nothing the candidate query can see. Without one, every sweep would
-- re-select the same deliveries forever, delete nothing, and get slower every
-- day. `attempts_pruned_at` takes a pruned delivery out of the partial index
-- below, so the working set drains to empty and the sweep is self-terminating -
-- which is also what makes it resumable with no cursor to store.
--
-- It earns its place a second time in the operator UI. A pruned delivery
-- without the marker reads `attempt_count: 5, attempts: []`, which is
-- indistinguishable from "the platform never tried" - the single worst thing
-- this ledger can say. With it the row can say when the detail was pruned.
--
-- SAFE ON A POPULATED TABLE. Adding a NULLABLE column with no default is a
-- catalogue-only change on PostgreSQL 11+: no table rewrite, an ACCESS
-- EXCLUSIVE lock held for the duration of a catalogue update. It is still a
-- lock on the hottest table in the system, so it will queue behind a
-- long-running transaction - see the note on lock_timeout below.
--
-- THE TWO INDEXES, and why there are two.
--
-- Both candidate scans are `<terminal statuses> AND created_at < cutoff`, over
-- a table whose overwhelming majority of rows are terminal. Every existing
-- index refuses them:
--
--   deliveries_status_next_attempt_at_idx      leads with status, but the
--       second column is next_attempt_at, which for a terminal row carries no
--       meaning at all (see internal/worker/store.go, advanceSQL) - so it
--       cannot answer "oldest terminal rows first".
--   deliveries_project_id_created_at_idx       leads with project_id. Retention
--       is platform-wide and constrains no project, so this would be one index
--       scan per project and a merge.
--   deliveries_ready_idx / _ready_fifo_idx     partial over the READY set.
--       Terminal rows are not in them at all - which is the point of those two.
--
-- They are PARTIAL, so both are drift by construction (Prisma has no
-- partial-index syntax) and both are listed in
-- deployments/ci/expected-schema-drift.txt.
--
-- Why not one index for both sweeps. The attempt sweep's predicate is the
-- delivery sweep's predicate plus `attempts_pruned_at IS NULL`. Served by the
-- broader index it would have to scan, oldest first, through every row it has
-- already pruned - a prefix that GROWS with the retained history, so the cheap
-- sweep would get monotonically more expensive while doing exactly as much
-- work. The narrow index has the opposite shape: a pruned row LEAVES it, so it
-- stays roughly the size of one horizon's arrears.
--
-- WRITE COST, which is smaller than it looks. A delivery is INSERTed as
-- 'pending', so it enters neither index on the fan-out path - the hottest write
-- in the product is untouched. Both entries are made by the single UPDATE that
-- takes the delivery terminal, which happens once per delivery. That is one
-- extra btree descent each, once, on a statement that is already writing the
-- row.
--
--   deliveries_retention_idx        grows with the retained ledger.
--   deliveries_attempt_pruning_idx  bounded by the arrears between the two
--                                   horizons; empty in a steady state where the
--                                   sweep keeps up.
--
-- CREATE INDEX IF NOT EXISTS, not CONCURRENTLY, because Prisma wraps a
-- migration file in a transaction and CREATE INDEX CONCURRENTLY cannot run
-- inside one. Each takes a SHARE lock on `deliveries` for the build, which
-- BLOCKS WRITES - the fan-out router and every worker. On a large populated
-- table, build them by hand first:
--
--   SET lock_timeout = '5s';
--   ALTER TABLE "deliveries" ADD COLUMN "attempts_pruned_at" TIMESTAMP(3);
--   CREATE INDEX CONCURRENTLY "deliveries_retention_idx"
--       ON "deliveries" ("created_at")
--       WHERE "status" IN ('succeeded', 'failed', 'exhausted', 'cancelled');
--   CREATE INDEX CONCURRENTLY "deliveries_attempt_pruning_idx"
--       ON "deliveries" ("created_at")
--       WHERE "status" IN ('succeeded', 'failed', 'exhausted', 'cancelled')
--         AND "attempts_pruned_at" IS NULL;
--
-- and this migration then finds all three and does nothing. The names and the
-- definitions above are exact; they must match or IF NOT EXISTS will not match
-- them.
--
-- THE STATUS LIST IS DUPLICATED HERE ON PURPOSE, and it must agree with
-- worker.State.Terminal() (internal/worker/state.go) and with
-- retention.TerminalStatuses. The two directions of disagreement are not
-- symmetric: a terminal status missing from this predicate means those rows are
-- never pruned, which is a leak; a NON-terminal status present in it means a
-- delivery is deleted while a worker is still retrying it, which is data loss
-- after a 202. TestTerminalStatusesMatchTheWorker pins the Go side.
-- ---------------------------------------------------------------------------

ALTER TABLE "deliveries"
    ADD COLUMN IF NOT EXISTS "attempts_pruned_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "deliveries_retention_idx"
    ON "deliveries" ("created_at")
    WHERE "status" IN ('succeeded', 'failed', 'exhausted', 'cancelled');

CREATE INDEX IF NOT EXISTS "deliveries_attempt_pruning_idx"
    ON "deliveries" ("created_at")
    WHERE "status" IN ('succeeded', 'failed', 'exhausted', 'cancelled')
      AND "attempts_pruned_at" IS NULL;
