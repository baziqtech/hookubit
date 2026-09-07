-- ---------------------------------------------------------------------------
-- Consolidated schema requests from the module HANDOFFs.
--
--   1. api_keys: record WHO minted a key (apps/control-api/HANDOFF.md, FIX 2)
--   2. retry_policies: CHECK constraints + one-default-per-project
--   3. rate_limit_policies: CHECK constraints
--   4. deliveries: the ready-set claim indexes (services/data-plane, item 6)
--   5. event_outbox: the router's claim index (services/data-plane, item 1)
--
-- SEVERAL STATEMENTS HERE CANNOT BE EXPRESSED IN schema.prisma: CHECK
-- constraints, partial indexes, and index NULLS ordering. They are hand-written
-- and must be preserved verbatim if this migration is ever regenerated.
-- `prisma migrate diff` reports the partial indexes as drift BY CONSTRUCTION;
-- deployments/ci/expected-schema-drift.txt is the allowlist CI compares against.
--
-- SAFE ON A NON-EMPTY DATABASE, deliberately. No database exists yet, but this
-- file is written as if one did, because the second time it is read that will
-- be true:
--   * every new column is NULLABLE with no default, so no table is rewritten;
--   * every CHECK is added NOT VALID and then VALIDATEd in a separate
--     statement, so the ACCESS EXCLUSIVE lock is held only for the catalog
--     write and the row scan runs under SHARE UPDATE EXCLUSIVE;
--   * every CHECK and every unique index is preceded by an idempotent REPAIR
--     pass that brings existing rows into range FIRST. Each repair is a no-op
--     on an empty table and each says out loud what it changes. Without them a
--     single legacy row aborts the whole deploy.
--   * indexes are CREATE INDEX IF NOT EXISTS, NOT CONCURRENTLY. Prisma wraps a
--     migration file in a transaction and CREATE INDEX CONCURRENTLY cannot run
--     inside one. On a LARGE POPULATED deliveries table, build them by hand
--     with CONCURRENTLY first (names and definitions below are exact) and this
--     migration then skips them.
--
-- PostgreSQL version: nothing added here needs 15+. The 15+ floor asserted by
-- 20260906010000_review_fixes (NULLS NOT DISTINCT) is unchanged and re-asserted
-- below, so this file is self-describing if it is ever applied on its own.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'webhook-platform requires PostgreSQL 15 or newer; this server reports %',
      current_setting('server_version');
  END IF;
END
$$;


-- ===========================================================================
-- 1. api_keys - a key's scopes are a snapshot of authority with no issuer
--
-- ApiKeysService.resolveScopes refuses any scope the caller does not hold, so a
-- key cannot be minted above its issuer's authority. Nothing re-checks it
-- afterwards. A developer mints a key carrying endpoints.write and events.replay,
-- is demoted to viewer or removed from the organization, and the key keeps full
-- developer authority indefinitely - with no record anywhere of whose authority
-- it was. These two columns are what makes the scopes re-derivable:
--   effective = key.scopes INTERSECT permissionsForRole(role of created_by_membership_id)
-- and a NULL created_by_membership_id (issuer gone) must intersect to the EMPTY
-- set, never to the stored scopes.
--
-- Both columns NULLABLE, both foreign keys ON DELETE SET NULL:
--   * RESTRICT would make a key's issuer permanently undeletable.
--   * CASCADE would delete the credential - and orphan its delivery history -
--     the moment a person leaves.
--   * Existing rows have no issuer and must not block this migration.
-- Both are needed: created_by_user_id survives the membership being deleted and
-- is what an operator reads in the UI; created_by_membership_id is what the role
-- lookup joins to, and its going NULL is itself the signal that the issuer left.
-- ===========================================================================

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "created_by_user_id"       TEXT,
  ADD COLUMN IF NOT EXISTS "created_by_membership_id" TEXT;

-- BACKFILL, before the foreign keys exist, from the audit trail: the
-- `api_key.created` audit row already carries the issuer's user id in its actor
-- column and the membership id in its metadata. DISTINCT ON keeps the earliest
-- such row per key (a key is created once; a duplicate action row would be a
-- replayed audit write, and the first is the mint).
UPDATE "api_keys" k
   SET "created_by_user_id"       = src."user_id",
       "created_by_membership_id" = src."membership_id"
  FROM (
        SELECT DISTINCT ON (a."resource_id")
               a."resource_id" AS "api_key_id",
               a."user_id"     AS "user_id",
               a."metadata"->>'created_by_membership_id' AS "membership_id"
          FROM "audit_logs" a
         WHERE a."action" = 'api_key.created'
           AND a."resource_id" IS NOT NULL
         ORDER BY a."resource_id", a."created_at" ASC, a."id" ASC
       ) src
 WHERE k."id" = src."api_key_id"
   AND k."created_by_user_id" IS NULL
   AND k."created_by_membership_id" IS NULL;

