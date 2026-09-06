# Scale and partitioning — what to do, in what order, at what measurement

Companion to ADR-0003 (PostgreSQL is the queue), ADR-0007 (tenant fairness) and
ARCHITECTURE.md 35, 51 and 53.

This document exists to stop two failure modes that are equally expensive:
partitioning a 400k-row table because it felt grown-up, and discovering at
80M rows that the retention job cannot finish inside a night.

**Read the numbers as estimates unless marked *measured*.** Nothing here has
been observed on this platform yet — Phase 1 is complete and no migration has
been applied. Every figure below is derived from the shape of the schema and
from ordinary PostgreSQL behaviour on a mid-sized instance (assume 4 vCPU,
16 GB RAM, gp3 SSD, `shared_buffers = 4GB`). The first job of the Phase 3 load
test is to replace them. When a step is taken, append the measurement that
triggered it to the log at the foot of this file.

## The rule

Take the next step only when a named metric crosses a named threshold, and take
them in this order. Skipping ahead is how a team ends up running Kafka to fix a
missing index.

| # | Step | Trigger | Cost if done too early |
|---|---|---|---|
| 0 | Partial index on the ready set | first migration | none — do it now |
| 1 | Tenant-fair claim (ADR-0007) | >1 active org, or any burst >10k | small; degrades to FIFO at K=1 |
| 2 | Autovacuum tuning on `deliveries` | index bloat >2× | none — do it with step 0 |
| 3 | PgBouncer | connections >60% of `max_connections` | one more hop to operate |
| 4 | Read replica for the operator surface | operator p95 >1s, or reads >25% of DB time | replication lag in the UI |
| 5 | Partition `delivery_attempts`, then `deliveries`, then `events` | >150M rows or retention job >1h | dozens of partitions, pruning bugs, worse plans |
| 6 | External queue (SQS/NATS/Kafka) | claim p99 >250ms with 3–5 done | a second source of truth to reconcile |

## The instruments

Existing, in `services/data-plane/internal/metrics/metrics.go`:

`events_ingested_total`, `events_ingestion_failed_total`,
`deliveries_created_total`, `deliveries_completed_total{outcome}`,
`deliveries_retried_total`, `delivery_latency_seconds`,
`delivery_attempt_latency_seconds{outcome}`,
`egress_http_responses_total{class}`, `queue_depth{state}`,
`worker_active_count`, `rate_limit_hits_total{scope}`,
`circuit_breaker_open_total`, `egress_blocked_total{reason}`,
`outbox_pending_age_seconds`.

Missing, and required before any of the steps below can be triggered on
evidence rather than on feeling. Add these in Phase 3 with the worker
(ADR-0007 asks for the same four):

| Instrument | Type | Why |
|---|---|---|
| `queue_claim_duration_seconds` | histogram | the primary signal for step 6 |
| `queue_claim_batch_size` | histogram | a claim returning `limit` every time means workers are starved, not busy |
| `queue_claim_tenants` | gauge | `K` — distinguishes "one tenant" from "fairness is engaged" |
| `queue_head_of_line_delay_seconds` | histogram | `now() - next_attempt_at` at claim. **The fairness SLI.** Scheduling delay only; excludes attempt time |
| `db_pool_in_use` / `db_pool_waiting` | gauge | step 3's trigger; from `pgxpool.Stat()` |
| `retention_sweep_duration_seconds{table}` | histogram | step 5's trigger |
| `retention_rows_deleted_total{table}` | counter | tells you whether a sweep is falling behind or just slow |

`queue_head_of_line_delay_seconds` is the number to put on the wall.
`delivery_latency_seconds` mixes scheduling delay with the customer's own
endpoint latency, so it moves when a customer's server gets slower and is
useless as a platform SLI on its own.

---

## Step 0 — Partial index on the ready set

**Do this in the first migration.** The full definition, and why Prisma has to
carry it as hand-written SQL, are in ADR-0007. Without it, every claim is a
sequential scan of `deliveries`, and `deliveries` is the table that grows
fastest.

Trigger: none. This is not a scaling step, it is the baseline.

## Step 1 — Tenant-fair claim

See ADR-0007. Ship it with the Phase 3 worker.

**Trigger to verify it is working, not to decide whether to build it:**
`queue_head_of_line_delay_seconds` p99 should stay flat while
`deliveries_created_total` spikes on one project. If p99 tracks the burst,
fairness is not engaged — check `queue_claim_tenants`.

