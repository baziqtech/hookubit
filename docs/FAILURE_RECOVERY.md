# Failure recovery

ARCHITECTURE.md 57 lists twenty ways this platform breaks and says every one of
them needs a defined recovery strategy. Until now those strategies existed only
as code. This document is the strategy, written from the code as it is — not as
the architecture wishes it were. Where the code does something weaker than the
architecture claims, it says so under **Gaps** and does not soften it.

Read the summary table first. If you are being paged, jump to the numbered
section; each one tells you what is lost, what is merely late, who is affected,
and what to do.

**Revision note (2026-09-09).** The first version of this document was written
against the code of that morning and was overtaken by the fixes it prompted, so
every line number and every claim below has been re-verified against the tree as
it stands. All twelve of the original gaps have been acted on: ten are fully
closed, G10 is half closed (its remainder is now G15), and G11's fix left behind
a stale comment (now G18). The closed ones are kept, with a line each on what
broke and what fixed it, because the failure mode is what explains why the code
is shaped the way it is. **Gaps, open** is a separate list and contains nothing
that has been fixed. Six gaps are open; the most operationally significant is
G13, and it is new since the first draft because the load suite measured it.

## The lens

Every scenario is judged by one question, borrowed from ARCHITECTURE.md:

> If this component vanishes for an hour, do I lose data or only time?

Three answers recur, and the distinction matters more than any other in this
document:

- **Only time.** State is durable in PostgreSQL; the work resumes when the
  component returns. No operator action.
- **Time, plus an operator action.** State is durable but has left the automatic
  recovery path. A human must do something, and the something is named here.
- **Data.** Something that returned `202 Accepted` will not be delivered and
  cannot be recovered through any API.

As of this revision **nothing in the twenty scenarios lands in the third
category.** The two that did — a parked outbox row and a fan-out truncated by
the subscription cap — are now recoverable through an API and structurally
impossible respectively.

## Delivery guarantee, stated once

**At-least-once, per (event, endpoint) pair.** Never exactly-once. The design
chooses a duplicate delivery over a lost one at every fork, and three specific
windows produce duplicates by construction: a worker that dies between the HTTP
response and its database write (scenario 5), a lease that lapses under a live
attempt (scenarios 4 and 17), and a drain window that expires after the request
went out (scenario 4 — the attempt is no longer *charged*, but the endpoint may
still have received it). Consumers must be idempotent. `Webhook-Delivery-Id` is
stable across the retries of one delivery; `Webhook-Attempt` increments.

**Exactly-once fan-out**, by contrast, is genuinely enforced: one event becomes
at most one *original* delivery row per endpoint, arbitrated by the partial
unique index `deliveries_event_endpoint_original_key`
(`apps/control-api/prisma/migrations/20260906010000_review_fixes/migration.sql:41`),
which the router names verbatim in its `ON CONFLICT`. That index is what makes
the new batched fan-out safe: a crash between batches re-runs at worst one batch
and creates nothing twice
(`services/data-plane/internal/router/store.go:513-517`, proven by
`TestPostgresReplayingAFanOutBatchCreatesNoDuplicates`,
`internal/router/store_postgres_test.go:1076`).

## A note on the tests

The failure-injection suite exists. It is two packages:

- `services/data-plane/internal/failure/` — the crash, burst, breaker and
  endpoint-behaviour scenarios (1–6, 10–12, 17, 19, 20), plus the retry-budget
  regression tests. Package doc at `internal/failure/doc.go`.
- `services/data-plane/internal/failure/outage/` — the infrastructure-outage
  half: Redis, PostgreSQL, the queue, the pool (7, 8, 9, 18) and the DNS/SSRF
  group (13–16). Package doc at `internal/failure/outage/doc.go`.

Both contain no production code and assert only through the exported surface a
real deployment uses. A "crash" is simulated — a transaction abandoned before
COMMIT, a lease left to lapse, an attempt context cancelled — because those are
the states a killed process actually leaves behind. Outages are simulated in
process (a TCP relay in front of PostgreSQL that the test closes; a Redis client
pointed at a closed port; a pool of one connection already checked out) and
never by stopping a real service, because other packages share those services.

**Running them.** Both packages *skip* rather than fail when `DATABASE_URL` is
unset, which is `internal/testsupport`'s contract. They share `hookubit_test`
with every other DB-backed package and take an advisory lock on it for the
duration of the binary, so a concurrent run queues instead of corrupting
anything. Point `DATABASE_URL` at a database whose name ends in `_test`; any
other name is refused, because the run truncates every table before it starts.

Test names in the sections below are **verified references** — each was checked
to exist at the file and line given. Where a scenario has no test, the section
says so.

---

## Summary

| # | Scenario | Strategy in one line | Data loss? | Blast radius | Status |
|---|---|---|---|---|---|
| 1 | Ingest crashes before DB commit | Nothing was written; the client never got a 202 and retries | No | One request | Implemented |
| 2 | Ingest crashes after DB commit | Event + outbox row committed together; the router picks it up regardless | No | One request | Implemented |
| 3 | Worker crashes before delivery | Lease expires; `processing` is inside the claim predicate, so any worker reclaims it | No | Leases held by one pod | Implemented |
| 4 | Worker crashes during delivery | Lease keeper cancels on loss; drain finishes in-flight work; a cut-short attempt is deferred, not charged | No | One delivery each | Implemented |
| 5 | Worker crashes after HTTP response, before DB write | Lease expires, another worker re-delivers; the endpoint sees a duplicate | No | One delivery | Implemented (at-least-once by design) |
| 6 | Scheduler crashes | Reclaim is an optimisation, not the recovery path; the claim query finds expired leases itself | No | Fleet-wide latency, plus a stale `queue_depth` | Implemented |
| 7 | Redis unavailable | Redis is never the queue and never authoritative; both limiters degrade to per-replica buckets | No | Rate-limit accuracy only | Implemented — see G17 for the never-configured case |
| 8 | PostgreSQL unavailable | Ingest 500s, router/worker idle and resume; pods wait for the database instead of crash-looping | No | Everyone | Implemented |
| 9 | Queue unavailable | The queue *is* PostgreSQL — identical to 8 | No | Everyone | Implemented |
| 10 | Endpoint times out | Every phase bounded, resolution bounded separately, endpoint `timeout_ms` may only shorten | No | One endpoint, but see G13 | Partial — the blast-radius bound is a ceiling, not a reservation (G13) |
| 11 | Endpoint returns 500 | Retryable; backoff with jitter; breaker opens after 5 consecutive | No | One endpoint | Implemented |
| 12 | Endpoint returns 429 | Retryable; `Retry-After` honoured and clamped; counted against the breaker | No | One endpoint | Implemented |
| 13 | DNS resolution fails | Classified `dns`, retried as a transport fault, bounded by `EGRESS_DNS_TIMEOUT_MS` | No | One endpoint | Implemented |
| 14 | DNS resolves to a private IP | Refused at dial time by `Dialer.Control`; permanent, counted on `egress_blocked_total` | No (refused, not lost) | One endpoint | Implemented |
| 15 | Endpoint redirects to a private IP | Redirects disabled by default; when enabled, every hop is re-validated | No | One endpoint | Implemented |
| 16 | DNS changes after validation (rebinding) | The check runs after resolution and before connect, per address — including through the bounded dialer | No | One endpoint | Implemented |
| 17 | Two workers attempt the same delivery | `FOR UPDATE SKIP LOCKED` inside a materialized CTE + lease + `locked_by` guard on every write | No | One delivery | Implemented |
| 18 | Connection pool exhausted | Bounded pool, per-call deadlines, server-side `statement_timeout`, pre-auth ceiling, readiness sheds load | No | One pod, then its tenants | Partial — the worker still borrows `INGEST_DB_TIMEOUT_MS` (G15) |
| 19 | Tenant creates a huge burst | Pre-auth + policy limits on ingest, batched fan-out with a durable cursor, four concurrency ceilings in the worker | No | One project, then its neighbours | **Partial — isolation is a ceiling, not a reservation (G13); fairness off by default** |
| 20 | Endpoint permanently unhealthy | Breaker opens, cooldown doubles to a 10-minute ceiling, one probe per cycle; deferred deliveries age out; an endpoint open past `ENDPOINT_AUTO_DISABLE_AFTER_HOURS` is auto-disabled and stops having delivery rows created | No | One endpoint | Implemented |

---

## Gaps, open

Ranked by what will actually cost you. Every one is a real defect or a real
divergence from the architecture, with the code that proves it.

| ID | Severity | Gap |
|---|---|---|
| G13 | **Medium** (was High) | Per-endpoint isolation is a **ceiling, not a reservation**. When the `max_concurrency` of the endpoints that can be slow sums past `WORKER_CONCURRENCY`, slow work is entitled to the whole pool and fast endpoints starve. The rule is now *said* (startup advisories carrying the arithmetic) and *visible* (bounded gate-occupancy gauges), which is what dropped it from High — but nothing enforces it, and the reservation itself is deliberately not built. Measured, not reasoned. |

### G13 — per-endpoint isolation is a ceiling, not a reservation

**The most operationally significant thing open.** It is also the only gap here
that was measured rather than read out of the source: see
`docs/LOAD_TESTING.md` §7, "Per-endpoint isolation is a ceiling, not a
reservation".

`endpoints.max_concurrency` bounds how many slots **one** endpoint may hold
(`internal/worker/gate.go:91-101`). Nothing **reserves** slots for anyone else.
The global gate is the only thing above it, and at its shipped defaults it
cannot bind: `MAX_CONCURRENCY_GLOBAL` is 512
(`internal/config/config.go:287`) against a `WORKER_CONCURRENCY` of 64
(`config.go:257`), so the real ceiling on in-flight attempts in a process is the
worker pool, eight times below the gate that is supposed to bound it.

So the arithmetic that decides whether isolation holds is:

```
sum(max_concurrency of endpoints that can be slow)  <  WORKER_CONCURRENCY
```

and **nothing in the product states, surfaces or enforces it.** The control
plane validates `max_concurrency` only against a fixed 1–256 range
(`apps/control-api/src/endpoints/endpoint-limits.ts:21`) and has no knowledge of
`WORKER_CONCURRENCY` at all. The data plane's only cross-check is
`MAX_CONCURRENCY_PER_ENDPOINT <= MAX_CONCURRENCY_PER_PROJECT`
(`internal/config/config.go:402-403`). The relationship that actually matters is
checked nowhere.

Measured, endpoints on distinct hosts, 92 deliveries/s, pool of 64
(`docs/LOAD_TESTING.md:336-352`):

| slow endpoints x cap | slow share of pool | fast p50 | fast p95 |
|---|---|---|---|
| 6 x 16 = 96 | all of it | 6,703 ms | 16,565 ms |
| 6 x 4 = 24 | 38% | 650 ms | 8,117 ms |
| control: no slow endpoints | none | 456 ms | 1,044 ms |

Those three rows predate the `EGRESS_MAX_CONNS_PER_HOST` fix, and the residue
they show is claim churn: a gate-refused delivery is deferred and re-claimed, so
a slow endpoint's backlog cycles repeatedly through the FIFO claim and takes
claim capacity from endpoints that could have run — 7,176 deferrals against
3,974 deliveries in the middle row.

**Re-measured after that fix, the scenario passes when the caps are provisioned
under the pool.** Single-port topology (one hostname, one project, one pool —
the harshest case in the suite), `LOAD_SLOW_MAX_CONCURRENCY=4`:

| slow caps | fast p50 | fast p95 | slow peak in-flight | verdict |
|---|---|---|---|---|
| 6 x 16 = 96 | 6,460 ms | 12,660 ms | 58 | FAIL |
| 6 x 4 = 24 | 485 ms | **1,782 ms** | 24 | **PASS** |

That changes what this gap is. It is **not** "isolation does not work" — with
the transport ceiling gone, isolation is achievable by configuration, and no
value of `max_concurrency` could achieve it before. The peak in-flight column is
the gate doing exactly its job: 24, the sum of the configured caps, not the 58
it took when over-provisioned.

What remains is that **the rule is unwritten, unenforced and unsurfaced.** An
operator gets isolation by knowing the arithmetic above; there is no warning, no
validation and no metric that would lead them to it. That is a discoverability
defect rather than a capability one, which is a smaller problem than the first
draft of this section described — and still the most operationally significant
thing open, because the failure mode is silent and the symptom (one customer's
webhooks slow) points nowhere near the cause.

