# Backup and restore

What has to survive, what does not, and how to prove the difference. The lens is
ARCHITECTURE.md's: **"if this component vanishes for an hour, do I lose data or
only time?"** Everything below follows from answering that per store.

## 1. What holds what

| Store | Holds | Losing it costs | Back it up? |
| --- | --- | --- | --- |
| **PostgreSQL** | Every durable thing: tenants, projects, endpoints, encrypted secrets, subscriptions, policies, the event ledger, `event_outbox`, `deliveries`, `delivery_attempts`, idempotency keys, audit log | **Data.** This is the system of record | **Yes. This is the backup.** |
| **Object storage** (S3/MinIO) | Payload bodies above `PAYLOAD_INLINE_MAX_BYTES` | **Data**, for offloaded events only | **Yes** — see §4, this is the trap |
| **`ENCRYPTION_KEY`** | Nothing. It *unlocks* `endpoints.secret_encrypted` | **Data**, silently: a restored database without the key has unreadable signing secrets | **Yes, and separately** |
| **Redis** | Rate-limiter token buckets | **Time**, and only accuracy: limits degrade to per-replica until it returns | **No** |
| **Containers / pods** | Nothing | Time | No |

Redis is deliberately not the queue. ARCHITECTURE.md's warning about Convoy —
"lose Redis and you lose in-flight deliveries" — is exactly what this design
avoids: the queue is PostgreSQL (ADR-0003), so a Redis outage costs limiter
accuracy and nothing else. There is a test that fails if `worker`, `queue`,
`ingest` or `router` ever starts importing a Redis client, precisely so that
stays true.

## 2. Backing up PostgreSQL

Nothing here is special to this platform — it is one database with no extensions
beyond what Prisma creates. Use whatever your provider gives you (RDS automated
backups plus PITR, Cloud SQL backups, `pgBackRest`). If you are rolling your own:

```bash
pg_dump --format=custom --no-owner --no-acl \
        --file "hookubit-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
```

**Point-in-time recovery matters more than snapshot frequency here.** The
delivery ledger is the product's answer to "what happened to this event?", and a
nightly snapshot silently discards up to a day of that answer. If you can only
have one, have PITR.

**Do not back up from a replica that lags behind the data plane.** The workers
write attempt rows continuously; a lagging replica produces a backup whose
ledger disagrees with what customers were actually sent.

## 3. The encryption key is not in the database, and that is the point

`endpoints.secret_encrypted` holds an AES-256-GCM envelope
(`v1.<kid>.<iv>.<tag>.<ct>`) whose AAD binds the row's table, id and owner. The
key lives only in `ENCRYPTION_KEY`, with `ENCRYPTION_KEY_ID` naming it and
`ENCRYPTION_KEYS_RETIRED` carrying superseded keys so rotation does not
invalidate existing secrets.

So a database backup **on its own cannot sign a single webhook.** Restore it
without the matching key and every endpoint secret is ciphertext you cannot open;
the platform starts, accepts events, and fails every delivery.

- Back the key up where the database backup is not — a secrets manager, not the
  same bucket. A backup that carries both is a single artefact that decrypts
  every customer's signing secret.
- When you rotate, keep the old key in `ENCRYPTION_KEYS_RETIRED` for at least as
  long as your oldest restorable backup. Dropping it early makes old backups
  unrestorable in a way nothing warns you about until you try.
- Record which `ENCRYPTION_KEY_ID` was current at each backup. The envelope
  names its `kid`, so a restore can tell you what it needs — but only after you
  have it.

## 4. Object storage, and the dangling-payload trap

Events larger than `PAYLOAD_INLINE_MAX_BYTES` are written to object storage and
the row keeps `payload_location` instead of `payload_raw`. `payload_hash` is a
SHA-256 of the exact bytes either way.

That means **PostgreSQL and the bucket must be restored to consistent points.**
Restore the database to an earlier point than the bucket and you have rows
pointing at objects that were never written; restore it later and offloaded
payloads are gone while the rows still claim them. Either way delivery fails for
those events with the payload unavailable, and — deliberately — such a delivery
defers without spending retry budget rather than burning its attempts against a
storage problem.

Use versioning and a lifecycle policy on the bucket, and align its retention with
the database's. If you take periodic snapshots rather than continuous backup,
snapshot the bucket *after* the database, never before: a dangling row is
recoverable by replay, a missing object is not.

## 5. Restoring

```bash
# 1. Restore the database.
createdb hookubit_restored
pg_restore --no-owner --no-acl --dbname hookubit_restored hookubit-<stamp>.dump

# 2. Bring the schema to the code's expectation. Safe on a current backup and
#    necessary on an older one; the data plane never runs migrations (ADR-0002).
DATABASE_URL=postgresql://.../hookubit_restored \
  pnpm --filter @hookubit/control-api prisma:deploy

# 3. Point the services at it, with the ENCRYPTION_KEY that matches the backup.
```

Start the **control plane first** and confirm you can read an endpoint's secret
metadata, which proves the key matches, before starting ingest. Starting ingest
first means accepting events you may not be able to sign.

There is no separate queue to drain or rebuild. Restarting the data plane against
a restored database resumes delivery from the ledger, because the ledger is the
queue.

**Expect duplicate deliveries after a restore to an earlier point.** Deliveries
that had already succeeded before the backup point are re-attempted, and
consumers see them again. This is the same at-least-once contract that retries
already impose — ARCHITECTURE.md requires consumers to be idempotent — but a
restore concentrates it, so tell affected customers rather than letting them
discover it.

## 6. Verifying recovery, and what was actually observed

ARCHITECTURE.md 63 requires that "the system can be destroyed and recreated
against the same external PostgreSQL and recover its state". That was exercised
directly on 2026-09-09 rather than reasoned about:

1. Three events published to a project with 25 subscribed endpoints, with **no
   receiver listening**, so all 75 deliveries failed and entered retry.
2. The data plane killed with **`SIGKILL`** — no graceful drain, the harshest
   case, mid-retry.
3. With no data plane alive, PostgreSQL still held all 75 deliveries and **zero
   stranded leases**: `locked_by` was null on every row.
4. A fresh process started against the same database, and a receiver brought up.

Result: **all 75 reached `succeeded`, across 225 attempts (150 failures, then 75
successes), with per-delivery attempt counts of 2 to 4 — retries resumed across
the process death.** 75 deliveries, 75 distinct `(event_id, endpoint_id)` pairs:
nothing lost, nothing duplicated. The receiver verified an HMAC signature on all
75.

Two things that verification depends on, worth knowing before you trust it
elsewhere:

- The dead process's leases were reclaimable because `'processing'` is inside the
  claim predicate. Removing it — which looks like a tidy-up — reintroduces exactly
  the data loss this test proves is absent.
- Nothing was published before `COMMIT`. The event and its outbox row are written
  in one transaction, so a crash between them is not a state the database can
  hold.

Re-run this after any change to the claim predicate, the lease handling or the
outbox, and treat a failure as a release blocker rather than a flaky test.

## 7. What is not covered here

- **Cross-region replication and failover.** ARCHITECTURE.md 61 lists
  multi-region as explicitly out of scope for now.
- **Backup encryption and retention policy.** Those are your organisation's, not
  the platform's.
- **Restoring a single tenant** from a full backup. There is no supported path;
  restore to a scratch database and copy what you need, respecting the fact that
  endpoint secrets are bound by AAD to their row id and owner, so they cannot be
  moved between tenants.