**Sizing.** `claim_limit` should be roughly the per-process in-flight
concurrency, so a claim fills the pool once. Starting point: `claim_limit = 64`,
poll interval 100–200 ms, snapshot refresh 1s.

## Step 2 — Autovacuum on `deliveries` and `delivery_attempts`

The ready-set index is partial on a mutable predicate, so each delivery churns
4–6 index tuples and no status update can be HOT (ADR-0007). Defaults —
`autovacuum_vacuum_scale_factor = 0.2` — mean a 50M-row table waits for 10M
dead tuples before a vacuum. The ready index is tiny, so it bloats to many
times its live size long before that, and the claim query slows with it.

Ship in the same migration as step 0:

```sql
ALTER TABLE deliveries SET (
    autovacuum_vacuum_scale_factor  = 0.01,
    autovacuum_vacuum_threshold     = 1000,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_vacuum_cost_delay    = 0
);
ALTER TABLE delivery_attempts SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_cost_delay   = 0
);
```

**Trigger for further attention:** `deliveries_ready_idx` size >2× its expected
live size (`queue_depth` summed across ready states × ~50 bytes/entry), or
`pg_stat_user_tables.n_dead_tup` on `deliveries` exceeding 10% of `n_live_tup`
for more than an hour. Estimated. `delivery_attempts` is append-only
(an invariant, per `docs/DEVELOPMENT.md`), so it needs vacuum for the visibility
map and freezing, not for dead tuples — hence the looser setting.

## Step 3 — PgBouncer

ARCHITECTURE.md 35/36 already require PgBouncer to be *supported*. This is about
when it becomes *required*.

Connection arithmetic: each `webhookd` process holds a pgx pool (assume 20), the
NestJS control API holds a Prisma pool per instance (assume 10). A managed
PostgreSQL at 4 vCPU typically caps `max_connections` at 200–400. Eight data
plane processes plus four API instances is 200 connections — at or past the cap
before any of them is busy.

**Trigger:** `db_pool_waiting > 0` sustained for 5 minutes, **or** total server
connections >60% of `max_connections`, **or** more than ~8 data-plane processes
planned. Estimated.

**Configuration that matters here:** transaction pooling. Every statement in the
delivery path is either a single statement or a short explicit transaction, so
transaction mode is safe. Two consequences to design around:

- Prisma must be told (`?pgbouncer=true`) or prepared-statement caching breaks.
- `pg_advisory_lock` held across statements does not survive transaction
  pooling. Nothing in the current design uses one; the scheduler's singleton
  jobs (retention, `ReclaimExpired`) must use a leader row or an advisory lock
  *inside* a transaction, never a session-level one.

## Step 4 — Read replica for the operator surface