What this is not: a bug in the gate. The gate does exactly what it is written to
do (`internal/worker/gate.go:65-101`), and the non-blocking acquire is right —
blocking would park goroutines behind the slow endpoint, which is the
starvation this design exists to prevent. The gap is between what the gate does
and what the architecture claims from it: ARCHITECTURE.md 24 says the ceilings
exist to "prevent noisy neighbors", and its acceptance list at line 2289 says
flatly "One tenant cannot starve others." At the shipped defaults, with slow
endpoints, that sentence is not true — and the number that decides whether it is
true is not visible anywhere a person would look.

*Fix shapes, in ascending cost:*
(a) **Say it.** A startup WARN when `MAX_CONCURRENCY_PER_ENDPOINT` x a plausible
slow-endpoint count exceeds `WORKER_CONCURRENCY`, and a line in the operator
docs. Cheap, and it converts an invisible failure into a known one.
(b) **Surface it.** Expose per-endpoint in-flight and the pool's free slots so an
operator can see the pool being eaten. `rate_limit_hits_total{scope="endpoint_concurrency"}`
(`internal/worker/deliver.go:101`) already counts the churn; nothing shows the
occupancy that causes it.
(c) **Reserve it.** A share of the pool that slow endpoints cannot cross —
a second, smaller gate that only deliveries to endpoints with a recent slow
history must pass. This is the real fix and it is a design change, not a patch.

Not attempted here, and it should not be attempted without (a) and (b) first:
without occupancy data, any reservation number is a guess.

### G14 — no auto-disable, no retention  (CLOSED)

The first half of the old G3 is fixed: a delivery held behind an open breaker
now evaluates its wall-clock budget and goes terminal
(`internal/worker/deliver.go:517-519`, `:606-630`). What remains is upstream and
downstream of that.

- **No auto-disable.** The data plane issues no writes against `endpoints` at
  all, and `disabled_reason` is only ever set to `null` by the control plane
  (`apps/control-api/src/endpoints/endpoints.service.ts:310`, with the ownership
  note at `:326`). An endpoint whose breaker has been open for a week keeps
  receiving a fresh delivery row for every matching event, each of which is
  claimed, refused, deferred, and eventually exhausted 24 hours later. The
  breaker removes *request* pressure; nothing removes *row* pressure.
- **No retention.** There is no reaper in either plane. Terminal deliveries and
  their attempt rows accumulate for the life of the installation.

Bounded now, where it was unbounded — a dead endpoint's live backlog is capped
at roughly `MaxRetryDuration` x ingest rate rather than growing forever — but
still a table that only grows and a corpse that keeps being delivered to.

*Fix shape:* auto-disable an endpoint that has been `open` longer than a
configured window, writing `disabled_reason` (the column exists and the
dashboard already renders it,
`apps/control-api/src/endpoints/dto/endpoint-response.dto.ts:141`); then a
retention sweep on the scheduler role, which already carries two periodic jobs.

### G15 — the worker has no database timeout of its own  (CLOSED)

`runWorker` passes `DBTimeout: cfg.IngestDBTimeout`
(`cmd/webhookd/roles.go:268`). There is no `WORKER_DB_TIMEOUT_MS`, so tuning the
ingest deadline silently retunes every database call the delivery loop makes.
It is listed as known future work at `HANDOFF.md:698`.

The worse half of this is fixed: the object-storage fetch no longer inherits the
database budget. It takes `PAYLOAD_DOWNLOAD_TIMEOUT_MS`
(`cmd/webhookd/roles.go:273`, applied at `internal/worker/payload.go:66`), asserted by
`TestPayloadFetchUsesItsOwnBudgetNotTheDatabaseOne`
(`internal/worker/defer_test.go:476`).

### G16 — the tenant gate defers without a budget  (CLOSED)

`handle` refuses at the org/project gate before the delivery row has been read,
and therefore defers with `unknownBudget`
(`internal/worker/deliver.go:41-52`). `deferBudget.expired` returns false for a
zero budget by construction
(`deliver.go:517-519`, `internal/retry/retry.go:179-184`), so the wall-clock
termination that closed the breaker case does not apply here.

The in-code reasoning (`deliver.go:44-48`) is that a tenant concurrency ceiling
is a momentary condition that clears on its own, and that reading the row to
find the budget would put a join and a decrypt in front of every refusal. That
is a good argument for the common case. It is a weaker argument under exactly
the condition G13 describes: a pool saturated by slow endpoints for hours, where
the same delivery can be refused at the project gate on every claim and nothing
ever consults its clock. The two gaps compound, which is why this is listed
rather than waved through.

*Fix shape:* the delivery row's `created_at` is already in the claim result;
carrying the frozen `max_retry_duration` alongside it would make the budget
knowable at the tenant gate without a second query. Not attempted — it touches
the claim SQL, which is the most load-bearing statement in the system.

### G17 — the delivery limiter is fleet-wide only with Redis  (CLOSED)

`buildDeliveryLimiter` returns nil when `REDIS_URL` is unset
(`cmd/webhookd/roles.go:320-325`), and the worker then falls back to the
in-process `TokenBucket` (`internal/worker/worker.go:195-198`), which is honest
about its scope in its own doc comment
(`internal/worker/ratelimit.go:34-41`): run eight workers and an endpoint
configured for 100/s receives up to 800/s.

This is the correct *design* — delivery must never depend on Redis being up, and
the fallback is exactly right. The gap is that a production deployment can be
missing `REDIS_URL` and the only signal is one WARN line at startup
(`roles.go:322-323`). Nothing in `Config.validate` objects, unlike
`EGRESS_ALLOW_PRIVATE_NETWORKS`, which *is* refused in production
(`internal/config/config.go:333-335`). A customer who sets an endpoint rate
limit to protect their own infrastructure does not get the limit they
configured, and the number they get changes when we scale the Deployment.

*Fix shape:* refuse to start a worker in production without `REDIS_URL`, or
publish the effective multiplier on a gauge so a dashboard can show it.

## Gaps, closed

Kept because the failure mode explains the shape of the code. Each line is
what broke, and what the fix was.

| ID | Was | Fixed by |
|---|---|---|
| G1 | A parked outbox row was unrecoverable through any API: an event that returned 202 could end permanently undelivered, recoverable only by hand-written SQL. | `attempts` split into a monotonic operator-facing counter and `unaccounted_attempts`, the poison bound, which is refunded by any write the lease holder commits — so a Postgres brownout no longer spends the budget of rows that were never at fault. Recorded failure is bounded by elapsed time instead (`failing_since` + `ROUTER_MAX_OUTBOX_RETRY_DURATION_MS`). A control-plane API lists and requeues parked rows, single and bulk (`apps/control-api/src/outbox/`). Scenario 8, scenario 18. |
| G2 | The fan-out cap bounded the **event**: a project with more subscriptions than `ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT` silently dropped the surplus forever, and replay could not reach them because they had no delivery rows. | The cap now bounds a **batch**. The router walks subscriptions by keyset, stores the resume point in `event_outbox.fan_out_cursor`, and marks the event `processed` only on the final batch. Additionally pinned to publish time so a subscription created mid-walk cannot receive an event accepted before it existed. Scenario 19. |
| G3 | Deliveries behind a permanently open breaker never reached a terminal state: `Policy.Exhausted` was reachable only from `Decide`, which runs only when an attempt completes. The backlog grew without bound and sorted ahead of live traffic under FIFO. | The wall-clock budget is evaluated on the **deferral** path. An out-of-budget deferred delivery goes `exhausted` / `retry_duration_exhausted`, with no attempt row and no `attempt_count` charged. Scenario 20. Residue in G14. |
| G4 | A PostgreSQL outage at boot became CrashLoopBackOff across the whole data plane, and fleet recovery was then gated on kubelet's five-minute backoff rather than on the database. | `cmd/webhookd` binds the probe server **before** opening the pool and waits for PostgreSQL with capped backoff (`db.OpenWithRetry`). Readiness distinguishes `starting` from `draining`. Startup probes added across the chart and the manifests. Scenario 8. |
| G5 | A drain-window expiry cancelled attempts with a bare `context.Canceled`, which classifies as a retryable transport fault — so our restart wrote `context canceled` into the customer's ledger, advanced `attempt_count` and moved their breaker one failure closer to open. | `ErrWorkerShutdown` is the cancellation cause; a cut-short attempt is deferred, writes no attempt row and charges no budget. A related race was fixed with it: `LeaseKeeper.Run` used to cancel tracked attempts with a hard-coded `context.Canceled`, racing the worker on the same children — first-writer-wins, so a fraction of drains still charged the endpoint. It now inherits the parent's cause. Scenario 4. |
| G6 | Per-endpoint delivery rate limits were per-process; N workers delivered at N x the configured rate, and the fleet-wide implementation was written but wired to nothing. | The distributed limiter is wired. Endpoint limits are fleet-wide when `REDIS_URL` is set, falling back to the in-process bucket otherwise. Residue in G17. Scenarios 12 and 19. |
| G7 | `EGRESS_DNS_TIMEOUT_MS` was read, passed, stored on the struct and applied by nothing. An operator tuning DNS behaviour under an incident changed nothing at all. | `internal/egress/dial.go`. Resolution has its own deadline, and each address gets a *share* of the connect budget (`partialDeadline`, mirroring `net/dial.go`) so a black-holed first address cannot starve the rest. Scenarios 10 and 13. |
| G14 | A permanently dead endpoint was never disabled, so every new event kept fanning out to the corpse forever — delivery rows created, refused by the open breaker, deferred, re-claimed, expired, at ingest rate. And nothing pruned terminal deliveries or attempts, so the ledger grew without bound. | Auto-disable in `apps/control-api/src/maintenance/`, written by the **control plane** so the data plane still issues no write against `endpoints` — one writer means one definition of "disabled", and the audit row *is* the feature. One sweep per pass under `pg_try_advisory_xact_lock`, so a horizontally scaled API needs no leader election. Re-enabling goes through the existing enable route and arms **one** breaker probe rather than resetting health, because a reset releases the whole accumulated backlog at an endpoint whose recovery is still only the customer's assertion. Retention in `internal/retention/` uses two horizons — attempts carry the bytes and go at 60 days, the summary row that answers "what happened to this event?" survives to 90 — batched under `FOR UPDATE SKIP LOCKED` so a pass never queues behind live traffic. Scenario 20. |
| G18 | A comment in the router described wiring that no longer existed and told the reader a landed fix was still outstanding — the specific kind of staleness this document exists to remove. | Rewritten to describe what the code does, keeping the reasoning about why the outbox needs its own backoff schedule. |
| G15 | The worker borrowed `INGEST_DB_TIMEOUT_MS` for its own database deadline, so tuning ingest silently retuned delivery. | `WORKER_DB_TIMEOUT_MS`, validated against `DATABASE_STATEMENT_TIMEOUT_MS` so the server-side backstop cannot fire first and mask it. |
| G16 | A delivery refused by the org or project concurrency gate deferred with an unknown budget, so the wall-clock termination added for the breaker path did not apply there — the same never-terminating delivery, surviving on one path, and compounding with G13 because what keeps a delivery losing at that gate is a project saturated by slow endpoints. | A bounded consecutive-refusal tracker triggers one narrow budget read on the third refusal of the same delivery — no secrets join, no payload — so the common case still pays nothing. A failed read defers rather than terminating: a database blip must not end a delivery. |
| G17 | Endpoint delivery rate limits degraded to per-replica whenever `REDIS_URL` was unset, multiplying a customer's configured limit by the worker replica count, logged once at WARN and refused by nothing. | The **configuration** refuses it in production unless explicitly acknowledged, mirroring `EGRESS_ALLOW_PRIVATE_NETWORKS`. The runtime is untouched: delivery still never depends on Redis and still imports no client. |
| G19 | A claim could return every ready row regardless of its LIMIT. `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT $n)` is planned, under bloated-table statistics (high relpages, near-zero reltuples - what autovacuum leaves after a burst drains or a retention sweep empties the table), as a nested-loop semi join with the subquery re-executed per outer row; LockRows then skips rows the same UPDATE already modified, so each turn's LIMIT winner is the next tied row and every outer row matches. A fan-out batch always ties. Measured 5 of 5 for LIMIT 1, ten times in ten, and reproduced inside the failure suite at relpages=6 reltuples=0. It surfaced as one flaky test in thirteen runs. | Every SKIP LOCKED claim - FIFO, tenant-fair, outbox - fixes its batch in a `MATERIALIZED` CTE before the UPDATE joins to it, so the bound holds by construction; the retention sweeps' CTEs are materialized explicitly for the same reason. `TestScenario06` still logs `pg_class` statistics on its failure path. Scenarios 17 and 19. |
| G8 | A 429's `Retry-After` was ignored: an endpoint that asked for an hour was retried at 5s, 10s and 20s, spending three attempts inside the first 35 seconds of a window it had explicitly closed. | Honoured on 429 and 503, both RFC 9110 forms, clamped by a one-second floor, the policy's `MaxDelay`, and the remaining wall-clock budget. Scenario 12. |
| G9 | `queue_depth` and `egress_blocked_total` were declared and never written, so any dashboard built on them read a steady zero. | Both populated. `egress_blocked_total` is incremented at the two decision boundaries, labelled by a bounded code and never by customer-supplied text. `queue_depth` is refreshed every 15s by a collector on the scheduler role. Scenarios 14 and 20. |
| G10 | The worker's DB timeout was `INGEST_DB_TIMEOUT_MS` and it also capped the object-storage fetch, so any `PAYLOAD_DOWNLOAD_TIMEOUT_MS` above 5s was silently truncated. | The payload fetch has its own budget. The database half is still open as G15. |
| G11 | `router.DefaultOutboxBackoff` was dead in production; the outbox backed off on the *delivery* schedule, whose 1h cap against a 1h retry duration would park an accepted event after one or two retries. | `roles.go:96` passes `router.DefaultOutboxBackoff()`. The clamp in `router.New` stays as a guard rail. Stale comment about it is G18. |
| G12 | Three in-code comments described behaviour the code no longer had: the `deliveries_ready_idx` predicate, the `next_attempt_at` NULL write, and a dead `OUTBOX_BATCH_SIZE` knob. | All three corrected. `internal/queue/postgres.go:491-497` now says the coupling is gone; `schema.prisma:674-691` now says what actually blocks the NOT NULL migration (existing rows, not the Go side); `OUTBOX_BATCH_SIZE` is retired in favour of `ROUTER_MAX_OUTBOX_RETRY_DURATION_MS`. |

