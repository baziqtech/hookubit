# 0007 — Tenant fairness is a per-project cap inside the claim query

Status: Accepted

Supersedes nothing. Depends on ADR-0003 (PostgreSQL is the queue). Closes the
open question left at the end of the 2026-09-06 session
(`docs/DEVELOPMENT.md`).

## Decision

`PostgresQueue.Claim` stops being FIFO. It becomes a two-part operation:

1. **A tenant snapshot**, refreshed on a ticker (default 1s) per scheduler
   process, not per claim. A loose index scan enumerates the distinct
   `(organization_id, project_id)` pairs that currently have *ready* work, up
   to `4 × claim_limit` pairs, resuming from a rotating cursor so every tenant
   circulates through the snapshot.
2. **A claim with a per-tenant cap.** The scheduler shuffles the snapshot,
   takes `K = min(len(snapshot), claim_limit)` pairs, computes
   `cap = max(1, ceil(claim_limit / K))`, and issues one `UPDATE … FROM (…
   CROSS JOIN LATERAL … LIMIT cap FOR UPDATE SKIP LOCKED)` statement.

The cap is **derived from the number of active tenants in this batch, never a
constant**. That single rule is what makes the design degrade correctly: with
one active tenant, `K = 1`, `cap = claim_limit`, and the query is FIFO again
with the cost of one extra index descent. A fixed cap would throttle a lone
tenant to `cap` rows per poll and leave workers idle in front of a backlog —
the most likely way to get this wrong.

Fairness levels (ARCHITECTURE.md 24) are satisfied as follows:

| Level | Mechanism | Phase |
|---|---|---|
| Global | bounded worker pool, `worker_active_count` (ARCHITECTURE.md 23) | 3 — exists |
| Organization | cap on projects-per-org applied in Go over the snapshot list | 3 — this ADR |
| Project | the `LATERAL … LIMIT cap` in the claim SQL | 3 — this ADR |
| Endpoint | Redis semaphore keyed on `endpoint:{id}`, `endpoints.max_concurrency` | 4 — with the circuit breaker |

Org-level fairness is applied in Go, not SQL, because the snapshot is a list of
at most a few hundred pairs. Grouping and truncating it in Go costs
microseconds and stays readable; expressing it as a second recursion level in
SQL does not.

## Options considered

### (a) Partial index + plain FIFO — rejected as a fairness mechanism, kept as the substrate

The partial index is required no matter which option wins, so this is not
really an alternative; the question is whether FIFO *on top of it* suffices.

It does not, and the arithmetic is short. Head-of-line delay for a small tenant
is `backlog_ahead_of_it / drain_rate`. Estimating a modest production data
plane at 8 worker processes × 64 in-flight attempts with a 200 ms mean attempt,
drain is ≈ 2,500 deliveries/s. A 100k-event burst therefore parks every other
tenant for ≈ 40 s; on a two-worker deployment (≈ 500/s) it is ≈ 200 s. Against
a p95 first-attempt SLO of 5 s, FIFO holds only while the largest burst any
tenant can produce stays under ≈ 12,000 ready rows.

So (a) is adequate up to roughly **single-digit active tenants and bursts below
~10k events** — and even there it is adequate by accident, not by design. It
has no failure mode that degrades gracefully: it is fine until one customer
runs a backfill, and then it is a total outage for everyone else with no lever
to pull. Numbers above are estimates until the Phase 3 load test replaces them.

### (b) LATERAL cap of N per project per claim batch — **chosen**

Bounds any one tenant's share of a claim batch to `cap` rows. Cost is one index
descent per tenant per claim instead of one per batch. The naive form —
`SELECT DISTINCT project_id FROM deliveries WHERE <ready>` as the driver — is a
full scan of the ready set on every poll and must not be used; the loose index
scan below is what makes the driver cheap.

### (c) Per-endpoint semaphores in Redis, PostgreSQL still authoritative — deferred, not rejected

This is the right mechanism for the *endpoint* level and it is on the Phase 4
list alongside the circuit breaker, which needs the same Redis key space.
Rejected as the *primary* fairness mechanism for two reasons.