The operator UI is the product (`CLAUDE.md`: answering "what happened to this
event" at 2am). Its queries — the delivery log filtered by project, endpoint,
status and time — scan far more rows than the claim does, and they arrive in
bursts when something is already going wrong. That is exactly the moment the
claim query must not be starved of buffer cache.

**Trigger:** operator list/search p95 >1s, **or** delivery-log queries exceeding
~25% of total `pg_stat_statements.total_exec_time`, **or** any correlation
between operator activity and `queue_claim_duration_seconds`. Estimated.

**Route to the replica:** delivery log search, event search, attempt history,
analytics, usage rollups, exports.

**Never route to the replica:** the claim query, the outbox drain, the router's
delivery inserts, replay, anything the ingest API reads to answer 202. Replica
lag turns "this event has no deliveries yet" into a false negative, and a
support engineer acting on a false negative is worse than a slow page. Show lag
in the UI when a replica-backed view is more than a couple of seconds behind.

## Step 5 — Partitioning

Order matters: **`delivery_attempts` first, then `deliveries`, then `events`.**
`delivery_attempts` is append-only, has the highest row count (one row per
attempt, so ≈ 1.3–3× deliveries depending on retry rate), is never updated, and
is only ever queried by `delivery_id` or by age. It is the easiest to partition
and the biggest win. `events` is last because payloads can already be offloaded
to object storage, which buys most of the same space relief with none of the
plan risk.

**Key: `RANGE (created_at)`, monthly, dropping to weekly above ~50M rows/month.**
Not by tenant: hash-by-`project_id` would give you hundreds of partitions,
would not help retention at all (retention is by age), and would force every
operator time-range query to touch every partition. Age is how the data dies,
so age is the partition key.

**Trigger:** any one of —

- table >150M rows or >200 GB (estimated; below that a well-indexed table with
  step 2's vacuum settings is fine);
- `retention_sweep_duration_seconds` p95 >1 hour, or a sweep that no longer
  finishes inside its window;
- `retention_rows_deleted_total` rate falling below the insert rate
  (`deliveries_created_total`), which means the table only grows;
- vacuum on the table running continuously.

The retention signal usually fires first, and it is the better one, because
`DROP PARTITION` versus `DELETE … WHERE created_at < …` is the actual reason to
partition. A bulk delete of tens of millions of rows generates as much WAL and
as many dead tuples as the inserts did, and leaves the space in the table.

### Interaction with retention (ARCHITECTURE.md 51)

Retention is **per plan** (7 / 30 / 90 days / custom); partitions are **global**.
A partition can only be dropped when the *longest* retention that has rows in it
has expired. So:

- **Drop partitions on the ceiling.** A weekly partition is dropped once it is
  older than `max(retention_days)` across all active tenants.
- **Sweep shorter tiers inside retained partitions.** A ranged `DELETE` scoped
  to `created_at` within one partition and to the projects on the shorter tier.
  This is bounded work: it only ever touches partitions between the shortest
  and longest tier.
- **Cap "custom".** An enterprise tenant on unlimited retention pins every
  partition forever and silently converts the whole platform's storage bill into
  that one contract. Enterprise retention must have a number, even a large one.
  If a tenant genuinely needs archive-forever, that is an export to object
  storage plus a documented restore path, not a live partition.
- Retention policy values stay in configuration and business rules, never in
  the engine (ARCHITECTURE.md 51). The sweep reads them; it does not embed them.

### Interaction with the claim query (ADR-0007) — the trap

The tenant-fair claim constrains `organization_id`, `project_id` and
`next_attempt_at`. It does **not** constrain `created_at`. Once `deliveries` is
partitioned on `created_at`, PostgreSQL prunes nothing and the claim probes
every partition, silently multiplying its cost by the partition count. The plan
still looks reasonable in `EXPLAIN`; it just gets slower every month.

The fix must land in the same change as the partitioning, not after:

```sql
AND dd.created_at >= now() - $7::interval   -- max retry window + margin
```

with the same predicate added to the ADR-0007 snapshot CTE, and
`deliveries_ready_idx` created on each partition. The interval is the longest
elapsed time any retry policy allows, plus margin. A delivery older than that
cannot legitimately still be ready; if one is, it is stranded, and the sweep
that finds stranded rows is a separate scheduled job — not something the hot
claim path should be paying to look for on every poll.

`delivery_attempts` and `events` carry no equivalent trap: both are queried by
primary key or by an explicit time range already.

## Step 6 — An external queue

Last, and only against measurement. ARCHITECTURE.md rule 23 — do not introduce
Kafka without a real requirement — and ADR-0003's migration path both apply.

**Trigger:** `queue_claim_duration_seconds` p99 >250 ms sustained, **with**
steps 0–5 already done, **and** `queue_depth{state="pending"}` growing while
`worker_active_count` is below its configured ceiling. That combination is the
only one that actually means "the queue is the bottleneck". Growing depth with a
saturated worker pool means add workers. Growing depth with open breakers means
customer endpoints are down and no queue will help. Estimated ceiling for the
PostgreSQL claim on the reference instance: **3,000–5,000 claims/s**, which at a
64-row batch is well past any volume this platform is planning for.

**Shape when it comes:** the external queue is a low-latency *notification* in
front of the same durable rows — "look now", with PostgreSQL still the record of
what must be delivered. `queue.Queue` is the seam. Fairness moves to per-tenant
queues or a scheduler in front of them; ADR-0007's snapshot logic is the natural
input to that scheduler and does not need rewriting.

---

## What is deliberately not on this list

- **Sharding by tenant / dedicated tenant databases.** ARCHITECTURE.md 53
  Stage 4. Not until a single PostgreSQL instance is genuinely exhausted, which
  is a long way past step 6.
- **Multi-region.** Same.
- **A separate analytics store.** Usage rollups against the read replica cover
  this until they visibly do not.
- **Caching delivery rows in Redis.** The claim needs the authoritative row and
  takes a lock on it; a cache in front of that is a correctness hazard, not a
  speedup.

## Measurement log

Append one row per step taken, with the measurement that triggered it. This is
what turns the estimates above into numbers.

| Date | Step | Triggering measurement | Result |
|---|---|---|---|
| — | — | *(nothing measured yet; Phase 3 load test is the first entry)* | — |