---

## 1. Ingest crashes before the DB commit

**What fails.** The ingest process dies — OOM kill, SIGKILL, node loss — between
receiving the request body and `COMMIT`. Or PostgreSQL rejects the transaction.

**As implemented.** The whole acceptance is one transaction:
`services/data-plane/internal/ingest/store.go:178-246`. The idempotency claim,
the `events` row and the `event_outbox` row are written inside it
(`:191-206`, `:231-236`, `:238-240`) and the commit is at `:242`. A deferred
rollback covers every non-committing path (`:183-187`). The 202 is written only
after `persist` returns (`internal/ingest/handler.go:152`), so a client that
does not see a 202 knows nothing was accepted.

The one thing that happens outside the transaction is the payload offload for
events at or above `PAYLOAD_INLINE_MAX_BYTES`. `PlanPayload` uploads to object
storage *before* `BEGIN` (`internal/ingest/handler.go:354`), with the reasoning
at `:341-353`: holding the ingest transaction open across an S3 round trip is
forbidden on this path. That leaves an object with no row pointing at it. Two
mechanisms close it:

- Compensating deletes on the paths where nothing was provably written —
  metadata encoding failure (`handler.go:364`) and a lost idempotency race
  (`handler.go:400`), both via `DisposeOrphan`
  (`internal/ingest/payload.go:146-163`).
- The sweep, for a crash between the PUT and the COMMIT:
  `cmd/webhookd/roles.go:417-447` reconciles bucket objects against `events`
  rows, hourly, only for objects older than 24h
  (`internal/config/config.go:246-249`), with the minimum age floored so it
  cannot race a request that is mid-flight (`config.go:348`).

Deliberately absent: a compensating delete after a `CreateEvent` **error**
(`handler.go:384-392`). That error is ambiguous — a timed-out COMMIT may still
have landed — and an `events` row whose payload object was deleted is
unrecoverable, while an orphaned object costs storage until the sweep. The
asymmetric mistake is taken on purpose.

**Guarantee.** Nothing is half-accepted. No 202 was issued, so by contract
nothing was promised. **Only time** — and only the client's.

**Blast radius.** One request, or the in-flight requests of one ingest pod.

**Gaps.** None. The orphan window is real but bounded and reconciled.

*Proven by* `TestScenario01_IngestCrashesBeforeCommit`
(`internal/failure/ingest_crash_test.go:150`).

---

## 2. Ingest crashes after the DB commit

**What fails.** The transaction commits, and the process dies before the 202
reaches the client. The client sees a connection reset and does not know whether
the event was accepted.

**As implemented.** The event and its outbox row are in the same transaction
(`internal/ingest/store.go:238-240`), so the router will fan it out whether or
not anyone got a 202: `claimOutboxSQL`
(`internal/router/store.go:190-210`) polls `event_outbox` on its own schedule and
knows nothing about HTTP. This is the whole point of the transactional outbox —
nothing is published anywhere before that COMMIT.

The client's retry is handled by idempotency. If it sent an `Idempotency-Key`,
the second request finds the committed claim
(`internal/ingest/handler.go:244-253`) and `Decide`
(`internal/ingest/idempotency.go:47-61`) returns `DecideReplay` — the **original**
event id comes back with a 202 and no second event is created. The claim SQL
(`internal/ingest/store.go:136-147`) serialises concurrent requests on the unique
`(project_id, key)` index, so even a client that retries before the first request
finished gets one event.

**Guarantee.** With an `Idempotency-Key`: exactly one event per key, and the
delivery proceeds regardless of the client's confusion. **Only time.**

Without one: the retry creates a **second event**, which fans out to the same
endpoints as a second set of deliveries. That is not a platform defect — it is
the documented consequence of omitting the header — but it is the most common
way a consumer sees an unexpected duplicate, and it is worth saying out loud in
support conversations before blaming the retry engine.

**Blast radius.** One request.

**Gaps.** None in the data plane. Note for operators: the idempotency window is
24h (`internal/ingest/idempotency.go:10`), and an expired key is reusable in
place (`store.go:124-147`), so a client retrying a day later gets a new event.

*Proven by* `TestScenario02_IngestCrashesAfterCommit`
(`internal/failure/ingest_crash_test.go:239`).

---

## 3. Worker crashes before delivery

**What fails.** A worker claims a batch of deliveries — moving them to
`processing` with a lease — and dies before making any HTTP request.

**As implemented.** The rows are stranded in `processing` with a `locked_until`
in the near future. Two paths bring them back, and the first is the important
one:

1. **The ordinary claim query.** `claimStatuses`
   (`internal/queue/postgres.go:34`) deliberately includes `'processing'`, and
   the `readyPredicate` (`:42-45`) decides claimability on
   `locked_until IS NULL OR locked_until < now()`, evaluated inside
   `FOR UPDATE SKIP LOCKED` (`:66-80`). A live lease is never stolen — its
   `locked_until` is in the future — but an expired one is ordinary ready work.
   The comment at `:18-33` explains why removing `'processing'` reintroduces
   data loss, and it is worth restating here because it is the single most
   fragile invariant in the queue:

   > A leased row is `processing`. If the claim predicate excludes that status,
   > an expired lease is never reclaimable by a worker, and the only path back is
   > the scheduler's `ReclaimExpired`. Deploy 8 workers and 1 scheduler
   > (ADR-0005), lose the scheduler, then OOM-kill a worker holding 100 leases,
   > and those 100 deliveries sit in `processing` forever: never retried, never
   > exhausted, never surfaced as failed.

   Both partial indexes list `processing` in their predicate
   (`apps/control-api/prisma/migrations/20260907000000_handoff_schema_requests/migration.sql:380`
   and `:388`), so this path is an index descent, not a sequential scan.

2. **The scheduler's sweep**, `ReclaimExpired`
   (`internal/queue/postgres.go:508-521`), run every second
   (`cmd/webhookd/roles.go:163-172`). It moves abandoned rows back to `pending`
   so they stop being `processing` outliers in operator queries, and it is what
   drives `queue_leases_reclaimed_total` (`postgres.go:514`) — the metric that
   tells you workers are dying mid-attempt.

Recovery time is bounded by `DELIVERY_LEASE_SECONDS` (120s by default,
`internal/config/config.go:260`), or ~1s if the scheduler is alive.

**Guarantee.** No delivery is lost. **Only time**, up to one lease.

**Blast radius.** The leases held by one worker pod — at most
`WORKER_CONCURRENCY` (64) plus whatever it had claimed but not started.

**Gaps.** None.

*Proven by* `TestScenario03_WorkerCrashesBeforeDelivery`
(`internal/failure/worker_crash_test.go:92`).

---

## 4. Worker crashes during delivery

**What fails.** The HTTP request is in flight when the process dies, or when
SIGTERM lands.

**As implemented.** Three mechanisms, in order of when they fire.

**Graceful shutdown is a drain, not a kill.** `Worker.Run`
(`internal/worker/worker.go:239-287`) hangs in-flight attempts off a context it
owns, derived with `context.WithoutCancel` (`:252`), so cancelling the run
context stops *claiming* immediately without killing work in flight. The lease
keeper runs on that same context (`:255-262`) — it must keep renewing during the
drain, or the leases of the deliveries being finished lapse underneath the
process and the next pod re-delivers them. `drain` (`:322-350`) waits up to
`DrainTimeout` (15s, `:22`) and only then cancels.

**Lease loss cancels the attempt.** `LeaseKeeper` (`internal/queue/lease.go:31`)
renews every `lease/3`. `Renew` returns the ids it did **not** extend
(`internal/queue/postgres.go:422-455` — the `RETURNING` clause is the whole
point; a row count cannot say *which* lease was lost), and `RenewOnce`
(`lease.go:131`) cancels each lost delivery's context with cause `ErrLeaseLost`
via `Abandon` (`lease.go:157-174`). The in-flight HTTP request aborts wherever it
is.

**Nothing is written after a lost lease.** `attempt` re-checks
`context.Cause` immediately before the request (`internal/worker/deliver.go:227-230`)
and again the instant it returns, before any write
(`deliver.go:254-265`). The second check is labelled *the* crash-safety check and
it is: writing an attempt row here is how one webhook ends up with two terminal
statuses decided by whichever process committed last.

**Our own shutdown is not the endpoint's failure.** This is the G5 fix and it has
three parts, all of which matter:

- The drain cancels with an explicit cause, `ErrWorkerShutdown`
  (`worker.go:252-253`, `:325`, `:348`; the reasoning at `:246-251`). A bare
  `context.Canceled` is classified as a retryable transport fault, which is what
  used to write `context canceled` into the customer's ledger.
- Before the request, a shutdown cause defers the delivery unattempted
  (`deliver.go:234-238`) — the request would be cancelled the moment it started,
  and sending it anyway costs the endpoint a duplicate.
- After the request, a shutdown cause defers **only if the request actually
  failed** (`deliver.go:276-282`). A response that arrived before the
  cancellation landed is a real outcome and is recorded as one; throwing it away
  would guarantee the duplicate that deferring only risks.

A deferral on this path writes no attempt row and charges no budget
(`deliver.go:553-596`), and `deferDelivery` renames the reason to
`worker_shutdown` whatever the proximate cause was (`deliver.go:564-567`), so
`last_error` does not send an operator looking for an object-storage outage that
was really our restart.

**The race that came with it.** `LeaseKeeper.Run` used to cancel its tracked
attempts with a hard-coded `context.Canceled` as it unwound. The worker passes
the keeper the same context it uses as the parent of every tracked attempt, so on
shutdown two goroutines raced to cancel the same children —
`context.CancelCauseFunc` is first-writer-wins, so the keeper won a fraction of
those races and the delivery was charged after all. `Run` now inherits the
cause from its context (`internal/queue/lease.go:94-117`), so both racers set the
same one and the winner stops mattering.

If the process is SIGKILLed instead, none of this runs and scenario 3's lease
expiry applies — with the endpoint possibly having received the request.

**Guarantee.** **Only time** for the ledger, and no budget spent on our restart;
the customer may still see a duplicate if the request had already gone out.
At-least-once.

**Blast radius.** One delivery per in-flight attempt.

**Gaps.** None.

*Proven by* `TestScenario04_WorkerCrashesDuringDelivery`
(`internal/failure/worker_crash_test.go:191`),
`TestShutdownCancelledAttemptIsNotChargedToTheEndpoint`
(`internal/worker/defer_test.go:287`),
`TestDrainCancelsWithTheShutdownCause` (`defer_test.go:348`),
`TestKeeperInheritsTheParentCancellationCause`
(`internal/queue/lease_test.go:221`) and
`TestKeeperCancelsTrackedAttemptsWithoutAnInheritedCause` (`lease_test.go:265`).

---

## 5. Worker crashes after the HTTP response, before the DB update

**What fails.** The endpoint has received and acted on the webhook. The process
dies before `delivery_attempts` and the status transition are written.

**As implemented.** This is the window the platform explicitly refuses to close,
and the design leans into it in both directions.