First, it is enforced after the claim, not during it. A tenant that has
saturated its endpoint semaphores still wins every claim slot; the worker then
releases the rows it may not deliver. The unfairness moves from delivery to
claim churn, and claim churn is `UPDATE` traffic on the hottest table in the
system.

Second, it puts Redis on the path that decides what gets worked. ADR-0003 and
ARCHITECTURE.md 14 permit Redis to hold rate-limit and breaker state because
losing it costs accuracy, not data. A semaphore that gates *scheduling* makes a
Redis flush look like a stall, and a leaked semaphore (worker killed -9 between
acquire and release) look like a permanently quiet endpoint. That needs lease
expiry and a reconciler — real work, for a level of the hierarchy that the
project cap already blunts, since a single endpoint can now consume at most one
project's slice.

When it lands, it belongs *inside* the worker, between claim and attempt, with
a TTL on every semaphore token and `rate_limit_hits_total{scope="endpoint"}`
counting the deferrals.

## Why it exists

One project publishing a 100k-event burst currently fills every claim batch,
and `ORDER BY next_attempt_at, created_at` guarantees it keeps filling them
until the burst drains. Every other organisation's deliveries wait behind work
that is not theirs — on a platform whose entire proposition is that one
endpoint's problems never become another's (ARCHITECTURE.md 18).

FIFO is also the wrong global objective. Nobody is buying "your event was
queued before theirs". They are buying "my events go out in seconds regardless
of what my neighbour is doing". Per-tenant round-robin optimises for the metric
customers actually feel.

## What it prevents

- **Burst monopoly.** A 100k-event backfill in one project can occupy at most
  `cap` of `claim_limit` slots per batch, so a neighbour's single delivery waits
  one poll interval, not the burst's full drain time.
- **A tenant with many projects buying back the monopoly.** The org-level
  truncation over the snapshot stops one organisation from fielding 200
  projects to win 200 slices.
- **Starvation once active tenants exceed the batch size.** With
  `K = min(len(snapshot), claim_limit)` the cap floors at 1, so beyond
  `claim_limit` active tenants a single batch cannot serve everyone. The
  rotating snapshot cursor plus the per-claim shuffle make that round-robin
  across polls instead of permanent starvation of whoever sorts last.
- **A lone tenant being throttled by its own fairness mechanism** — see the
  derived-cap rule above.

## The SQL

Two statements. Both depend on one schema change and one index.

### Prerequisite schema change (control-plane / Prisma task)

> **Done** — migration `20260911000000_next_attempt_at_not_null`. The predicate
> is a plain range, the `NULLS FIRST` is gone from every ORDER BY, and both
> ready-set indexes were rebuilt without it (with `id` appended for the claim
> tiebreaker) so the claim reads straight off the index with no Sort node.

`deliveries.next_attempt_at` becomes `NOT NULL`, defaulted to `created_at` at
insert. Every ready-set predicate and every `ORDER BY` in the delivery path
currently carries `IS NULL OR <= now()` / `NULLS FIRST` to work around a
nullable column that is only ever null for "due immediately". Removing the
nullability removes that from four places and lets a plain b-tree range serve
the ordering. No data exists yet; this is free today and a migration over the
largest table in the system later.

### The index

Prisma cannot express a partial index, so this goes in hand-written SQL inside
a Prisma-generated migration. ADR-0002 is preserved: Prisma still owns the
file, Go still never migrates.

```sql
CREATE INDEX CONCURRENTLY deliveries_ready_idx
    ON deliveries (organization_id, project_id, next_attempt_at, created_at)
 WHERE status IN ('pending', 'scheduled', 'queued', 'retrying');
```

One index serves both statements: its leading columns drive the tenant
enumeration, and within a fixed `(organization_id, project_id)` prefix the
remaining columns give the due-ordered pick directly.

`@@index([status, nextAttemptAt])` in `schema.prisma` becomes redundant and
should be dropped in the same migration. `locked_until` is deliberately *not*
in the index: a leased row has `status = 'processing'` and is therefore outside
the partial predicate, so the `locked_until` guard is a near-free heap filter
that only catches rows released without clearing the column.