-- The audit trail is not a foreign key and outlives what it names. Anything the
-- backfill recovered that no longer exists is dropped back to NULL HERE, not by
-- the FK - a dangling id would abort the ADD CONSTRAINT below and take the whole
-- deploy with it.
UPDATE "api_keys" k
   SET "created_by_user_id" = NULL
 WHERE k."created_by_user_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = k."created_by_user_id");

UPDATE "api_keys" k
   SET "created_by_membership_id" = NULL
 WHERE k."created_by_membership_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "organization_members" m WHERE m."id" = k."created_by_membership_id");

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "api_keys_created_by_membership_id_fkey"
    FOREIGN KEY ("created_by_membership_id") REFERENCES "organization_members"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Not for reads. These exist for the WRITE side: removing a membership must find
-- every key that membership minted without scanning api_keys, and PostgreSQL's
-- own ON DELETE SET NULL enforcement performs exactly this lookup on every user
-- and member delete. Without them, deleting a user seq-scans api_keys.
CREATE INDEX IF NOT EXISTS "api_keys_created_by_user_id_idx"
    ON "api_keys" ("created_by_user_id");
CREATE INDEX IF NOT EXISTS "api_keys_created_by_membership_id_idx"
    ON "api_keys" ("created_by_membership_id");


-- ===========================================================================
-- 2. retry_policies - values retry.Delay / retry.Exhausted cannot consume
--
-- THE SCAR, and the reason this is a database constraint and not another
-- service-layer check: the clamp in retry.Delay used to be gated on
-- MaxDelay > 0, so a policy with max_delay_ms = 0 let the exponential term
-- overflow int64 nanoseconds. time.Duration(d) became math.MinInt64 - a large
-- NEGATIVE backoff. next_attempt_at landed permanently in the PAST, the row was
-- ready on every poll, and a dead endpoint was hammered every 250ms forever.
--
-- The control plane refuses all of these today. It is not the only writer
-- forever (the CLI, a backfill, the next service), and the data plane CLAMPS
-- rather than refuses, so a bad row does not fail loudly - it silently stops
-- behaving the way it reads. This is the refusal.
-- ===========================================================================