Against *losing* the record: `finish`
(`internal/worker/deliver.go:435-464`) runs its write on a context detached from
cancellation (`context.WithoutCancel`) with its own timeout. A SIGTERM arriving
between the HTTP response and this write does not lose the attempt record — the
endpoint has already received the webhook, and a delivery whose ledger does not
say so is one an operator cannot answer questions about.

Against *corrupting* the record: the write is still guarded. `advanceSQL`
(`internal/worker/store.go:326-370`) carries `AND locked_by = $2`, and the
attempt insert shares the transaction (`Complete`, `:381-405`). If the lease
lapsed and another worker took the row, the UPDATE matches nothing, the whole
transaction rolls back including the attempt row, and the caller logs that the
delivery was reclaimed before its result could be recorded
(`deliver.go:453-458`).

If the process is killed outright, neither runs. The lease expires, the delivery
is reclaimed (scenario 3), and it is **delivered again**.

**Guarantee.** **Only time** for platform state. For the customer: a duplicate
delivery. At-least-once, exactly as advertised — this is the canonical case, and
it is why `Webhook-Delivery-Id` exists and why consumers must be idempotent.

**Blast radius.** One delivery.

**Gaps.** None. This is a designed trade, not an omission.

*Proven by* `TestScenario05_WorkerCrashesAfterResponseBeforeWrite`
(`internal/failure/worker_crash_test.go:301`).

---

## 6. Scheduler crashes

**What fails.** The single scheduler replica
(`deployments/kubernetes/32-scheduler.yaml:18` — `replicas: 1`) is gone. Nothing
is running `ReclaimExpired`, nothing is running the orphan payload sweep, and
nothing is refreshing `queue_depth`.

**As implemented.** The scheduler owns recovery, not timing, and the comment at
`cmd/webhookd/roles.go:155-162` says so. `Claim` already treats a due delivery —
including one whose lease has expired — as ready (scenario 3), so losing this
role costs efficiency and operator clarity, not deliveries. What it buys is
putting abandoned rows back inside the ready-set predicate promptly, and telling
an operator via `queue_leases_reclaimed_total` that workers are dying
mid-attempt.

Two other jobs ride the same role:

- The orphan payload sweep (`roles.go:135`, `:417-447`). Losing it costs
  object-storage spend, nothing else.
- **The `queue_depth` collector** (`roles.go:152-154`), which is new since the
  first draft of this document. It rides here because it is a pure reader — no
  lease, no claim, no write — and because its numbers are fleet-wide rather than
  per-replica. Note the operational consequence: **with the scheduler down,
  `queue_depth` goes stale, not zero.** Prometheus keeps the last scraped value,
  so a dashboard reading it during a scheduler outage shows the backlog as it
  was when the scheduler died. Check `up` for the scheduler before believing the
  gauge. This is the one instrument that can see the failure modes producing no
  attempt at all (a breaker or rate-limit deferral moves no counter), which is
  exactly why its staleness matters.

**Guarantee.** **Only time**, and very little of it. Nothing in the delivery path
depends on this role being alive.

**Blast radius.** Fleet-wide, but latency-only: reclaimed rows wait for a worker
poll rather than the sweep. Plus one stale gauge.

**Gaps.** None. The stale comment that used to be listed here (old G12) is
corrected — `internal/queue/postgres.go:491-497` now says outright that both
ready indexes include `processing`, that the indexed claim path finds an expired
lease cheaply, and that this sweep is therefore a convenience rather than the
only efficient route back into the ready set. A dead scheduler is not a delivery
incident.

*Proven by* `TestScenario06_SchedulerCrashes`
(`internal/failure/scheduler_crash_test.go:56`), and for the collector,
`TestSchedulerStartsTheQueueDepthCollector` (`cmd/webhookd/roles_test.go:143`).

---

## 7. Redis becomes unavailable

**What fails.** Redis is gone, black-holed, or slow.

**As implemented.** Redis is never the queue and never authoritative. The queue
is PostgreSQL (`internal/queue/queue.go:1-10`, ADR-0003); the circuit breaker
lives in `endpoint_health` in PostgreSQL
(`internal/worker/breaker.go:189-196`). Redis now hosts **two** sets of token
buckets — the fleet-wide ingest buckets and, since the G6 fix, the fleet-wide
endpoint delivery buckets — and both paths are built to degrade:

- Every Redis call is bounded at `REDIS_TIMEOUT_MS` — 50ms by default
  (`internal/config/config.go:216`) — applied to dial, read, write **and** pool
  wait (`internal/ratelimit/redis.go:93-108`). Waiting for a pooled connection is
  itself a stall.
- A fault is a **limiter fault, not a refusal**
  (`internal/ratelimit/limiter.go:146-184`): on error the call falls through to
  the in-process bucket. `RateLimiter.Allow`'s interface contract says so in as
  many words (`internal/worker/ratelimit.go:20-23`): an implementation that
  cannot reach its store and therefore refuses everything has converted a Redis
  blip into a platform-wide delivery outage.
- After `DegradeAfter` consecutive faults (5) the limiter stops calling Redis for
  `DegradeCooldown` (5s) — `limiter.go:46-50`, `:226` — so a black-holed Redis
  does not add 50ms to every request for the length of the outage.
- The ingest handler treats a limiter error as fail-open explicitly
  (`internal/ingest/handler.go:224-236`).
- The delivery limiter never learns Redis exists: the go-redis dependency lives
  in `internal/ratelimit` and reaches the worker only through the
  `worker.RateLimiter` interface (`cmd/webhookd/roles.go:290-311`, `:304-311`). The outage
  suite asserts structurally that the durable path imports no Redis client.
- The pre-auth ceiling is deliberately **not** on Redis
  (`internal/ingest/source.go:12-34`): a DoS defence that evaporates on a cache
  outage is not one.

Failure is visible: `rate_limiter_degraded_total`
(`internal/metrics/metrics.go:80`), incremented at `limiter.go:156` and `:226`,
with the log throttled to one line per 10s (`limiter.go:239-258`) so a Redis
outage does not become a log-volume incident on top of itself.

**Guarantee.** No accepted event is affected, and no delivery is refused.
**Only time — none at all, actually**: the cost is accuracy. Limits become
per-replica, so a limit of N is enforced as N x the number of pods.

**Blast radius.** Rate-limit precision, platform-wide. No delivery impact.

**Gaps.** G17 — with `REDIS_URL` unset entirely, the delivery limiter is
per-replica permanently rather than during an outage, and nothing refuses that
configuration.

*Proven by* `TestScenario07_RedisUnavailable_IngestFailsOpenAndStillCommits`
(`internal/failure/outage/redis_test.go:89`),
`TestScenario07_RedisUnavailable_DegradesToPerReplicaCeilings` (`:138`),
`TestScenario07_RedisUnavailable_DeliveryPathDoesNotDependOnIt` (`:203`) and
`TestScenario07_RedisRecovers_BucketsBecomeFleetWideAgain` (`:273`).

---

## 8. PostgreSQL becomes unavailable

**What fails.** The database is down, failing over, or unreachable. This is the
one that hurts: PostgreSQL is the source of truth, the queue, and the ledger.

**As implemented, by role.**

**Boot no longer exits.** This is the G4 fix and it is the biggest change in this
scenario. `run()` binds the probe server **before** opening the pool
(`cmd/webhookd/main.go:74-100`, with the ordering argument at `:68-73`: opening
the pool first meant a PostgreSQL outage exited the process before `:9090` ever
bound, so every pod crash-looped and recovery waited on kubelet's backoff instead
of on the database — and a `startupProbe` cannot rescue a process that has
already exited). The pool is then opened with `db.OpenWithRetry`
(`main.go:109-124`, implementation at `internal/db/db.go:84-152`), which retries
with backoff from 250ms to a 10s ceiling, logs each wait, and ends when the
context does so a SIGTERM mid-wait still exits promptly. A malformed
`DATABASE_URL` is deliberately **not** retried (`db.go:96-98`, `:110-113`):
from the outside, waiting out a configuration error looks identical to waiting
out an outage, and those need telling apart.

Readiness now distinguishes the two states an operator confuses
(`internal/httpx/health.go:51-58`): `starting` before the pod has ever been
ready, `draining` after. The health check reports `postgres: connecting` while
the pool is nil, which is a different operator story from one that opened and
then failed (`main.go:76-89`). Every role carries a `startupProbe` on
`/health/live` — in the chart
(`deployments/helm/hookubit/templates/data-plane.yaml:110-114`, on by
default, with `values.schema.json` entries) and in the raw manifests
(`deployments/kubernetes/30-ingest.yaml:86`, `31-router.yaml:71`,
`32-scheduler.yaml:74`, `33-worker.yaml:83`).

**Ingest** refuses new work honestly. Every database call on the accept path
inherits a `DBTimeout` deadline (5s, `internal/ingest/handler.go:26-36`,
`:158-163`) — the request context alone is not one, because
`http.Server.WriteTimeout` does not cancel `r.Context()`. `CreateEvent` failing
returns a 500 (`handler.go:382-393`); no 202 is issued, so the client knows to
retry. An offloaded payload object is deliberately leaked rather than deleted
(`handler.go:384-392`) because the COMMIT may have landed. Readiness starts
failing and Kubernetes takes the pod out of the Service.

**Router** logs and retries on the next tick — the outbox is durable, so falling
behind costs time, not data. A row whose fan-out transaction fails is released
with backoff (`internal/router/router.go:430-455`); if the release write itself
fails, the row stays leased and comes back when the lease lapses (`:451-454`).

**Worker** logs a failed claim and returns; the poll ticker retries. A failed
lease renewal is explicitly **not** treated as a lost lease
(`internal/queue/lease.go:143-151`): we do not know either way, the lease has not
expired yet, so attempts keep running. If the database really is gone, the lease
lapses on its own and the next successful round returns them as lost.

**Both planes** have a server-side backstop: `SET statement_timeout` is applied
to every pooled connection (`internal/db/db.go:189-197`), 30s by default
(`internal/config/config.go:213`), so a lock wait or a failed-over replica cannot
hold a connection for as long as PostgreSQL is willing to wait. Config refuses a
`statement_timeout` below the ingest deadline (`internal/config/config.go:365-368`),
so the backstop cannot fire first and mask the request deadline.

**A degraded window no longer parks accepted events.** This is the other half of
the G1 fix and it belongs here rather than in the gaps list, because it is the
recovery strategy. The old chain was: the router claims an outbox row and the
claim increments `attempts`; the fan-out then fails on `Acquire` or
`statement_timeout`; repeat past `ROUTER_MAX_OUTBOX_ATTEMPTS` and the row is
parked, permanently, with no API able to reach it. A twenty-minute brownout could
burn all ten attempts on rows whose fan-out was never even tried.

The claim now increments **two** counters (`internal/router/store.go:190-210`,
reasoning at `:165-189`). `attempts` is monotonic and is what an operator reads.
`unaccounted_attempts` is the poison bound, and **every write the lease holder
commits gives one back** — a recorded release
(`store.go:800-803`), a fan-out batch that made progress (`store.go:496-503`), a
completed fan-out (`store.go:450-459`). What survives is exactly "claims that
ended with the router writing nothing at all": a crash, an OOM, a lease left to
lapse. That is the poison signal, and it is the only thing the count-based bound
now fires on (`router.go:288-306`).

Recorded transient failure is bounded by **time** instead: `failing_since` is set
by the first recorded failure and cleared by any progress
(`store.go:770-803`), and the router parks when it exceeds
`ROUTER_MAX_OUTBOX_RETRY_DURATION_MS` (one hour by default,
`internal/config/config.go:272`, `internal/router/router.go:311-326`). No count
can tell "the database was unavailable for twenty minutes" from "this row always
errors". The clock can.

**Guarantee.** Nothing that returned 202 is lost. Accepted events sit in
`event_outbox`; created deliveries sit in `deliveries`; both drain when the
database returns. Pods stay up and become ready when the database does.
**Only time.**

**Blast radius.** Everyone. This is the single point of failure, deliberately
(ADR-0003).

**Gaps.** None. If an event *is* parked — a genuinely poisonous row, or an outage
longer than an hour — it is recoverable through the API; see scenario 18 and
Appendix A.