### 1. Tenant snapshot (read-only, on a ticker, no locks)

```sql
WITH RECURSIVE ready_tenants AS (
    (SELECT d.organization_id, d.project_id
       FROM deliveries d
      WHERE d.status IN ('pending', 'scheduled', 'queued', 'retrying')
        AND d.next_attempt_at <= now()
        AND (d.organization_id, d.project_id) > ($1::text, $2::text)
      ORDER BY d.organization_id, d.project_id
      LIMIT 1)
    UNION ALL
    SELECT n.organization_id, n.project_id
      FROM ready_tenants t
      CROSS JOIN LATERAL (
          SELECT d.organization_id, d.project_id
            FROM deliveries d
           WHERE d.status IN ('pending', 'scheduled', 'queued', 'retrying')
             AND d.next_attempt_at <= now()
             AND (d.organization_id, d.project_id)
                 > (t.organization_id, t.project_id)
           ORDER BY d.organization_id, d.project_id
           LIMIT 1
      ) n
)
SELECT organization_id, project_id
  FROM ready_tenants
 LIMIT $3;
```

`$1, $2` are the rotating cursor: the last pair returned by the previous
refresh, or `('', '')` to start from the beginning. When a refresh returns
fewer than `$3` rows the cursor resets to `('', '')` on the next tick — that
wrap is what circulates tenants beyond the snapshot size. `$3` defaults to
`4 × claim_limit`.

This is PostgreSQL's missing loose index scan, written by hand. It costs one
index descent per distinct tenant, not one scan of the ready set.

### 2. The claim

```sql
UPDATE deliveries d
   SET status       = 'processing',
       locked_by    = $1,
       locked_until = now() + $2::interval,
       updated_at   = now()
  FROM (
    SELECT c.id
      FROM unnest($3::text[], $4::text[]) AS t(organization_id, project_id)
      CROSS JOIN LATERAL (
          SELECT dd.id
            FROM deliveries dd
           WHERE dd.organization_id = t.organization_id
             AND dd.project_id      = t.project_id
             AND dd.status IN ('pending', 'scheduled', 'queued', 'retrying')
             AND dd.next_attempt_at <= now()
             AND (dd.locked_until IS NULL OR dd.locked_until < now())
           ORDER BY dd.next_attempt_at, dd.created_at
           LIMIT $5
           FOR UPDATE SKIP LOCKED
      ) c
     LIMIT $6
  ) picked
 WHERE d.id = picked.id
RETURNING d.id, d.event_id, d.endpoint_id, d.organization_id, d.project_id,
          d.attempt_count, d.next_attempt_at,
          COALESCE(d.ordering_key, ''), d.locked_until;
```

- `$3`/`$4` are the shuffled snapshot slice, `K = min(len(snapshot), $6)` pairs
  long, passed as two parallel arrays.
- `$5` is `cap = max(1, ceil($6 / K))`.
- `$6` is the existing `claim_limit`.
- `FOR UPDATE SKIP LOCKED` sits inside the LATERAL, which is an inner join, so
  the "nullable side of an outer join" restriction does not apply. Locking is
  still per-row and still skips contended rows, so the no-double-processing
  invariant is unchanged.
- The shuffle matters: without it the outer `LIMIT $6` would systematically
  truncate whichever tenants sort last in the array.

### Fallback

Keep the current FIFO statement behind `CLAIM_STRATEGY=fifo`. If the snapshot
is empty or its refresh errors, the scheduler falls back to FIFO for that poll
rather than claiming nothing. `deliveries_ready_idx` does not order globally by
`next_attempt_at`, so the fallback pays a sort — acceptable on an emergency
path over a ready set that is small by construction, and cheaper than carrying
a second partial index on the hottest rows in the database purely for it.

## What this costs — honestly

**Query plan complexity.** A recursive CTE plus a lateral is not something an
on-call engineer reads at 2am. Mitigations, all required: both statements stay
behind the `queue.Queue` interface; the FIFO statement stays shippable via
config; and the Phase 3 load test must record `EXPLAIN (ANALYZE, BUFFERS)` for
both into `docs/design/scale-and-partitioning.md` so there is a known-good plan
to diff against.

