# Backup, restore and upgrades

What has to survive, how to prove it, and how to move between versions without
losing deliveries or sending them twice more than you have to.

The lens for every decision here: **if this component vanishes for an hour, do
I lose data or only time?**

## What holds what

| Store | Holds | Losing it costs | Back it up? |
|---|---|---|---|
| **PostgreSQL** | Everything durable: tenants, projects, endpoints, encrypted signing secrets, subscriptions, policies, the event ledger, the outbox, deliveries, attempts, idempotency keys, the audit log | **Data.** This is the system of record. | **Yes. This is the backup.** |
| **Object storage** | Payload bodies above the inline limit | **Data**, for offloaded events only | **Yes**, and consistently with the database (below) |
| **`ENCRYPTION_KEY`** | Nothing. It unlocks the stored signing secrets | **Data**, silently: a restored database without it has unreadable signing secrets | **Yes, and separately** |
| **Redis** | Rate-limiter token buckets | Time, and only accuracy | No |
| **Containers** | Nothing | Time | No |

Redis is deliberately not the queue. The queue is PostgreSQL, so a Redis outage
costs limiter accuracy and nothing else. A test fails if the delivery path ever
imports a Redis client.

## Backing up PostgreSQL

Nothing is special to this platform: one database, no extensions beyond what
the migrations create. Use what your provider gives you (automated backups
plus point-in-time recovery, `pgBackRest`), or:

```bash
pg_dump --format=custom --no-owner --no-acl \
        --file "hookubit-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
```

**Point-in-time recovery matters more than snapshot frequency.** The delivery
ledger is the product's answer to "what happened to this event", and a nightly
snapshot discards up to a day of that answer. If you can only have one, have
PITR.

**Do not back up from a replica that lags behind the data plane.** Workers
write attempt rows continuously; a lagging replica produces a ledger that
disagrees with what customers were actually sent.

## The encryption key is not in the database, and that is the point

Endpoint signing secrets are stored as AES-256-GCM ciphertext bound to their
row. The key lives only in `ENCRYPTION_KEY`, with `ENCRYPTION_KEY_ID` naming it
and `ENCRYPTION_KEYS_RETIRED` carrying superseded keys.

So a database backup **on its own cannot sign a single webhook**. Restore it
without the matching key and the platform starts, accepts events, and fails
every delivery at signing time.

- Back the key up where the database backup is not: a secrets manager, not the
  same bucket. A backup that carries both decrypts every customer's signing
  secret.
- When you rotate, keep the old key in `ENCRYPTION_KEYS_RETIRED` for at least
  as long as your oldest restorable backup. Dropping it early makes old backups
  unrestorable in a way nothing warns you about until you try.
- Record which `ENCRYPTION_KEY_ID` was current at each backup. The ciphertext
  names its key id, so a restore can tell you what it needs, but only after you
  have it.

## Object storage, and the dangling-payload trap

Events above `PAYLOAD_INLINE_MAX_BYTES` keep a reference to an object instead
of the body. **PostgreSQL and the bucket must be restored to consistent
points.**