*Proven by* `TestScenario08_PostgresUnavailable_NeverReturnsAFalseAccept`
(`internal/failure/outage/postgres_test.go:30`),
`TestScenario08_PostgresUnavailable_LeavesNoPartialWrite` (`:135`),
`TestOpenWithRetryWaitsForAnUnreachableDatabase`
(`internal/db/retry_test.go:40`),
`TestOpenWithRetryDoesNotRetryAMalformedURL` (`:83`),
`TestReadinessSeparatesStartupFromShutdown`
(`internal/httpx/health_lifecycle_test.go:33`),
`TestRunOnceDoesNotParkARowWhoseFailuresWereAllRecorded`
(`internal/router/router_test.go:193`) and
`TestPostgresARecordedReleaseRefundsTheClaimAndStartsTheClock`
(`internal/router/store_postgres_test.go:1107`).

---

## 9. Queue becomes unavailable

**What fails.** Nothing separate. The queue *is* the `deliveries` table, claimed
with `FOR UPDATE SKIP LOCKED` (`internal/queue/postgres.go:59-80`), and the
outbox *is* the `event_outbox` table (`internal/router/store.go:190-210`).

**As implemented.** ADR-0003, restated at `internal/queue/postgres.go:167-174`:
the delivery row must be written before any attempt is made regardless — that is
what makes replay possible — so a separate queue would be a second copy of state
we already have, and a second thing to reconcile after a crash. There is no
independent queue outage mode. See scenario 8.

The seam for a future Redis/SQS/Kafka/NATS queue exists
(`internal/queue/queue.go:60-89`), and the constraint on it is stated in that
file's package comment: such an implementation may sit in front of the durable
rows as a latency optimisation, never as the record itself.

**Guarantee.** Identical to scenario 8. **Only time.**

**Blast radius.** Everyone.

**Gaps.** None. Worth stating explicitly in a post-mortem: "the queue was down"
is never a separate finding here.

*Proven by* `TestScenario09_QueueUnavailable_ReportsTheOutageAndLosesNothing`
(`internal/failure/outage/queue_test.go:37`).

---

## 10. Customer endpoint times out

**What fails.** The endpoint accepts the connection and never answers, or answers
after minutes.

**As implemented.** Every phase of an outbound request is bounded
(`internal/egress/client.go:55-67`): connect 3s, TLS handshake 3s, response
header 10s, total 30s, **and resolution 2s in its own right**. The total is
applied twice — as the client's `Timeout` (`client.go:146`) and as a context
deadline inside `Do` (`client.go:199`) — and the response body read is bounded at
`MaxResponseBytes`, with the remainder drained boundedly so the connection can be
reused.

`endpoints.timeout_ms` can only **shorten** an attempt
(`internal/worker/deliver.go:240-249`). Letting a customer's column extend the
platform ceiling would hand any endpoint the ability to hold a worker slot for as
long as it liked.

A timeout is classified `AttemptTimeout`
(`internal/worker/state.go:277-296`) with error code `timeout`
(`state.go:320-361`), is retryable (`internal/retry/retry.go:107-119`), and
counts against the circuit breaker (`deliver.go:406-433`).

**Resolution is bounded separately, and this is the G7 fix.**
`EGRESS_DNS_TIMEOUT_MS` used to be read, passed, stored and applied by nothing.
`net.Dialer` has no DNS timeout — its single `Timeout` covers resolution *and*
the TCP connect — so a resolver that was slow rather than absent consumed the
whole connect budget and held a worker slot for it.
`boundedDialer` (`internal/egress/dial.go:45-57`, wired at
`internal/egress/client.go:101-106`) now resolves under its own deadline and then
dials each address as a literal through the same `*net.Dialer`.

The subtlety worth knowing at 2am: the connect budget is divided across the
addresses still to try (`dial.go:112-131`, `partialDeadline` at `:196`, mirroring
`net/dial.go`). Sharing one deadline across a serial loop is what `net.Dialer`
deliberately does not do — a name whose first address black-holes packets (a
stale A record, or a filtered IPv6 path on a dual-stack node, and `LookupNetIP`
applies RFC 6724 so a global v6 address sorts first) would otherwise spend the
entire budget on address #1 and dial #2 on an already-expired context. The
endpoint is reachable and every delivery to it times out.

Critically, a slow endpoint cannot starve the pool *by holding worker slots*. The
worker claims only as many rows as it has free slots
(`internal/worker/worker.go:289-299`), and every ceiling is a **non-blocking**
acquire whose refusal defers the delivery (`internal/worker/gate.go:5-19`).
Blocking on a full endpoint semaphore would park goroutines in front of the slow
endpoint — the starvation this design exists to prevent, reintroduced one channel
receive at a time.

**Guarantee.** **Only time.** The delivery is retried under its policy until the
attempt or duration budget is spent.

**Blast radius.** One endpoint, in the sense that its own concurrency is capped
at `MAX_CONCURRENCY_PER_ENDPOINT` (16, `internal/config/config.go:290`) or its
own `max_concurrency`, whichever is lower (`internal/worker/gate.go:91-101`).
**But read G13 before you believe that is isolation.** The cap bounds one
endpoint; it reserves nothing for anyone else, and the sum of several slow
endpoints' caps can exceed the whole pool.

**Gaps.** G13 — cross-referenced here because the blast-radius claim above
depends on it. The defect itself belongs to scenario 19.

*Proven by* `TestScenario10_CustomerEndpointTimesOut`
(`internal/failure/endpoint_failure_test.go:54`),
`TestDNSTimeoutBoundsResolutionIndependentlyOfConnectTimeout`
(`internal/egress/dial_test.go:107`),
`TestABlackHoledAddressDoesNotStarveTheNextOne` (`dial_test.go:361`) and
`TestPartialDeadlineDividesTheRemainingBudget` (`dial_test.go:430`).

---

## 11. Customer endpoint returns 500

**What fails.** The endpoint is up and answering, badly.

**As implemented.** 5xx is retryable (`internal/retry/retry.go:107-119`).
`Decide` (`internal/worker/state.go:144-196`) records the attempt as
`AttemptFailure` — the endpoint answered and we disliked the answer — schedules
the next attempt with exponential backoff and symmetric jitter
(`retry/retry.go:41-80`), and stops when either budget is spent:
`MaxAttempts` or `MaxRetryDuration` (`retry/retry.go:156-164`). The reason names
*which* budget ran out (`state.go:169-181`), because that is the difference
between an operator raising `max_attempts` and raising `max_retry_duration`.

The budget frozen onto the delivery row wins over the endpoint's current policy
(`internal/worker/store.go:299-306`): editing a retry policy mid-flight cannot
extend or truncate deliveries already in progress. The policy is resolved the
same way the router resolves `max_attempts` — endpoint policy, then project
default, then the built-in (`store.go:196-205`); joining only on
`e.retry_policy_id` once skipped the project default entirely, so an operator got
its `max_attempts` honoured by the router and its backoff ignored here.

5xx counts against the circuit breaker (`deliver.go:406-433`) — and note what
does not: a 400 or 403 means the endpoint is up and answering, so opening the
breaker on it would remove delivery pressure from a perfectly healthy endpoint
that simply dislikes one payload. Only transport errors, timeouts, 408, 429 and
5xx count.

Backoff overflow is guarded (`retry/retry.go:61-73`): the clamp is unconditional
and runs before the conversion to `time.Duration`. The regression it prevents is
documented in place — a policy with `MaxDelay` unset overflowed `int64` at high
attempt numbers, producing a `next_attempt_at` permanently in the past and a poll
loop hammering a dead endpoint every 250ms.

**Guarantee.** **Only time**, until the budget is spent; then the delivery is
`exhausted` with a reason, permanently visible in the ledger and replayable by an
operator.

**Blast radius.** One endpoint.

**Gaps.** None.

*Proven by* `TestScenario11_CustomerEndpointReturns500`
(`internal/failure/endpoint_failure_test.go:120`).

---

## 12. Customer endpoint returns 429

**What fails.** The endpoint is rate-limiting us.

**As implemented.** 429 is retryable (`internal/retry/retry.go:112`) and counts
as a breaker failure, so five consecutive 429s open the breaker
(`BREAKER_FAILURE_THRESHOLD`, `internal/config/config.go:274`) and remove
delivery pressure for a cooldown that doubles from 30s to a 10-minute ceiling
(`internal/worker/breaker.go:103-127`).

**`Retry-After` is honoured.** This is the G8 fix. The header is parsed off the
response in both RFC 9110 forms — delay-seconds and HTTP-date —
(`internal/worker/deliver.go:292-293`, parser at
`internal/worker/state.go:243-275`) and, on a 429 or a 503, replaces the policy's
computed backoff (`state.go:186-193`). 429 and 503 are the two statuses RFC 9110
defines it for as a request to wait, and the two this platform retries
(`state.go:198-207`); a `Retry-After` on a 3xx means how long the redirect is
valid, which is a different thing.

It is advisory input, never a command. `clampRetryAfter`
(`state.go:209-241`) bounds it three ways, each for a failure that is real:

- a **one-second floor**, because `Retry-After: 0` from a misbehaving endpoint
  would schedule the next attempt at `now()` and turn the claim loop into a hot
  loop against an endpoint that is already refusing us;
- the policy's **`MaxDelay`**, because `Retry-After: 999999999` (~31 years) from
  a hostile or broken endpoint would park the delivery past any horizon an
  operator can see, in a state that still reads as `retrying`;
- the **remaining wall-clock budget**, because scheduling an attempt after
  `first_attempt_at + max_retry_duration` schedules an attempt guaranteed to be
  judged exhausted the moment it runs. Landing on the boundary makes that
  judgement happen at the right time instead of a `Retry-After` later.

Which schedule produced the wait is recorded — `retry_after_honoured` on the log
line (`deliver.go:483`) — because an operator staring at an unexpected
`retry_in` needs to tell an endpoint's request apart from a broken backoff
calculation.

Separately, an endpoint may carry its own configured rate limit
(`endpoints.rate_limit`), checked before the attempt
(`deliver.go:113-128`); a refusal defers without recording an attempt or
charging the retry budget. Since the G6 fix that bucket is fleet-wide when
`REDIS_URL` is set (`cmd/webhookd/roles.go:313-343`).

Note the ordering, which is load-bearing: the rate-limit check sits **before**
`breaker.Allow`, not after (`deliver.go:110-128`, reasoning at `:112-122`).
`breaker.Allow` *claims* the half-open probe slot, so a recovering endpoint that
also had `rate_limit` set could have its one probe consumed by a delivery that
then deferred at the limiter and never reached the network — delaying recovery by
a whole `HalfOpenTTL` each time, indefinitely if the bucket stayed saturated.
Nothing that can defer may sit between claiming the probe and making the request.

**Guarantee.** **Only time.** No delivery is lost to a 429, and an endpoint that
asks for an hour gets an hour rather than three attempts in the first 35 seconds.

**Blast radius.** One endpoint.

**Gaps.** None. G17 applies to the *configured* endpoint limit without Redis, not
to `Retry-After`.

*Proven by* `TestScenario12_CustomerEndpointReturns429`
(`internal/failure/endpoint_failure_test.go:215`),
`TestScenario12_AbsurdRetryAfterIsClamped` (`:288`),
`TestEndpointRetryAfterSchedulesTheNextAttempt`
(`internal/worker/defer_test.go:389`),
`TestAbsurdRetryAfterIsClampedOnTheDeliveryPath` (`defer_test.go:423`) and
`TestRateLimitDoesNotSpendTheHalfOpenProbe` (`defer_test.go:194`).

---

## 13. DNS resolution fails

**What fails.** The endpoint's hostname does not resolve — NXDOMAIN, a dead
resolver, or an expired zone.

**As implemented.** The lookup fails with a `*net.DNSError`, which `ErrorCode`
maps to the low-cardinality code `dns` (`internal/worker/state.go:299-318`).
Classification is by error **type**, never by message — transport error strings
are not part of any API and a classifier that matches on them rots silently.

The bounded dialer returns that error **deliberately unwrapped**
(`internal/egress/dial.go:77-85`): it is a `*net.DNSError` including when the
new DNS deadline is what ended the lookup, in which case `IsTimeout` is set, and
wrapping it there would reclassify every failed lookup in the platform.

DNS failure is retried. `IsRetryableNetworkError`
(`internal/retry/retry.go:134-154`) is deliberately a deny-list of known-permanent
failures with a retry default: an unrecognised transport error is far more likely
to be a transient network fault than a permanent one, and giving up on a delivery
we could have made is the worse of the two mistakes. That function carries a
scar — it previously contained a dead branch that retried *everything*, including
malformed URLs and self-signed certificates, for a full day
(`retry.go:131-133`).

Permanent TLS failures are excluded (`internal/retry/errors.go:46-66`):
`UnknownAuthorityError` and `HostnameError` need a human. Certificate **expiry**
is deliberately still retried — that one heals when the endpoint's operator
renews.

