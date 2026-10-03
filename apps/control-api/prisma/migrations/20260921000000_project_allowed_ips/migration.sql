-- Addresses permitted to PUBLISH events to a project.
--
-- Empty means every address may, which is the default and the behaviour every
-- existing project keeps: the column is NOT NULL with an empty-array default,
-- so this migration cannot change what any project accepts today.
--
-- PUBLISHING ONLY. Nothing reads this for the dashboard or for signing in, so
-- an operator cannot lock themselves out with it — which is the failure mode
-- that makes IP allowlists dangerous enough to be worth saying twice.
ALTER TABLE "projects"
  ADD COLUMN "allowed_ips" TEXT[] NOT NULL DEFAULT '{}';

-- The data plane reads this on the ingest path, joined from api_keys. It is a
-- small array on a row that query already fetches, so no index is added: an
-- index on a text[] would serve a containment query nobody issues.
