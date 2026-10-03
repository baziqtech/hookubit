-- ---------------------------------------------------------------------------
-- users.onboarding_completed_at
--
-- The dashboard's product tour kept "has this person seen it?" in
-- localStorage. That flag is per-browser, so the tour replayed on a second
-- device, in a private window and after a site-data clear, including for
-- someone who had deliberately skipped it - and support could not see whether
-- anyone had ever been onboarded. This column is the server-side answer.
--
-- SAFE ON A NON-EMPTY DATABASE: one NULLABLE column with no default, so
-- PostgreSQL only writes the catalog row and no table rewrite happens. No
-- backfill: NULL means "has not seen the tour", which is the safe direction -
-- the tour is skippable and re-openable, so showing it once more costs a
-- keystroke, while wrongly suppressing it leaves a new user with no
-- orientation. Backfilling now() for every existing row would do exactly that.
--
-- Nullable also makes this reversible by DROP COLUMN alone, with nothing to
-- undo elsewhere.
--
-- PostgreSQL version: nothing here needs 15+. The 15+ floor asserted by
-- 20260906010000_review_fixes (NULLS NOT DISTINCT) is UNCHANGED and re-asserted
-- below, so this file is self-describing if it is ever applied on its own.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'webhook-platform requires PostgreSQL 15 or newer (NULLS NOT DISTINCT); this server reports %',
      current_setting('server_version');
  END IF;
END
$$;

-- IF NOT EXISTS so a re-run, or a database where the column was added by hand
-- ahead of the deploy, is a no-op rather than a failed migration row.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);

COMMENT ON COLUMN "users"."onboarding_completed_at" IS
  'When the user finished or skipped the product tour. NULL = never seen it.';