**Guarantee.** **Only time**, until the retry budget is spent. A domain that
stays dead for 24h ends as `exhausted` with error code `dns` on every attempt row.

**Blast radius.** One endpoint. A resolver outage affecting *every* endpoint
degrades the whole delivery path, but nothing is lost — the deliveries retry, and
each now costs at most `EGRESS_DNS_TIMEOUT_MS` rather than the full connect
budget.

**Gaps.** None.

*Proven by* `TestScenario13_DNSResolutionFails_IsRecordedAndRetried`
(`internal/failure/outage/dns_test.go:71`).

---

## 14. DNS resolves to a private IP

**What fails.** A customer registers `https://internal.example.com/hook`, whose
public DNS resolves to `10.0.0.5` — or to `169.254.169.254`.

**As implemented.** `CheckURL` (`internal/egress/ssrf.go:133-172`) is a cheap
first filter that judges literal IPs immediately and deliberately does **not**
try to judge a hostname. `CheckIP` (`ssrf.go:175-266`) is the authoritative check
and it runs at dial time, per resolved address, installed as
`net.Dialer.Control` (`ssrf.go:268-290`, wired at `internal/egress/client.go:93`).
The runtime calls it once per resolved address, after resolution and immediately
before connect.

What it refuses, in order:

1. Cloud instance metadata — 169.254.169.254, `fd00:ec2::254`, 100.100.100.200
   (`ssrf.go:95-99`, checked at `:186-194`) — **before** the allowlist, so an
   operator who allowlists `169.254.0.0/16` for an internal service does not
   thereby open IMDS.
2. IPv6 transition addresses that embed an IPv4 destination — 6to4 and NAT64
   (`ssrf.go:292-300`), because `http://[64:ff9b::a9fe:a9fe]/` is a request to
   169.254.169.254 wearing a disguise.
3. The operator allowlist (`ssrf.go:209-213`), which `NewGuard` refuses to load a
   default route into (`ssrf.go:123-127`) — a default route is not an allowlist,
   it is the absence of one written to look deliberate.
4. Unspecified, loopback, link-local, multicast, RFC1918/RFC4193
   (`ssrf.go:218-231`), then CGNAT 100.64/10, 192.0.0.0/24, the documentation
   ranges, 198.18/15, 240/4 (`ssrf.go:232-248`) and the IPv6-only special ranges
   (`ssrf.go:249-263`).

`controlConn` also refuses any network that is not `tcp`/`tcp4`/`tcp6`
(`ssrf.go:279-284`).

`EGRESS_ALLOW_PRIVATE_NETWORKS=true` is refused outright in production
(`internal/config/config.go:333-335`), which steers operators onto the allowlist.

A refusal is a `BlockedTargetError` marked permanently non-retryable
(`ssrf.go:20-32`, matched at `internal/retry/errors.go:16-22`), so `Decide`
takes it to `StateFailed` with reason `blocked_target`
(`internal/worker/state.go:156-167`) on the first attempt. It does **not** count
against the endpoint's circuit breaker (`internal/worker/deliver.go:406-420`):
our own egress policy refusing to dial says nothing about the endpoint's health.

**Refusals are now counted.** This is the G9 fix. `recordBlocked`
(`internal/egress/ssrf.go:69-91`) increments `egress_blocked_total`, labelled by
`Code` and **never** by `Reason` — `Reason` interpolates the thing that was
refused, a URL scheme a customer typed or a resolved IP address, and a label
whose values come from customer input is an unbounded label: one tenant
registering endpoints with a few thousand distinct schemes would create a few
thousand time series and take the metrics backend down with them. The code set is
fixed and enumerated at `ssrf.go:34-58`. It is called at the two decision
boundaries, `CheckURL` and `controlConn`, and **not** inside `CheckIP`, because
`CheckIP` recurses through itself for transition addresses and counting there
would report one refusal as two.

**Guarantee.** The request is never made. The delivery fails immediately and
permanently, with a reason an operator can read and a counter an operator can
alert on. **Nothing is lost that should have been delivered** — the platform
refused on purpose.

**Blast radius.** One endpoint.

**Gaps.** None.

*Proven by* `TestScenario14_DNSResolvesToPrivateIP_NothingIsDialled`
(`internal/failure/outage/dns_test.go:239`),
`TestBlockedRefusalsAreCountedUnderABoundedLabel`
(`internal/egress/dial_test.go:224`) and
`TestATransitionRefusalIsCountedOnce` (`dial_test.go:264`).

---

## 15. Endpoint redirects to a private IP

**What fails.** The endpoint answers `302 Location: http://169.254.169.254/`.
This is the whole attack: the registered URL is public and passes every
registration-time check, and the redirect is where it goes.

**As implemented.** Redirects are **not followed at all** by default:
`EGRESS_MAX_REDIRECTS` is 0 (`internal/config/config.go:298`) and `CheckRedirect`
refuses anything past that bound (`internal/egress/client.go:147-158`). When an
operator raises it, every redirect destination is re-validated through
`guard.CheckURL` — and, for a hostname destination, the dial-time `Control` check
(scenario 14) still runs on the address the new connection actually uses. There
are two independent gates, not one.

The refusal is the same permanent `BlockedTargetError`, so the delivery fails on
the first attempt without burning a retry budget, and it is counted on
`egress_blocked_total` under the `redirect` code (`ssrf.go:54`).

**Guarantee.** No request is made to the redirect target. Permanent failure with
reason `blocked_target`.

**Blast radius.** One endpoint.

**Gaps.** None.

*Proven by* `TestScenario15_RedirectToPrivateIP_IsNotFollowedUnderShippedDefaults`
(`internal/failure/outage/dns_test.go:295`).

---

## 16. DNS changes after initial validation (rebinding)

**What fails.** A hostname resolves to a public address when the endpoint is
registered or when `CheckURL` runs, and to `127.0.0.1` a few milliseconds later
when the connection is actually made. Time-of-check/time-of-use.

**As implemented.** There is no check-then-use window, because the authoritative
check *is* the use. `controlConn` (`internal/egress/ssrf.go:268-277`) is
installed as `net.Dialer.Control` (`internal/egress/client.go:93`); the Go
runtime calls it once per resolved address, after resolution and immediately
before `connect(2)`. The comment at `ssrf.go:268-270` states the property
directly.

**The bounded dialer did not weaken this, and that was the design constraint.**
`boundedDialer` resolves the name itself and then dials each address as a
literal *through the same `*net.Dialer`* — so `Control` still runs, still runs
per address, and still judges the exact address the socket is about to open to.
The package comment is explicit that nothing there inspects, filters or caches an
address (`internal/egress/dial.go:31-44`): deciding in the dialer which addresses
look acceptable would be a second, weaker copy of `ssrf.go`'s policy, and the
moment there are two the question of which is authoritative has a wrong answer.

A multi-address name is checked per address, so a hostname returning one public
and one private A record is refused on the private one rather than admitted on
the public one; the dialer keeps going after a `BlockedTargetError` because a
refusal is a verdict on *one* address (`dial.go:133-141`).

Connection reuse does not reopen the hole. Pooled keep-alive connections skip the
dialer, but they are connections to an address that already passed the check; a
rebind cannot retarget an established socket.

**Guarantee.** No connection is ever made to an address that has not been checked
at dial time. **Nothing is lost.**

**Blast radius.** One endpoint.

**Gaps.** None.

*Proven by* `TestScenario16_DNSRebinding_TheDialledAddressIsTheJudgedOne`
(`internal/failure/outage/dns_test.go:354`) — a resolver that answers public on
the first lookup and private on the second — and
`TestBoundedResolutionStillJudgesEveryResolvedAddress`
(`internal/egress/dial_test.go:159`), which is the regression guard on the
sentence above.

---

## 17. Two workers attempt the same delivery

**What fails.** Worker A's lease lapses under a slow attempt — a database
failover ate a renewal round — the row is reclaimed, worker B claims and delivers
it, and A's request finally returns.

**As implemented.** Four layers, and each closes a different half of the problem.

**Claim exclusivity.** `FOR UPDATE SKIP LOCKED`
(`internal/queue/postgres.go:66-80`, and inside the LATERAL for the tenant-fair
strategy at `:89-113`) means two workers polling concurrently never receive the
same row, and a live lease is never stolen because `locked_until` is in the
future.

**Detection.** `Renew` returns the ids it did *not* extend
(`internal/queue/postgres.go:422-455`). The `RETURNING` clause is the point: a row
count alone cannot say *which* lease was lost, and the caller needs the id to
cancel that specific attempt.

**Reaction.** `LeaseKeeper.Abandon`
(`internal/queue/lease.go:157-174`) cancels the attempt's context with cause
`ErrLeaseLost`, aborting the HTTP request wherever it is. The scenario in the
type's doc comment (`lease.go:12-30`) is exactly this one.

**The backstop, for when detection fails.** If A's renewals are erroring rather
than reporting loss — the database is unreachable, so `RenewOnce` logs and
returns without cancelling (`lease.go:143-151`) — A's HTTP request completes and
A believes it still holds the lease. The write is still refused:
`advanceSQL` carries `AND locked_by = $2`
(`internal/worker/store.go:326-370`), the UPDATE matches zero rows, and because
the attempt insert shares the transaction (`Complete`, `:381-405`) the attempt row
rolls back with it. `Release` carries the same guard
(`internal/queue/postgres.go:457-467`), so a worker whose lease already lapsed
cannot clobber the new owner's claim.

**Guarantee.** Exactly one terminal status and one coherent attempt chain per
delivery — the ledger cannot be corrupted by a double claim. The **customer may
receive the webhook twice**, and that is accepted: at-least-once. The log line
says so in as many words (`internal/worker/deliver.go:455-459`).

**Blast radius.** One delivery.

**Gaps.** None. This is the most carefully defended path in the system.

*Proven by* `TestScenario17_TwoWorkersAttemptTheSameDelivery`
(`internal/failure/concurrency_test.go:39`), whose two subtests are "eight
claimers race for one delivery" (`:45`) and "concurrent claimers partition a
backlog with no overlap" (`:92`).

---

## 18. Database connection pool is exhausted

**What fails.** All `DATABASE_MAX_CONNECTIONS` (20 per process,
`internal/config/config.go:212`) are in use and new callers queue in `Acquire`.

**As implemented.**

**The pool is bounded** — an unbounded pool turns a slow query into a
database-wide outage.

**Every call has a deadline**, so a queued `Acquire` cannot wait forever: ingest
5s (`internal/ingest/handler.go:26-36`), worker and router likewise. The comment
at `handler.go:26-36` names the failure precisely: without a deadline, a lock
wait pins one goroutine and one pool connection per request until the pool is
exhausted, after which new requests block in `Acquire` with no deadline of their
own and shutdown cannot drain.

**A server-side backstop** catches the paths that forget:
`SET statement_timeout` on every connection (`internal/db/db.go:189-197`),
applied via `AfterConnect` rather than a connection-string parameter so it
covers every connection the pool makes.

**The pre-auth ceiling protects the pool from unauthenticated pressure.**
`SourceLimiter` (`internal/ingest/source.go:12-34`) is charged before any database
work (`handler.go:165-177`) and is in-process on purpose, because the resource it
protects — this pod's pool — is per-process too. A failed credential costs the
address extra (`handler.go:179-189`, penalty 20 by default,
`internal/config/config.go:227`), which is what lets the limit be generous for
honest traffic and punitive for a key-spraying flood. The attack it closes needs
no credential: around forty concurrent bogus-bearer requests exhaust a pod's pool.

**Load shedding.** The readiness check pings the pool
(`cmd/webhookd/main.go:85-87`), and that ping itself needs a connection, so an
exhausted pool makes readiness fail within its 3s budget
(`internal/httpx/health.go:60-61`) and Kubernetes removes the pod from the
Service until it recovers.

**Bounded concurrency upstream.** Router fan-out concurrency is capped
(`internal/router/router.go:26-29` — each holds one pooled connection for the
length of its transaction, so it must stay well under
`DATABASE_MAX_CONNECTIONS`); the worker claims only as many rows as it has free
slots (`internal/worker/worker.go:289-299`).

**Guarantee.** **Only time.** No accepted event is lost; ingest 500s rather than
half-accepting.

**Blast radius.** One pod first, then its tenants as requests are refused. A
pool exhausted by one project's burst affects every project on that pod — the
pool is not partitioned by tenant.