**Index write amplification and bloat.** `deliveries_ready_idx` is partial on a
*mutable* predicate. Every status transition — pending → processing →
succeeded, plus each retry back into the set — inserts or removes an index
tuple, and no update touching `status`, `locked_by` or `locked_until` can be
HOT. Budget roughly 4–6 index tuple churn events per delivery. The index itself
stays small (only ready rows, so hundreds to low thousands of entries in steady
state), but the dead-tuple rate on `deliveries` is high and autovacuum defaults
will not keep up. Ship with the table-level settings in
`docs/design/scale-and-partitioning.md` in the same migration, and watch index
size, not just row count.

**Cost when one tenant is the only tenant.** `K = 1`, `cap = claim_limit`, one
extra index descent for the snapshot every 1s. Measurably identical to FIFO.
This is the common case for a self-hosted single-org install and it must stay
free — it is the first thing to assert in the benchmark.

**Per-poll probe cost at the other end.** `K` is capped at `claim_limit`
precisely because a larger `K` cannot help: the cap floors at 1, so enumerating
more tenants than the batch can serve only buys index descents. At 8 scheduler
processes polling 20×/s with `claim_limit = 64`, worst case is ≈ 10k index
descents/s against a small, fully-cached index. Real but affordable; the
snapshot refresh, being on a 1s ticker, is negligible next to it.

**Latency floor.** Round-robin means a tenant's own burst now drains at
`cap` per batch rather than `claim_limit`. Single-tenant *throughput* is
unchanged only while other tenants are idle. That is the trade being bought and
it should be stated in the product docs, not discovered by a customer.

**What this does not do.** It does not bound work by payload size, endpoint
latency, or attempt cost — a tenant whose endpoints all take 30 s still ties up
worker slots long after the claim was fair. That is the endpoint semaphore's
job (option (c), Phase 4), and until it lands the per-project cap is the only
thing standing between one slow tenant and the pool.

## How it scales

Claim cost is `O(K)` index descents with `K ≤ claim_limit`, independent of
backlog depth and independent of how skewed the backlog is. Adding workers adds
claim volume linearly and `SKIP LOCKED` keeps them from serialising, exactly as
in ADR-0003.

The ceiling is the same one ADR-0003 named — write amplification on
`deliveries` and `delivery_attempts` — reached before claim CPU becomes the
problem. `docs/design/scale-and-partitioning.md` carries the ordered response
and the metric thresholds that trigger each step.

One interaction to carry forward: once `deliveries` is range-partitioned on
`created_at`, this claim query prunes nothing, because it constrains
`organization_id`, `project_id` and `next_attempt_at` but not the partition
key. A `created_at >= now() - <max retry window>` predicate must be added at
the same time. It is written down in the partitioning doc rather than left to
be rediscovered by a query plan that quietly scans every partition.

## Migration path

1. **Phase 3, with the worker.** Schema change, index, both statements,
   `CLAIM_STRATEGY` config, and the benchmark that proves the single-tenant
   case is free. Add `queue_claim_duration_seconds`,
   `queue_claim_batch_size`, `queue_claim_tenants` and
   `queue_head_of_line_delay_seconds` to `internal/metrics` — the last is the
   fairness SLI (`now() - next_attempt_at` at claim time, which is
   scheduling delay only and excludes attempt time).
2. **Phase 4, with the circuit breaker.** Option (c) as the endpoint level:
   Redis semaphores with TTLs, checked between claim and attempt, deferrals
   counted on `rate_limit_hits_total{scope="endpoint"}`.
3. **Weighting, only on evidence.** `cap` is uniform today. Per-plan weights
   (`cap × tier_weight`) are a one-line change once there is a commercial
   reason; do not build the weighting machinery before a customer is paying
   for priority.
4. **External queue.** Unchanged from ADR-0003: `queue.Queue` is the seam, and
   fairness moves to per-tenant queues or a scheduler in front of them. Nothing
   here forecloses it, and per ARCHITECTURE.md rule 23 it waits for measured
   claim latency, not fashion.