| Database restored to | Result |
|---|---|
| An earlier point than the bucket | Rows point at objects that were never written (from the database's view). |
| A later point than the bucket | Offloaded payloads are gone while rows still claim them. |

Either way, delivery of those events fails with the payload unavailable, and,
deliberately, such a delivery defers without spending retry budget rather than
burning its attempts against a storage problem.

Use versioning and a lifecycle policy on the bucket, and align its retention
with the database's. If you snapshot rather than continuously back up, snapshot
the bucket **after** the database, never before: a dangling row is recoverable
by replay, a missing object is not.

## Restoring

```bash
# 1. Restore the database.
createdb hookubit_restored
pg_restore --no-owner --no-acl --dbname hookubit_restored hookubit-<stamp>.dump

# 2. Bring the schema to the code's expectation. Safe on a current backup,
#    necessary on an older one. Run the migration job against the restored
#    database with DIRECT_DATABASE_URL pointing at it.

# 3. Point the services at it, with the ENCRYPTION_KEY that matches the backup.
```

Order matters:

1. **Control plane first.** Confirm you can read an endpoint's secret metadata
   in the dashboard or API; that proves the key matches.
2. **Then ingest.** Starting ingest first means accepting events you may not be
   able to sign.
3. **Then router, scheduler, workers.** There is no separate queue to drain or
   rebuild: restarting the data plane against a restored database resumes
   delivery from the ledger, because the ledger is the queue.

**Expect duplicate deliveries after a restore to an earlier point.** Deliveries
that had already succeeded before the backup point are re-attempted and
consumers see them again. This is the same at-least-once contract retries
already impose (see the [guide on retries and delivery](/guide/05-retries-and-delivery)),
but a restore concentrates it. Tell affected customers rather than letting them
discover it.

**This was exercised, not reasoned about.** Three events to 25 endpoints with
no receiver listening, so all 75 deliveries were mid-retry; the data plane
killed with SIGKILL; zero stranded leases in the database; a fresh process
started against the same database and a receiver brought up. All 75 reached
`succeeded` across 225 attempts, 75 distinct (event, endpoint) pairs, nothing
lost, nothing duplicated, every signature verified.

Not covered: cross-region failover (out of scope for now), backup encryption
and retention policy (yours), and restoring a single tenant from a full backup
(no supported path; restore to a scratch database and copy what you need,
knowing that signing secrets are bound to their row and owner and cannot be
moved between tenants).

## Upgrades

An upgrade is three things in a fixed order: read the release note, run the
migration job, roll the images. The migration job is never a side effect of a
deploy: not a Helm hook, not in the kustomization, not on application start.

### The default order

1. Read the release note (below).
2. Run the migration job at the new version
   (`webhook-control-api:<new>-migrate`) against `DIRECT_DATABASE_URL`, and
   wait for it to complete.
3. Roll the control API, then the data plane, then the dashboard, at the new
   version.

Migrations are written to be applied ahead of the code that needs them, on a
populated table, without a full-table lock. The old data plane keeps working
against the new schema for the length of the rollout.

### The exception: `next_attempt_at` becomes NOT NULL

One migration in the history inverts the order, and its header says so in
capitals. The migration that makes `deliveries.next_attempt_at` NOT NULL
(`20260911000000_next_attempt_at_not_null`) requires the **data plane to be
upgraded first**:

> The data-plane binary carrying the fix MUST be live everywhere before the
> constraint is applied. Apply the constraint first and every terminal
> transition still in flight from an OLDER worker, including successful
> deliveries, fails its UPDATE, the transaction rolls back, the attempt row
> goes with it, and the delivery sits in `processing` until its lease expires
> and it is retried against an endpoint that has ALREADY received it.

The order for that release, verbatim from the header:

1. Deploy the data plane (workers, scheduler, router) at the new revision.
2. Confirm no older worker is still running.
3. Run the backfill (the migration's first statement). It is idempotent; run it
   as often as you like.
4. Apply the rest (run the migration job).

**Rolling back past that revision has the same failure mode.** Drop the
constraint first: `ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;`

**On a large populated table, run the steps by hand first.** The migration
uses the NOT VALID / VALIDATE / SET NOT NULL idiom that avoids a full-table
scan under an exclusive lock, but only when the steps run in separate
transactions, and the migration tool wraps the whole file in one. The header
carries the exact hand-run recipe, one transaction each with
`SET lock_timeout = '5s'`, including `CREATE INDEX CONCURRENTLY` for the two
ready-set indexes it rebuilds. Every step in the migration then finds its work
done and does nothing.

If you skip the migration history entirely and run the job once at a much
newer version, it applies every pending migration in order, this one included,
with whatever data plane is running at the time. Do not do that across this
migration.

### Configuration rules that bite on upgrade

| Rule | Symptom if missed |
|---|---|
| `DATABASE_STATEMENT_TIMEOUT_MS` >= `WORKER_DB_TIMEOUT_MS` (and `INGEST_DB_TIMEOUT_MS`) | Every Go role refuses to start: `DATABASE_STATEMENT_TIMEOUT_MS must not be below WORKER_DB_TIMEOUT_MS`. `WORKER_DB_TIMEOUT_MS` is a newer key that used to borrow the ingest one; if you had tuned `INGEST_DB_TIMEOUT_MS` above the statement timeout, the worker deadline now trips the same check separately. |
| `REDIS_URL` or `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true` in production | Workers refuse to start after upgrading to a version that adds the refusal: `REDIS_URL is not set, so endpoint delivery rate limits would be enforced PER WORKER REPLICA ...`. A Redis-less production install that used to boot stops booting. Decide which you mean before rolling. |
| `SMTP_URL` and `MAIL_FROM` in staging and production | The control API refuses to boot. |
| `RETENTION_*` keys well-formed | The scheduler refuses to start rather than guess a horizon. |
| PostgreSQL 15+ | The migration job refuses on an older server. |
| `ENCRYPTION_KEY` reachable by the worker | Workers exit with `build decryption keyring: ENCRYPTION_KEY is required`. See the Helm and manifests pages. |

Config refusals report every problem at once, so read the whole log line.

### How to read a release note

Each release note answers, in order:

1. **Ordering.** "Migrate first" (the default) or "data plane first" (the
   exception above). If it says nothing, migrate first.
2. **Schema.** Which migrations are added and whether any touches a large
   table in a way that wants the hand-run recipe.
3. **Configuration.** New keys, new refusals, changed defaults. Anything that
   used to boot and now will not is listed under this heading.
4. **Dashboard.** Whether the dashboard image needs rebuilding with your build
   arguments. It is a static bundle; a new version means a new image built with
   your ingest URL.
5. **Observability.** New or renamed metrics, so alert rules and the dashboard
   are updated with the code.

If a note is missing any of these, ask before upgrading.

### Rollback

Images roll back freely except across the `next_attempt_at` migration (drop
the constraint first). Migrations do not roll back on their own; the platform
does not ship down-migrations. Restore from backup if a migration must be
undone, and read the restore section above about duplicates.

---

**Where this comes from.** `docs/BACKUP_RESTORE.md` (condensed), `apps/control-api/prisma/migrations/20260911000000_next_attempt_at_not_null/migration.sql` (header), `services/data-plane/internal/config/{config,isolation}.go`, `services/data-plane/internal/retention/config.go`, `deployments/helm/hookubit/templates/migration-job.yaml`, `deployments/kubernetes/10-migration-job.yaml`.