**Recovery, when a row does get parked.** Sustained pool pressure no longer parks
accepted events on its own — see scenario 8 for the `unaccounted_attempts` split
that stopped it. But parking still exists, deliberately: a queue that a single
bad row can block forever is a queue that stops during exactly the incident you
need it for. Four reasons park a row
(`internal/router/metrics.go:74-80`): `attempts_exhausted` (claimed
`ROUTER_MAX_OUTBOX_ATTEMPTS` times leaving no recorded outcome — what a row that
kills the process looks like), `retry_duration_exceeded` (failing, and recording
it, for longer than `ROUTER_MAX_OUTBOX_RETRY_DURATION_MS`),
`unknown_outbox_type`, and `event_missing`.

There is now a way back, and it is an API rather than a psql session. This is the
other half of the G1 fix (`apps/control-api/src/outbox/`):

| Route | Permission | Does |
|---|---|---|
| `GET /v1/projects/:projectId/outbox?status=failed` | `events.read` | Lists parked entries, newest first, with `last_error`, `attempts` vs `unaccounted_attempts`, and `fan_out_cursor`. |
| `GET /v1/projects/:projectId/outbox/:outboxId` | `events.read` | The full router-side state of one entry. |
| `POST /v1/projects/:projectId/outbox/:outboxId/requeue` | `events.replay` **and** `deliveries.replay` | Returns one parked entry to the queue. |
| `POST /v1/projects/:projectId/outbox/requeue` | `events.replay` **and** `deliveries.replay` | Bulk: up to `MAX_REQUEUE_BATCH` (100) entries, oldest first, with `has_more`. |

Things to know before pressing it, all of which the controller says in its own
API description (`apps/control-api/src/outbox/outbox.controller.ts:95-127`):

- **It is not a replay.** A parked event has no delivery rows for a replay to
  work from, so the router runs the subscription match it never got to run. That
  match is bounded to the subscriptions that existed when the event was
  *accepted* — an endpoint subscribed since will not receive it — but their
  *current* configuration applies, and a subscription deleted since is gone.
- **The budgets reset, the history does not.** `unaccounted_attempts` and
  `failing_since` are cleared, because the operator has looked at it;
  `attempts` is deliberately preserved
  (`apps/control-api/src/outbox/outbox.service.ts:258-283`), so the number that
  separates "requeued four times and keeps dying" from "first time" survives.
- **A partly-completed fan-out resumes from its cursor** rather than re-sending
  to endpoints it already reached.
- Both routes are throttled to 10 requests per 5 minutes and audited as
  `event_outbox.requeued` (`outbox.service.ts:129`, `:194`) — including a zero-row
  requeue, because "somebody tried and got nothing" is a thing an operator needs
  to see.
- Only `status = 'failed'` is requeueable (`outbox-limits.ts:36`). Anything else
  is either already in the queue or already finished.