-- REPAIR FIRST. Each statement is a no-op on an empty table and touches only
-- rows that would abort the VALIDATE below. RAISE NOTICE, not silence: a repair
-- is a rewrite of somebody's configuration and the operator has to see it.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE "retry_policies" SET "strategy" = 'exponential'
   WHERE "strategy" NOT IN ('exponential', 'linear', 'constant');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: reset % row(s) with an unknown strategy to exponential', n; END IF;

  UPDATE "retry_policies" SET "max_attempts" = LEAST(GREATEST("max_attempts", 1), 50)
   WHERE "max_attempts" < 1 OR "max_attempts" > 50;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: clamped max_attempts on % row(s)', n; END IF;

  UPDATE "retry_policies" SET "initial_delay_ms" = LEAST(GREATEST("initial_delay_ms", 1), 86400000)
   WHERE "initial_delay_ms" < 1 OR "initial_delay_ms" > 86400000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: clamped initial_delay_ms on % row(s)', n; END IF;

  -- max_delay_ms = 0 is the overflow above. Clamp to 1ms..24h, then widen the
  -- ceiling to the floor where the pair is inverted, so the surviving policy
  -- still backs off by at least its own initial delay.
  UPDATE "retry_policies" SET "max_delay_ms" = LEAST(GREATEST("max_delay_ms", 1), 86400000)
   WHERE "max_delay_ms" < 1 OR "max_delay_ms" > 86400000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: clamped max_delay_ms on % row(s) - THIS IS THE max_delay_ms = 0 OVERFLOW', n; END IF;

  UPDATE "retry_policies" SET "max_delay_ms" = "initial_delay_ms"
   WHERE "initial_delay_ms" > "max_delay_ms";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: raised max_delay_ms to initial_delay_ms on % inverted row(s)', n; END IF;

  -- NOT (a AND b) rather than (NOT a OR NOT b) so NaN is caught: in PostgreSQL
  -- NaN sorts ABOVE every float, so NaN >= 1 is TRUE and NaN <= 100 is FALSE.
  UPDATE "retry_policies" SET "multiplier" = 2
   WHERE NOT ("multiplier" >= 1 AND "multiplier" <= 100);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: reset out-of-range/NaN multiplier to 2 on % row(s)', n; END IF;

  -- retry.Delay substitutes 2 for any multiplier <= 1 on the exponential branch,
  -- so a stored 1 there is a row that does not describe what happens. Writing
  -- the 2 makes the row honest rather than changing behaviour.
  UPDATE "retry_policies" SET "multiplier" = 2
   WHERE "strategy" = 'exponential' AND "multiplier" <= 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: wrote the substituted multiplier 2 onto % exponential row(s) that stored <= 1', n; END IF;

  UPDATE "retry_policies" SET "jitter_ratio" = 0.2
   WHERE NOT ("jitter_ratio" >= 0 AND "jitter_ratio" <= 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: reset out-of-range/NaN jitter_ratio to 0.2 on % row(s)', n; END IF;

  UPDATE "retry_policies" SET "max_retry_duration_ms" = LEAST(GREATEST("max_retry_duration_ms", 1000), 604800000)
   WHERE "max_retry_duration_ms" < 1000 OR "max_retry_duration_ms" > 604800000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: clamped max_retry_duration_ms on % row(s)', n; END IF;
END
$$;

ALTER TABLE "retry_policies"
  -- strategy is a plain TEXT column, not an enum, so the database accepts any
  -- string; retry.Delay falls through to its exponential branch for anything it
  -- does not recognise, which is a policy that does not do what its row says.
  ADD CONSTRAINT "retry_policies_strategy_check"
    CHECK ("strategy" IN ('exponential', 'linear', 'constant')) NOT VALID,
  -- 0 attempts is a policy that never delivers; 50 is well past any budget that
  -- max_retry_duration_ms permits and is there to catch a typo'd 1000000.
  ADD CONSTRAINT "retry_policies_max_attempts_check"
    CHECK ("max_attempts" BETWEEN 1 AND 50) NOT VALID,
  ADD CONSTRAINT "retry_policies_initial_delay_check"
    CHECK ("initial_delay_ms" BETWEEN 1 AND 86400000) NOT VALID,
  -- 1, not 0: this is the overflow in the section header.
  ADD CONSTRAINT "retry_policies_max_delay_check"
    CHECK ("max_delay_ms" BETWEEN 1 AND 86400000) NOT VALID,
  -- An inverted pair makes the clamp shrink the delay on every attempt, so the
  -- backoff runs BACKWARDS and the endpoint is polled harder the longer it fails.
  ADD CONSTRAINT "retry_policies_delay_order_check"
    CHECK ("initial_delay_ms" <= "max_delay_ms") NOT VALID,
  -- multiplier < 1 shrinks the delay each attempt; > 100 reaches the int64
  -- overflow in a handful of attempts. NaN fails this (NaN <= 100 is FALSE).
  ADD CONSTRAINT "retry_policies_multiplier_check"
    CHECK ("multiplier" >= 1 AND "multiplier" <= 100) NOT VALID,
  -- retry.Delay substitutes 2 for any multiplier <= 1 on the exponential branch,
  -- so a stored 1 there is a row that does not describe what happens.
  ADD CONSTRAINT "retry_policies_exponential_multiplier_check"
    CHECK ("strategy" <> 'exponential' OR "multiplier" > 1) NOT VALID,
  -- Jitter is a RATIO. > 1 makes the jittered delay negative for half the range,
  -- which is the same permanently-in-the-past next_attempt_at by another route.
  ADD CONSTRAINT "retry_policies_jitter_check"
    CHECK ("jitter_ratio" >= 0 AND "jitter_ratio" <= 1) NOT VALID,
  -- 7 days, NOT 30: the column is int4 and 30 days is 2_592_000_000, past
  -- 2_147_483_647. A 30-day budget cannot be stored here at all.
  ADD CONSTRAINT "retry_policies_max_retry_duration_check"
    CHECK ("max_retry_duration_ms" BETWEEN 1000 AND 604800000) NOT VALID;

-- Separate statements: VALIDATE takes only SHARE UPDATE EXCLUSIVE, so the scan
-- does not block reads or writes. The repair above guarantees these pass.
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_strategy_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_max_attempts_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_initial_delay_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_max_delay_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_delay_order_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_multiplier_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_exponential_multiplier_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_jitter_check";
ALTER TABLE "retry_policies" VALIDATE CONSTRAINT "retry_policies_max_retry_duration_check";

-- "At most one default per project", which RetryPoliciesService holds inside a
-- SERIALIZABLE transaction and the schema held not at all. A second default is
-- not a visible error: it is a project where which retry policy an endpoint gets
-- depends on row order.
--
-- PARTIAL (WHERE is_default), so the non-default rows - which are the vast
-- majority - are not in the index at all. Prisma has no partial-index syntax;
-- this is drift by construction, same as the review_fixes indexes.
--
-- It does NOT remove the need for the transaction: a unique index cannot express
-- "at LEAST one row", so the zero-default direction is still the service's job.
-- It does make setDefault's statement ORDER load-bearing (clear, then set),
-- which is already what it does.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE "retry_policies" p
     SET "is_default" = false
   WHERE p."is_default"
     AND EXISTS (
           SELECT 1 FROM "retry_policies" q
            WHERE q."project_id" = p."project_id"
              AND q."is_default"
              AND (q."created_at", q."id") < (p."created_at", p."id")
         );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'retry_policies: demoted % duplicate default(s); the OLDEST default in each project was kept', n; END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "retry_policies_one_default_per_project"
    ON "retry_policies" ("project_id")
    WHERE "is_default";


-- ===========================================================================
-- 3. rate_limit_policies - values no limiter can consume
--
-- limit = 0 disables delivery or ingestion entirely for whatever the policy
-- covers, and reads in the UI as a configured ceiling rather than an outage.
-- window_seconds = 0 is a division by zero in the refill rate. burst < limit
-- means the configured limit can NEVER be reached, because the bucket cannot
-- hold one window's worth of tokens.
--
-- The control plane guarantees limit >= 1, window_seconds >= 1 and
-- burst >= limit, and the limiter documentation tells consumers they therefore
-- need no divide-by-zero guard. This is what makes that promise true for every
-- writer, not just the control plane.
-- ===========================================================================

DO $$
DECLARE n bigint;
BEGIN
  UPDATE "rate_limit_policies" SET "limit" = LEAST(GREATEST("limit", 1), 10000000)
   WHERE "limit" < 1 OR "limit" > 10000000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'rate_limit_policies: clamped limit on % row(s)', n; END IF;

  UPDATE "rate_limit_policies" SET "window_seconds" = LEAST(GREATEST("window_seconds", 1), 86400)
   WHERE "window_seconds" < 1 OR "window_seconds" > 86400;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'rate_limit_policies: clamped window_seconds on % row(s)', n; END IF;

  -- burst runs AFTER limit, and repairs to NULL rather than to a number: NULL
  -- already means "capacity equals limit", which is the only capacity that is
  -- certainly correct for a row whose stored burst was nonsense.
  UPDATE "rate_limit_policies" SET "burst" = NULL
   WHERE "burst" IS NOT NULL AND NOT ("burst" >= "limit" AND "burst" <= 10000000);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'rate_limit_policies: reset % unusable burst value(s) to NULL (capacity = limit)', n; END IF;
END
$$;

ALTER TABLE "rate_limit_policies"
  ADD CONSTRAINT "rate_limit_policies_limit_check"
    CHECK ("limit" BETWEEN 1 AND 10000000) NOT VALID,
  ADD CONSTRAINT "rate_limit_policies_window_check"
    CHECK ("window_seconds" BETWEEN 1 AND 86400) NOT VALID,
  -- NULL burst is legal and means "capacity equals limit".
  ADD CONSTRAINT "rate_limit_policies_burst_check"
    CHECK ("burst" IS NULL OR ("burst" >= "limit" AND "burst" <= 10000000)) NOT VALID;

ALTER TABLE "rate_limit_policies" VALIDATE CONSTRAINT "rate_limit_policies_limit_check";
ALTER TABLE "rate_limit_policies" VALIDATE CONSTRAINT "rate_limit_policies_window_check";
ALTER TABLE "rate_limit_policies" VALIDATE CONSTRAINT "rate_limit_policies_burst_check";


-- ===========================================================================
-- 4. deliveries - the ready set
--
-- internal/queue's claim is:
--
--     WHERE status IN ('pending','scheduled','queued','retrying','processing')
--       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
--       AND (locked_until IS NULL OR locked_until < now())
--     ORDER BY next_attempt_at NULLS FIRST, created_at
--     FOR UPDATE SKIP LOCKED
--
-- 'processing' MUST BE IN THE PREDICATE. ADR-0007 excluded it, arguing that a
-- leased row is 'processing' and therefore outside the ready set. That reasoning
-- was built on a claim query that could NOT reclaim an expired lease, which was
-- a bug and is fixed. A worker that dies mid-delivery leaves its rows in
-- 'processing' with a lapsed locked_until; if they are outside the partial
-- predicate the indexed claim path cannot find them, and those deliveries sit in
-- 'processing' forever - never retried, never exhausted, never surfaced as
-- failed. Excluding 'processing' makes an expired lease unrecoverable except by
-- sequential scan. The index grows by the number of CURRENTLY LEASED rows, which
-- is bounded by worker concurrency, not by backlog.
--
-- NULLS FIRST is not decoration. next_attempt_at is nullable and the claim
-- orders NULLS FIRST; a default (ASC NULLS LAST) index cannot satisfy that
-- ordering and the planner adds a sort over the whole ready set. When
-- next_attempt_at eventually becomes NOT NULL this becomes a no-op.
--
-- TWO indexes because the two claim strategies have different leading columns
-- and neither index serves the other's query:
-- ===========================================================================

-- CLAIM_STRATEGY=tenant_fair: the per-tenant LATERAL and the recursive
-- tenant-snapshot CTE, which is PostgreSQL's missing loose index scan written by
-- hand. Without the (organization_id, project_id) prefix the CTE has no index to
-- descend and degrades into the full scan of the ready set on every poll that
-- ADR-0007 says must not happen.
CREATE INDEX IF NOT EXISTS "deliveries_ready_idx"
    ON "deliveries" ("organization_id", "project_id", "next_attempt_at" NULLS FIRST, "created_at")
    WHERE "status" IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');

-- CLAIM_STRATEGY=fifo, which is what SHIPS AS THE DEFAULT. It orders globally by
-- (next_attempt_at, created_at) with no tenant predicate, so the index above -
-- whose leading columns are the tenant pair - cannot serve it at all. This one
-- returns the claim's rows already ordered.
CREATE INDEX IF NOT EXISTS "deliveries_ready_fifo_idx"
    ON "deliveries" ("next_attempt_at" NULLS FIRST, "created_at")
    WHERE "status" IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');

-- deliveries.next_attempt_at is NOT made NOT NULL here, though ADR-0007 and
-- services/data-plane/HANDOFF.md item 7 both ask for it. internal/worker's
-- advanceSQL writes `next_attempt_at = CASE WHEN $5 THEN now() + $6 ELSE NULL
-- END` on EVERY terminal transition, so NOT NULL would fail every succeed,
-- exhaust and cancel write in the data plane, and store_integration_test.go
-- asserts that terminal rows have a NULL next_attempt_at. The Go change has to
-- land first. See apps/control-api/HANDOFF.md.


-- ===========================================================================
-- 5. event_outbox - the router's claim
--
-- internal/router claims with
--
--     WHERE status IN ('pending','processing') AND available_at <= now()
--       AND (locked_until IS NULL OR locked_until < now())
--     ORDER BY available_at, created_at
--     FOR UPDATE SKIP LOCKED
--
-- and separately gauges lag with MIN(available_at) over the same predicate.
-- event_outbox_status_available_at_idx covers the predicate but leads with
-- `status`, so the ordering tiebreak on created_at is not covered and the lag
-- query scans every entry for both statuses. 'processing' is in the predicate
-- for the same reason as deliveries above: a leased row IS processing, and a
-- crashed router's rows must be reclaimable CHEAPLY, not merely possible to
-- reclaim. available_at is NOT NULL (it defaults to now()), so no NULLS clause
-- is needed here.
--
-- An outbox row that is never claimed is an event that returned 202 and will
-- never be delivered. That is the failure this index is protecting the latency
-- of.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS "event_outbox_ready_idx"
    ON "event_outbox" ("available_at", "created_at")
    WHERE "status" IN ('pending', 'processing');