**Gaps.** G15 (the worker's DB timeout is the ingest one).

*Proven by* `TestScenario18_ConnectionPoolExhausted_DegradesInsteadOfLying`
(`internal/failure/outage/pool_test.go:35`) and
`TestScenario18_ConnectionPoolExhausted_QueuesRatherThanCorrupts` (`:130`). The
requeue path has its own suite in
`apps/control-api/src/outbox/outbox.service.spec.ts` — including "does NOT reset
attempts - two docblocks call that column monotonic" (`:141`), "preserves
fan_out_cursor, so a partial fan-out resumes rather than restarts" (`:170`) and
"un-fails the event, because the router only promotes `received`" (`:178`).

---

## 19. Tenant creates a huge burst

**What fails.** One project publishes 100k events in a minute, or has 10,000
subscriptions and publishes one.

**As implemented, in four places.**

**At ingest.** The pre-auth per-address ceiling
(`internal/ingest/source.go`, 300/s default, `internal/config/config.go:224`)
runs before the database is touched, and the policy-driven
per-key/project/organisation buckets (`internal/ratelimit/limiter.go:113-133`)
run after authentication. Every bucket is charged even once one has refused, so
an attacker inside one project cannot shelter the rest of the organisation's
budget from accounting. Refusals are 429 with `Retry-After`
(`internal/ingest/limiter.go:20-21`).

**At fan-out — and this is where the G2 fix lives.**
`ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT` (1000,
`internal/config/config.go:270`) now bounds **one transaction**, not one event
(`internal/router/router.go:34-45`, `internal/router/store.go:104-119`). The
bound the cap existed for — one misconfigured project must not write an
unbounded batch inside a single transaction — is preserved exactly. What is gone
is the bound on the *total*.

The router walks the project's subscriptions by **keyset**, not `OFFSET`
(`store.go:340-369`): `s.id > $2` is the resume point, ids are ULIDs so the walk
is oldest-first and deterministic, and a subscription deleted mid-walk cannot
shift the window and skip its neighbour. The cursor is committed onto
`event_outbox.fan_out_cursor` by `advanceFanOutSQL` (`store.go:495-503`), the row
goes straight back to the ready set, and the event stays `processing` — **not
`processed`** — until the final batch. So an event mid-fan-out is observable as
such, and a crash between batches re-runs at worst one batch and creates nothing
twice, arbitrated by the partial unique index.

The walk is additionally **pinned to publish time**: `s.created_at <= $3`
(`store.go:367`, reasoning at `:309-337`). A batched fan-out spans several
transactions and therefore several snapshots; without the pin, an event accepted
at 09:59 whose batch 1 committed could hand a delivery to a subscription created
at 10:00 whose ULID sorted after the cursor. The observable rule would have been
"you receive events published before you subscribed **if** your project happens
to have more subscriptions than the batch size", which nobody can reason about,
least of all the customer it happens to. The pin makes the answer the same for
every project and every width: **an event reaches the subscriptions that existed
when it was accepted.** The boundary is deliberately forgiving — both columns are
`timestamp(3)`, so a subscription created in the same millisecond is included.

`ErrFanOutTruncated` still exists (`store.go:34`) and is unreachable under
batched fan-out, and it **fails the transaction** rather than committing if it
ever does fire. A loud release is recoverable; a silent commit is not. That
sentence is the whole lesson of G2.

The signal changed with the behaviour: `router_subscriptions_skipped_total`
`{reason="fan_out_cap_exceeded"}` no longer exists. A wide event now increments
`router_fan_out_batches_total` (`internal/router/metrics.go:44-47`), which is a
**capacity** signal — some events take several transactions and the outbox
carries them for a few extra polls — not a data-loss one.

**At delivery.** Four nested non-blocking ceilings — global 512, org 128, project
64, endpoint 16 (`internal/config/config.go:287-290`, enforced in
`internal/worker/gate.go:65-101`). A refusal defers with jitter
(`internal/worker/deliver.go:41-52`, `:635-644`) rather than blocking, which is
the difference between backpressure and starvation. The scope that refused is
reported so `rate_limit_hits_total` says *which* ceiling bit
(`gate.go:57-61`) — guessing between them from a saturated dashboard is the
difference between raising a limit and scaling out.

**At claim.** ADR-0007's tenant-fair claim exists and is fully implemented
(`internal/queue/postgres.go:82-113`, with a hand-written loose index scan at
`:115-141` and a shuffle at `:320-335` — without the shuffle the outer LIMIT
would systematically truncate whichever tenants sort last, "starvation wearing a
fairness costume"). It is **off by default** (`config.go:285`,
`postgres.go:197-215`). The SLI that decides when to flip it is
`queue_head_of_line_delay_seconds` (`internal/metrics/metrics.go:118`, measured
server-side at `internal/queue/postgres.go:53-57` so it carries no clock skew) —
and the load suite has now made it non-hypothetical: 49.6 s single-host, 6.5 s
multi-host, against 0.3 s when nothing is slow (`docs/LOAD_TESTING.md:373-378`).

**Guarantee.** **Only time.** A burst is absorbed by the outbox and drains at the
fleet's delivery rate. There is no longer a width at which fan-out loses
subscribers.

**Blast radius.** The bursting project first. With `CLAIM_STRATEGY=fifo` (the
default), a large single-tenant backlog occupies the head of the claim order and
other tenants' deliveries wait behind it. It partially self-corrects — a deferred
delivery gets `next_attempt_at = now + jitter` and sorts behind rows that are
already due — but the head-of-line delay is real and is the thing to watch.

**Gaps.**

- **G13 (High): per-endpoint isolation is a ceiling, not a reservation.** Full
  treatment in the gaps section. Short version for a page: when the
  `max_concurrency` of the endpoints that are currently slow sums past
  `WORKER_CONCURRENCY`, slow work is entitled to the whole pool and fast
  endpoints wait. The gate is behaving exactly as written; the outcome is still
  starvation. The unenforced operator rule is
  `sum(max_concurrency of endpoints that can be slow) < WORKER_CONCURRENCY`, and
  nothing in the product surfaces or enforces it.

  Related and worth knowing during the same page: a per-host transport ceiling
  used to sit *below* every one of these gates.
  `MaxConnsPerHost` was hard-coded at 16, so the entire data plane opened at most
  16 connections to any one host, whatever `max_concurrency` said, for every
  tenant sharing that host — which is the normal shape. It is now
  `EGRESS_MAX_CONNS_PER_HOST`, defaulting to `WORKER_CONCURRENCY`
  (`internal/config/config.go:300`, `:306-329`, refused if non-positive at
  `:405-408`, logged next to `concurrency` in the `worker started` line at
  `cmd/webhookd/roles.go:280-286`). Measured effect on the single-host topology:
  fast-group p95 from 118,734 ms to 12,660 ms (`docs/LOAD_TESTING.md:420-423`).
  If you are reading an isolation result from before 2026-09-09, it measured the
  connection pool, not the gate.

- **G16 (Low-Medium):** a delivery refused at the org/project gate defers with
  `unknownBudget`, so it has no wall-clock stop. Compounds with G13 under
  sustained saturation.

*Proven by* `TestScenario19_TenantBurstDrainsUnderTheDefaultClaim`
(`internal/failure/burst_test.go:104`),
`TestScenario19_TenantFairClaimProtectsTheNeighbour` (`:164`),
`TestPostgresFanOutWiderThanOneBatchReachesEveryEndpoint`
(`internal/router/store_postgres_test.go:978`),
`TestPostgresAnUnfinishedFanOutIsNotMarkedProcessed` (`:1026`),
`TestPostgresReplayingAFanOutBatchCreatesNoDuplicates` (`:1076`),
`TestPostgresFanOutIsPinnedToTheSubscriptionsThatExistedAtPublishTime`
(`:1203`) and `TestEgressLimitsCarryTheConfiguredPerHostCeiling`
(`cmd/webhookd/roles_test.go:206`).

---

## 20. Endpoint becomes permanently unhealthy

**What fails.** An endpoint is dead and stays dead — a decommissioned service, a
domain that lapsed, a customer who forgot they had a webhook.

**As implemented.** The circuit breaker over `endpoint_health`. PostgreSQL is
authoritative (`internal/worker/breaker.go:189-196`): the state survives a Redis
flush and every worker sees the same row.

**Opening.** Five consecutive qualifying failures move the endpoint to `open`
(`internal/worker/store.go:606-649` — the arithmetic is done by PostgreSQL, not
in the process, so two workers finishing at the same instant cannot both read 4
and both write 5). What qualifies is narrower than what fails a delivery
(`internal/worker/deliver.go:406-420`).

**Cooldown.** Doubles per failure past the threshold, capped at
`MaxCooldown` (10 minutes, `internal/worker/breaker.go:63`, computed at
`:109-127`), with jitter so a thousand endpoints that failed together do not all
probe in the same millisecond.

**Probing without a thundering herd.** `ClaimProbe`
(`internal/worker/store.go:515-554`) is a conditional UPDATE where the predicate
that admits a probe is also the write that withdraws the invitation: exactly one
worker's UPDATE matches, every other gets zero rows and defers. A worker that
dies mid-probe is covered by `probe_after` expiring and `state IN ('open',
'half_open')` in the predicate — without which the endpoint would sit
permanently `half_open` and permanently undeliverable. That file also carries a
live-observed bug fix worth knowing about (`store.go:527-532`): resetting the
success counter on every probe claim made `HalfOpenSuccesses` unreachable and a
fully recovered endpoint sat in `half_open` forever.

**Nothing may spend the probe.** Once `breaker.Allow` has claimed the half-open
slot, nothing between there and `client.Do` is allowed to defer
(`internal/worker/deliver.go:177-181`). That is why the endpoint rate limit and
the payload fetch sit *above* the breaker rather than below it — a recovering
endpoint whose one probe was consumed by a delivery that then deferred at the
limiter loses a whole `HalfOpenTTL` of recovery each time, indefinitely if the
bucket stays saturated.

**Failing open.** A health read error allows the delivery
(`internal/worker/breaker.go:225-236`): the breaker is a pressure-relief valve,
not an authorisation check, and refusing deliveries because a SELECT failed
converts a database blip into a delivery outage.

**Operator-driven termination.** A `deleted`, `disabled` or `paused` endpoint
**cancels** its deliveries rather than retrying them
(`internal/worker/store.go:46-61`, applied at `deliver.go:90-96`) — `cancelled`
means "we stopped on purpose", which keeps `failed` meaning "the endpoint
rejected it".

**Deliveries now age out.** This is the G3 fix, and it is the one that changes
what you will see at 2am. A breaker refusal defers
(`internal/worker/deliver.go:163-175`), and a deferral writes **no attempt row
and burns no attempt budget** — which is right, since no request was made. But
the wall clock is spent by the clock, not by us asking, and it is now consulted:
`deferDelivery` checks the delivery's `deferBudget` on every deferral path
(`deliver.go:517-519`, reasoning at `:534-552`), and a delivery past
`first_attempt_at + max_retry_duration` is taken **terminal** instead —
`exhausted` with reason `retry_duration_exhausted`, no attempt row, no
`attempt_count`, and `deferred_for` recording what had been holding it up
(`expireDelivery`, `deliver.go:595-630`).

Both halves matter and they pull in opposite directions. It must **end**, because
the wall clock ran out: `retry.Policy.Exhausted` was reachable only from `Decide`,
which runs when an attempt *completes*, so a delivery behind a permanently open
breaker reached no budget check at all and was re-claimed every cooldown forever.
And it must end **without spending an attempt**, because none was made — charging
one would make the ledger read as the customer's endpoint rejecting the webhook,
and send an operator to raise `max_attempts` for a wall-clock problem.

`first_attempt_at` is `COALESCE(MIN(delivery_attempts.started_at), deliveries.created_at)`
(`internal/worker/store.go:186-187`), so a delivery that was never attempted
still has a clock, and it is taken from the ledger rather than a column — a
replayed or reclaimed delivery cannot quietly reset it.

**Guarantee.** Delivery pressure is removed from a dead endpoint within five
failures, it is probed once per cooldown, and every delivery to it reaches a
terminal state within its `max_retry_duration` (24h by default,
`internal/retry/retry.go:34`). Nothing is lost, and nothing accumulates without
bound any more.

**Blast radius.** One endpoint. The queue-wide degradation this used to cause —
ever-older deferred rows sorting ahead of live traffic under the default FIFO
claim — is bounded by the retry duration rather than unbounded.

**Gaps.**

- **G14 (Medium): no auto-disable and no retention.** The breaker removes
  *request* pressure; nothing removes *row* pressure. New events keep fanning out
  to a dead endpoint forever, each producing a delivery that will be claimed,
  refused, deferred and exhausted 24 hours later. `disabled_reason` is only ever
  set to `null` by the control plane
  (`apps/control-api/src/endpoints/endpoints.service.ts:310`, `:326`), and no
  reaper prunes terminal rows in either plane.

*Proven by* `TestScenario20_EndpointBecomesPermanentlyUnhealthy`
(`internal/failure/breaker_test.go:63`),
`TestScenario20_OnlyOneWorkerWinsTheHalfOpenProbe` (`:184`),
`TestDeliveryDeferredForeverEventuallyExhaustsItsRetryDuration`
(`internal/failure/retry_budget_test.go:40`),
`TestDeliveryDeferredInsideItsBudgetIsRescheduledNotTerminated` (`:109`),
`TestDeferredDeliveryExpiresWhenItsWallClockBudgetRunsOut`
(`internal/worker/defer_test.go:41`),
`TestDeferInsideTheBudgetStillDefersAndSpendsNoAttempt` (`defer_test.go:125`)
and `TestPayloadOutageDoesNotSpendTheHalfOpenProbe` (`defer_test.go:250`).

---

## Appendix A — first five minutes

```bash
# Is anything stuck before the fan-out?
psql "$DATABASE_URL" -c "
  SELECT status, count(*), min(available_at) AS oldest
  FROM event_outbox GROUP BY status ORDER BY 2 DESC;"

# Parked outbox rows: events that returned 202 and are NOT being retried.
# attempts vs unaccounted_attempts tells you which kind of trouble it is —
# a high unaccounted count means claims that left no recorded outcome (a row
# that kills the router); a low one with a failing_since means the database
# was failing under it.
psql "$DATABASE_URL" -c "
  SELECT o.id, o.event_id, o.attempts, o.unaccounted_attempts, o.failing_since,
         o.fan_out_cursor, o.last_error, e.project_id, e.event_type
  FROM event_outbox o JOIN events e ON e.id = o.event_id
  WHERE o.status = 'failed' ORDER BY o.created_at DESC LIMIT 50;"

# Events mid-fan-out. `processing` with a fan_out_cursor is normal for a wide
# event; `processing` that is not advancing is not.
psql "$DATABASE_URL" -c "
  SELECT id, event_id, fan_out_cursor, available_at, locked_by, locked_until
  FROM event_outbox WHERE status = 'processing' ORDER BY available_at LIMIT 20;"

# Deliveries that are not moving, and why.
psql "$DATABASE_URL" -c "
  SELECT status, last_error, count(*)
  FROM deliveries WHERE completed_at IS NULL
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;"

# Endpoints the breaker has taken out.
psql "$DATABASE_URL" -c "
  SELECT endpoint_id, state, consecutive_failures, probe_after
  FROM endpoint_health WHERE state <> 'healthy' ORDER BY consecutive_failures DESC;"

# Which endpoints are eating the worker pool (G13). Compare the sum against
# WORKER_CONCURRENCY on the worker Deployment.
psql "$DATABASE_URL" -c "
  SELECT e.id, e.url, e.max_concurrency, count(d.id) AS in_flight
  FROM endpoints e
  LEFT JOIN deliveries d
    ON d.endpoint_id = e.id AND d.locked_until > now()
  GROUP BY 1,2,3 HAVING count(d.id) > 0
  ORDER BY in_flight DESC LIMIT 20;"

# Are workers dying mid-attempt, and is the outbox falling behind?
curl -s localhost:9090/metrics | grep -E \
  'queue_leases_reclaimed_total|queue_leases_lost_total|queue_head_of_line_delay|outbox_pending_age_seconds|router_outbox_parked_total|queue_depth|egress_blocked_total'
```

**To un-park an event, do not write SQL.** Use the control-plane API (scenario
18): list with `GET /v1/projects/:projectId/outbox?status=failed`, requeue one
with `POST /v1/projects/:projectId/outbox/:outboxId/requeue`, or a page of a
hundred with `POST /v1/projects/:projectId/outbox/requeue`. Both requeue routes
need `events.replay` **and** `deliveries.replay`, are throttled to 10 requests
per 5 minutes, and write an `event_outbox.requeued` audit entry. Read `has_more`
and call again until it is false. Requeue in bounded passes rather than all at
once: every requeued row becomes a fan-out and every fan-out becomes real
outbound HTTP to endpoints that were, very often, already failing when the
incident started.

## Appendix B — metrics worth alerting on

Both of the never-populated metrics from the first draft are now real. Nothing in
this table reads a constant zero.

| Metric | Where set | Says |
|---|---|---|
| `outbox_pending_age_seconds` | `internal/router/router.go:491` | Fan-out is falling behind. Measures the oldest **due** row, so a backoff window is not counted as lag. |
| `router_outbox_parked_total` | `internal/router/metrics.go:74` | An event will not be delivered until an operator requeues it. Any non-zero value is an incident. Labelled by reason: `attempts_exhausted`, `retry_duration_exceeded`, `unknown_outbox_type`, `event_missing`. |
| `router_fan_out_batches_total` | `internal/router/metrics.go:44` | Some events are wider than one fan-out transaction. A **capacity** signal — raise `ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT` or accept a few extra polls per event. Not a correctness alert; it replaced one. |
| `router_subscriptions_skipped_total` | `internal/router/router.go:468` | A subscription was considered and not delivered to. Answers "we configured it, why is nothing arriving" without a database session. `fan_out_cap_exceeded` is no longer one of the reasons. |
| `queue_depth{state}` | `internal/metrics/queuedepth.go:186`, refreshed every 15s by the **scheduler** (`cmd/webhookd/roles.go:152-154`) | Work that is not happening. `ready` growing means workers cannot keep up; `delayed` growing means backoff; `in_flight` pinned at the pool size means saturation. The only instrument that can see a backlog of deliveries deferred by a breaker or a rate limit, because those move no counter at all. **Goes stale, not zero, if the scheduler is down** — check `up` first. |
| `egress_blocked_total{reason}` | `internal/egress/ssrf.go:90` | SSRF policy refusals, by a bounded code (`metadata`, `transition`, `private`, `loopback`, `redirect`, …). A customer probing egress policy, or an internal misconfiguration pointing at private space. Never labelled by customer-supplied text. |
| `queue_leases_reclaimed_total` | `internal/queue/postgres.go:514` | Workers are dying mid-attempt. |
| `queue_leases_lost_total{phase}` | `internal/queue/lease.go:168`, `internal/worker/deliver.go:228`, `:261`, `:368`, `:455`, `:585`, `:620` | Leases lapsing under live attempts — duplicates are being sent. |
| `queue_head_of_line_delay_seconds` | `internal/queue/postgres.go:257`, measured server-side at `:53-57` | Tenant starvation. This is the number that decides `CLAIM_STRATEGY=tenant_fair`, and the load suite has already seen it at 49.6 s. |
| `rate_limit_hits_total{scope}` | `internal/worker/deliver.go:43`, `:101`, `:124`, `:167`; `internal/ingest/handler.go:175`; `internal/ratelimit/limiter.go:177` | Which ceiling bit. `endpoint_concurrency` climbing while deliveries are slow is the G13 signature: the gate is refusing and the work is churning. |
| `rate_limiter_degraded_total{cause}` | `internal/ratelimit/limiter.go:156`, `:226` | Redis is gone; limits are per-replica. Alert on this, not on the (throttled) log line. |
| `circuit_breaker_open_total` | `internal/worker/breaker.go:300` | Endpoints going dark. |
| `payload_orphan_objects_total{outcome="leaked"}` | `internal/ingest/handler.go:390` | Ingest failed after a payload upload. Storage cost only. |

## Appendix C — smaller divergences

Not scenario-specific: places where the code and its own documentation disagree.
They cost nothing today and cost an hour at 2am when someone trusts the wrong
one.

**G18 (Low): the router's comment describes the bug, not the fix.**
`internal/router/router.go:151-163` still tells the reader that
`cmd/webhookd/roles.go` passes `retry.DefaultPolicy()` and that the one-line fix
in `roles.go` has not landed. It has: `roles.go:92-96` passes
`router.DefaultOutboxBackoff()`, so a repeatedly failing outbox row backs off on
the outbox's own schedule (1s initial, 1-minute cap,
`router.go:189-197`) rather than the delivery schedule's one hour. The clamp the
comment introduces is still correct and is still worth keeping as a guard rail
against a future caller. Only the prose is wrong.

**Fixed and worth knowing about (was G12).** Three comments that used to describe
behaviour the code no longer had are now correct, and the corrections are worth
reading once because each one would have sent an operator the wrong way:

- `internal/queue/postgres.go:483-497` — `deliveries_ready_idx` and
  `deliveries_ready_fifo_idx` both include `processing`, so an expired lease is
  inside the index and the indexed claim path finds it cheaply. `ReclaimExpired`
  is a convenience, not the only route back into the ready set. Believing the
  old comment meant treating a dead scheduler as a delivery incident. It is not
  (scenario 6).
- `apps/control-api/prisma/schema.prisma:674-691` — the Go side is ready for
  `next_attempt_at NOT NULL`; `advanceSQL` writes `now()` on the terminal branch
  (`internal/worker/store.go:361`). What blocks the migration is the **existing
  rows**, and the note now names the backfill and the `NOT VALID` +
  `VALIDATE CONSTRAINT` sequence that avoids locking the largest table in the
  system for a full scan. Why it mattered at all: the claim used to order by
  `next_attempt_at NULLS FIRST`, so NULL was not a neutral value — it was the
  front of the queue. The column is NOT NULL since `20260911000000` and the
  `NULLS FIRST` is gone.
- `OUTBOX_BATCH_SIZE` is gone. It was loaded and read by nothing;
  `runRouter` uses `ROUTER_BATCH_SIZE` (`cmd/webhookd/roles.go:85`). The Helm
  values file records the removal at
  `deployments/helm/hookubit/values.yaml:356` so an operator upgrading
  does not go looking for it.

**Load-test results have a before and an after.** Any isolation number measured
before 2026-09-09 measured `MaxConnsPerHost = 16`, not the concurrency gates —
see `docs/LOAD_TESTING.md:149-186`. Do not compare across that line.
