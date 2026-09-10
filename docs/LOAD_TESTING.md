# Load testing

ARCHITECTURE.md 58 asks for k6 load tests and ARCHITECTURE.md 63 makes "load
testing has been performed" part of the MVP definition of done. This is that
suite: `tests/load/`.

Five scenarios, each with thresholds that encode an architectural claim, so a
run **passes or fails** rather than producing numbers somebody has to interpret.

**The most important thing to understand before you read a single number:** k6
measures ingest, and ingest is the easy half. A `202` means the event is durably
persisted, not delivered. So every run has two verdicts — the k6 thresholds, and
a ledger check that queries `deliveries` afterwards. A run where ingest was fast
and nothing was delivered exits non-zero.

## 0. Prerequisites

**k6.** `brew install k6`, or
<https://grafana.com/docs/k6/latest/set-up/install-k6/>. The suite refuses to
start without it and prints the install line.

Docker works too, but the manifest's URLs are host-local, so a container needs
them rewritten to `host.docker.internal` before anything is reachable:

```bash
docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -v "$PWD/tests/load:/load" grafana/k6 run /load/scenarios/fanout.js
```

Installing k6 natively is much less trouble.

**Everything from docs/LOCAL_SETUP.md running**: PostgreSQL, the control API on
`:3000`, the data plane on `:8080`/`:9090`, and MinIO if you want the
large-payload scenario to do anything. The suite preflights all of them and
names whichever one is missing.

**Node 20+.** The tooling has no dependencies of its own — it borrows
`@prisma/client` and `argon2` from `apps/control-api` through its
`package.json`, so there is no extra `pnpm install` to forget.

## 1. Run one

```bash
pnpm load:fanout        # high fan-out
pnpm load:slow          # slow endpoints  <- the one that matters
pnpm load:failing       # 500s, 429s, dead sockets
pnpm load:tenants       # tenant fairness
pnpm load:large         # payloads that cross the offload boundary
pnpm load:all           # all five, in order
```

Each of those seeds, starts the sink, runs k6, waits for the backlog to drain,
scrapes `:9090` either side, and checks the ledger. Roughly three minutes each
at the defaults.

The pieces are also usable on their own:

```bash
pnpm load:sink                                  # the target, on :8091-8098
pnpm load:seed slow-endpoints                   # idempotent; --force re-mints keys
pnpm load:verify slow-endpoints --since 2026-09-09T10:00:00Z
```

## 2. What gets created, and where

Everything lives under one organization, **HookuBit Load Tests**, created
through the real REST API by an operator account the seed owns
(`load-test@hookubit.invalid`). One project per scenario — `load-fanout`,
`load-slow-endpoints`, `load-failing-endpoints`, `load-tenant-1..5`,
`load-large-payloads` — each with its own endpoints, subscriptions, retry
policies and API key.

The seed drives the control API rather than writing SQL, deliberately: it
exercises the same paths a customer would, so a broken control plane fails the
seed instead of quietly producing a load test that measures nothing.

**There is exactly one SQL write, and it is the operator account.** Registration
is gated by `ALLOW_OPEN_REGISTRATION` (false, and it should stay false),
`pnpm bootstrap` refuses to run once any user exists, and logging in as your own
account would need your password. So `scripts/support/api.mjs` writes one `users`
row — a dedicated, clearly-named account on a non-routable domain, hashed with
the same argon2id parameters as `PasswordService` — and everything after that is
HTTP. It never touches an account it did not create.

**Which database.** Whatever `DATABASE_URL` in `.env` points at, because that is
where the running services write; a load test against a different database than
the data plane is not a load test. On a normal dev box that is `HookuBit`. It is
**not** `hookubit_test` — that belongs to the Go and Nest suites, and dropping a
load run into it will make somebody's integration test fail for reasons they
will not enjoy chasing. Point `LOAD_DATABASE_URL` and the service URLs at an
isolated stack if you need one.

`tests/load/.artifacts/` holds the manifests, the k6 summaries, the ledger JSON
and the operator password. **It is gitignored, and it contains plaintext API
keys** — the control plane returns a key exactly once, so the suite has to keep
it to publish again.

To clean up afterwards:

```sql
-- soft-delete keeps the ledger; this actually removes it
DELETE FROM organizations WHERE slug = 'hookubit-load-tests';
DELETE FROM users WHERE email = 'load-test@hookubit.invalid';
```

`deliveries` has `ON DELETE Restrict` against `endpoints` on purpose, so drop
the whole organization or nothing.

## 3. The sink

`tests/load/sink/sink.mjs`. Zero dependencies, and by default it behaves exactly
like the throwaway sink in LOCAL_SETUP: `200 {"ok":true}`, immediately, on any
path. What it adds is being able to be told to misbehave.

Behaviour resolves in this order — query string, then path profile, then a
runtime override, then the default:

| profile      | behaviour                                            |
| ------------ | ---------------------------------------------------- |
| `fast`       | 200, immediately                                     |
| `slow`       | 200 after `LOAD_SINK_SLOW_MS` (default 5000)         |
| `fail`       | 500                                                  |
| `flaky`      | 500 half the time                                    |
| `throttled`  | 429 with `Retry-After: 1`                            |
| `timeout`    | never answers; the endpoint's `timeout_ms` ends it   |

The seed writes the behaviour into the endpoint's URL, so
`select url from endpoints` in psql tells you what an endpoint was configured to
do during a run:

```
http://127.0.0.1:8091/sink/slow?g=slow&ep=slow-1&delay_ms=5000
```

Control surface: `GET /_stats`, `GET /_stats/drain`, `POST /_reset`,
`POST /_profiles/<name>` (e.g. `{"delayMs":250,"failRate":0.1}`), `GET /_healthz`.

The sink is also **the measurement point for delivery latency**. Every event the
suite publishes carries `published_at_ms`, so the instant a request lands the
sink knows how long the whole path took — accept, outbox, route, claim, sign,
send. The k6 `collect` scenario drains those samples and replays them into k6
metrics, which is how "a slow tenant must not starve a fast one" becomes a
threshold instead of a paragraph. First attempts only: a retry's clock includes
backoff the retry policy imposed on purpose, and mixing the two makes "the
platform is slow" and "the endpoint is down" the same number.

### The sink listens on eight ports, and that is not a throughput decision

**Read this before you believe any isolation result.**

This is the defect the suite was written to find, and it is now fixed — the
history is kept because it is what the ports are for.

The data plane built one egress client per process with `IdleConnsPerHost: 4`
hardcoded in `services/data-plane/cmd/webhookd/roles.go`, and Go's transport
derived `MaxConnsPerHost = 16` from it. So **the entire data plane opened at
most 16 concurrent TCP connections to any one destination host:port**, shared by
every endpoint and every tenant pointing at that host. `WORKER_CONCURRENCY`,
`MAX_CONCURRENCY_PER_ENDPOINT` and the per-endpoint gate all sat above that
ceiling and none of them could raise it.

Put every load-test endpoint on one port and that ceiling was what you measured:
sixteen five-second requests starved everything else, and the run reported "no
isolation" when what it had found was a connection pool. Measured here, on this
repo, same scenario, same rates:

| endpoints on            | fast-group delivery p95 | head-of-line delay |
| ----------------------- | ----------------------- | ------------------ |
| one port (`8091`)       | 119,909 ms              | 49.6 s             |
| eight ports (`8091-98`) | 16,565 ms               | 6.5 s              |

The ceiling is now `EGRESS_MAX_CONNS_PER_HOST`, defaulting to
`WORKER_CONCURRENCY` — see section 7. Re-measured on the single-port topology
that exposed it, changing nothing else:

| per-host ceiling      | fast p50  | fast p95   | head-of-line delay |
| --------------------- | --------- | ---------- | ------------------ |
| 16 (hardcoded, old)   | 63,218 ms | 118,734 ms | 66.1 s             |
| 64 (= pool, new)      | 6,460 ms  | 12,660 ms  | 6.5 s              |

The sink still spreads endpoints over `LOAD_SINK_PORTS` ports (default 8) and
allocates them so **different groups never share a port** — modelling production,
where different customers are different hosts. Keeping that default means a
future regression of the ceiling shows up as a difference between the one-port
and eight-port runs rather than as a scenario that has always been red.

`LOAD_SINK_PORTS=1` deliberately puts them back on one host. That is a real
scenario worth running (one customer, one domain, many endpoints) — just label
the result honestly when you do.

## 4. The scenarios, and what each one proves

### `fanout` — high fan-out

One event, N endpoints (default 25). Every endpoint is fast; the only variable
is the multiplication. Prices materialised fan-out: one delivery row per
matching subscription, each with its own retry chain.

Thresholds: ingest p95 < 300 ms, ingest errors < 1%, delivery p95 < 15 s,
deliveries received > 0. The ledger check additionally asserts **exact**
fan-out — delivery rows must equal what the subscriptions imply, per project.

### `slow-endpoints` — per-endpoint isolation

The important one. Six endpoints that take 5 s and four that answer immediately,
in the **same project, same organization, same worker pool** — the harshest form
of the claim in ARCHITECTURE.md 24 and `internal/worker`: a slow endpoint must
never consume the pool.

The proof is the threshold on `delivery_latency_ms{group:fast}`. The bar is one
slow attempt (`p(95) < LOAD_SLOW_MS`): a fast endpoint's webhook must not wait
longer than a single slow endpoint takes to answer.

**This scenario currently fails. See section 7.**

### `failing-endpoints` — retries and the circuit breaker

Four endpoints answering 500, one answering 429, one that never answers, and a
healthy control group alongside. The failing endpoints carry a seeded fast retry
policy (3 attempts, 1 s initial, 4 s ceiling) because the product default — 8
attempts starting at 5 s and doubling — is correct for production and useless in
a 45-second run, where nothing would reach a terminal state.

Thresholds cover the healthy group; the ledger check asserts what k6 cannot see:
attempts were recorded, deliveries were retried, and breakers opened.

### `many-tenants` — tenant fairness

Tenant 1 is the noisy neighbour: slow endpoints, 15 events/s, deliberately past
what the pool can absorb. Four quiet tenants publish 3/s each. Threshold on the
quiet tenants' delivery latency.

Tenants here are **projects under one organization**, not separate
organizations: `POST /v1/organizations` is throttled to ten per hour per address,
so an org-per-tenant seed is not re-runnable. It is also the harsher test — the
noisy tenant's work counts against the same per-org ceiling as everyone else's.

### `large-payloads` — the offload boundary

96 KB events, above `PAYLOAD_INLINE_MAX_BYTES` (64 KB), so ingest writes them to
object storage and the worker fetches them back before signing. The ledger check
asserts every event was actually offloaded — otherwise the scenario is a no-op
that nobody notices.

## 5. Reading the output

Four blocks, in this order.

**THRESHOLDS** — one line per architectural claim, `PASS` or `FAIL`, with the
measured value. This is the verdict.

**INGEST / DELIVERY** — the numbers behind it. `DELIVERY` is per group, measured
at the sink. `NOTHING WAS DELIVERED` there means the run is void whatever ingest
did.

**DATA PLANE** — `:9090` counters differenced across the run. These are
**process-wide**, not scoped to the scenario: a previous run still draining, or
another project on the same data plane, is counted here too. The one to watch is
`queue head-of-line delay` — `internal/queue` names it as the measurement that
decides whether `CLAIM_STRATEGY` should stop defaulting to FIFO.

**LEDGER CHECK** — `deliveries` and `delivery_attempts`, scoped to this run's
projects and time window. Per group: rows created, how many succeeded, what
percentage reached a terminal state, attempts, the highest attempt number, and
delivery latency percentiles from `completed_at - events.created_at`.

Two latency numbers, deliberately different:

- the **sink** number is measured on arrival, so it excludes the endpoint's own
  response time — it is what the platform cost;
- the **ledger** number is `completed_at - created_at`, so it includes it — it is
  what the customer waited.

For a fast endpoint they are nearly equal. For the 5-second slow group the gap
is 5 seconds, and that is correct.

## 6. Gotchas

**The pre-auth ingest ceiling is 300 requests/second per source address**
(`INGEST_SOURCE_RATE_LIMIT`, burst 600) and a load generator on one machine is
one source address. Every scenario is sized well under it. If you raise the
rates and start seeing 429s, that is what you hit — the run is now measuring the
rate limiter. Raise `INGEST_SOURCE_RATE_LIMIT` in the data plane's environment
and restart it, or publish from more than one address.

The per-API-key ingest ceiling (`INGEST_RATE_LIMIT`, 1000/s) is raised to 5000/s
per project by the seed through the real rate-limit policy API.

**A run must start quiet.** Deliveries outlive the k6 process by minutes; a run
that starts on top of the previous one's backlog measures both. The runner waits
for the scenario's projects to go quiet first and says so if they never do. If
you invoke k6 by hand, wait yourself:

```sql
SELECT status, count(*) FROM deliveries
 WHERE project_id IN (...) AND status NOT IN ('succeeded','failed','exhausted','cancelled')
 GROUP BY 1;
```

**Never stop the sink while deliveries are still queued.** They fail with
`connection refused`, five in a row opens the circuit breaker on a perfectly
healthy endpoint, and the next run reads as starvation. The runner drains before
it stops a sink it started; it leaves a sink you started alone.

**Circuit-breaker state persists in `endpoint_health` between runs.** An endpoint
left open by the last scenario is not attempted in the next one, which also
reads as starvation. The runner deletes those rows for its own endpoints before
each run — the worker recreates them on the next attempt.

**k6's delivery numbers are optimistic; the ledger's are complete.** The
collector stops at the end of its window (`LOAD_DRAIN`, default 90 s) and
whatever is still draining never reaches k6 — and what is still draining is by
definition the slowest. The ledger check sees all of it. When the two disagree,
the ledger is right.

**`--quiet` hides k6's progress bar.** The suite passes it because the custom
summary is the point. Drop it (`--k6-arg=...`) if you want to watch.

**The dashboard and the data plane share PostgreSQL.** A load run makes the
dashboard slow. That is the system telling you something true, but do not read it
as a dashboard bug.

## 7. What the suite found, on this repo

Measured on a 16-core macOS box, single data-plane process (`webhookd all`),
`WORKER_CONCURRENCY=64`, `CLAIM_STRATEGY` unset (FIFO), 2026-09-09.

| scenario            | verdict | headline                                          |
| ------------------- | ------- | ------------------------------------------------- |
| `fanout`            | PASS    | 300 events -> 7,500 deliveries, 100% ok, p95 812 ms |
| `slow-endpoints`    | FAIL*   | at DEFAULT caps; PASSES at 1.8 s once caps are provisioned under the pool — see section 7 |
| `failing-endpoints` | PASS    | control group 100% ok at p95 721 ms; 16 breakers opened |
| `many-tenants`      | FAIL    | quiet tenants 100% delivered, but p95 10.5 s      |
| `large-payloads`    | PASS    | 150/150 offloaded, delivery p95 611 ms            |

`FAIL*` is not a broken system, it is a threshold doing its job: the default
seed deliberately over-provisions the slow endpoints (6 x 16 = 96 against a pool
of 64) so the suite keeps measuring the unenforced rule in section 7 rather than
a configuration that has been tuned until it looks good. Relaxing the bar to go
green would delete the only evidence the rule exists.

### Per-endpoint isolation is a ceiling, not a reservation

Same scenario, same rates (92 deliveries/s), endpoints on distinct hosts, varying
only the slow endpoints' `max_concurrency` against a pool of 64:

| slow endpoints x cap | slow share of pool | fast p50 | fast p95   |
| -------------------- | ------------------ | -------- | ---------- |
| 6 x 16 = 96          | all of it          | 6,703 ms | 16,565 ms  |
| 6 x 4 = 24           | 38%                | 650 ms   | 8,117 ms   |
| control: no slow endpoints (100 ms) | none | 456 ms   | 1,044 ms   |

The control line is the same topology and the same load with the slow endpoints
answering in 100 ms, and it is the number the other two rows should be read
against.

What this says: `max_concurrency` bounds one endpoint, but nothing **reserves**
capacity for the others. When the per-endpoint ceilings of the slow endpoints sum
to more than `WORKER_CONCURRENCY`, slow work is entitled to the whole pool and
fast endpoints wait — the gate is working exactly as written and the outcome is
still starvation. Provision so that

```
sum(max_concurrency of endpoints that can be slow)  <  WORKER_CONCURRENCY
```

and the median recovers (650 ms against a 456 ms control). The p95 does not, and
that residue is real: gate-refused deliveries are re-queued and claimed again, so
a slow endpoint's backlog churns through the FIFO claim repeatedly and takes
claim capacity from endpoints that could have run. `rate_limit_hits_total{scope="endpoint_concurrency"}`
counts that churn — 7,176 deferrals against 3,974 deliveries in the second row
above.

Neither of these is a hypothesis about the code; both are the measured
difference between rows of that table.

### The claim strategy is untested here, and it is the obvious next thing

`internal/queue` ships `StrategyFIFO` as the default and says outright that
`tenant_fair` "becomes the default when `queue_head_of_line_delay_seconds`
actually shows starvation". It now does: 49.6 s in the single-host run, 6.5 s
multi-host, against 0.3 s when nothing is slow.

Two things to know before acting on that:

- `tenant_fair` caps per `(organization, project)`. In `slow-endpoints` the slow
  and fast endpoints share a project, so **it cannot help that scenario** — an
  endpoint-level term in the claim would be needed.
- In `many-tenants` the tenants are separate projects, so it should help, and
  that is the experiment worth running.

Comparing them needs a data-plane restart, which this suite deliberately does not
do to somebody else's process:

```bash
# terminal running the data plane
set -a; source .env; set +a
CLAIM_STRATEGY=tenant_fair pnpm dev:data-plane

# then
pnpm load:tenants
```

Compare `queue head-of-line delay` and the quiet group's p95 across the two runs.

### The 16-connection per-host ceiling — FIXED

Covered in section 3, and it was a product concern rather than a test artifact:
it was not per endpoint, not per tenant, and not reachable from any environment
variable. Any customer whose endpoints share a hostname — which is most of them
— shared 16 connections across all of them, however high their
`max_concurrency` was set, and so did every other tenant on that host.

It is now `EGRESS_MAX_CONNS_PER_HOST`, and it **defaults to
`WORKER_CONCURRENCY`**: a process cannot have more than `WORKER_CONCURRENCY`
attempts in flight, so that many connections to one host is exactly enough for
the transport never to be the thing that queues, and not one more than the pool
could use. Set it below the pool only to be deliberately gentle with a fragile
consumer — the queueing then happens in the transport on purpose rather than by
accident. The value is logged next to `concurrency` in the `worker started`
line, so an operator can see the two numbers together.

Re-measured on the single-port topology, `WORKER_CONCURRENCY=64`, everything
else unchanged (2026-09-09):

| per-host ceiling | fast p50 (ledger) | fast p95 (ledger) | fast p95 (sink) | head-of-line |
| ---------------- | ----------------- | ----------------- | --------------- | ------------ |
| 16 (old)         | 63,218 ms         | 118,734 ms        | 92,813 ms       | 66.1 s       |
| 64 (new default) | 6,460 ms          | 12,660 ms         | 12,658 ms       | 6.5 s        |

A 9.4x improvement in fast-group p95 from one number, and the single-host run is
now faster than the eight-port run used to be (16,565 ms). It does **not** make
`slow-endpoints` pass *at the default caps*: 12,660 ms is still over the
5,000 ms bar, because what remains is the reservation problem above — 6 slow
endpoints x `max_concurrency` 16 = 96 against a pool of 64. The sink shows it
plainly: the slow group's peak in-flight went from 16 (the transport ceiling) to
58 (very nearly the whole pool). The transport is no longer the constraint; the
pool is, which is the constraint the operator can actually see and configure.

**And once you configure it, the scenario passes.** Same single-port topology,
changing only `LOAD_SLOW_MAX_CONCURRENCY=4` so the slow endpoints' caps sum to
24, under the pool of 64:

| slow caps        | fast p50 | fast p95      | slow peak in-flight | verdict |
| ---------------- | -------- | ------------- | ------------------- | ------- |
| 6 x 16 = 96      | 6,460 ms | 12,660 ms     | 58                  | FAIL    |
| 6 x 4  = 24      |   485 ms | **1,782 ms**  | 24                  | PASS    |

`PASS slow-endpoints k6=0 ledger=0`, on one hostname, one project, one pool —
the harshest topology in the suite, and the first green on this scenario. The
peak in-flight column is the whole story: it is exactly the sum of the
configured caps, which is what "the gate is doing its job" looks like.

Read that result carefully, because it is easy to over-claim. It does **not**
say isolation works by default; it says isolation is now *achievable by
configuration*, which it was not before — no value of `max_concurrency` could
produce this while the transport ceiling sat below every gate. What is still
missing is that the rule which makes it work,

    sum(max_concurrency of endpoints that can be slow) < WORKER_CONCURRENCY

is unwritten, unenforced and unsurfaced. Nothing validates it, nothing warns
when it is violated, and the control plane does not know `WORKER_CONCURRENCY`
exists. An operator gets isolation by knowing this paragraph. That gap is G13 in
docs/FAILURE_RECOVERY.md, and it is the most operationally significant one open.

## 7b. Graceful shutdown under load

ARCHITECTURE.md 47 requires a drain that does not lose work, and the shutdown
path has a specific hazard: a restart must not be charged to the customer. An
attempt cancelled by OUR drain, written as a failed attempt row, advances
`attempt_count` and moves that endpoint's breaker one failure closer to open -
so a rolling deploy degrades every slow customer's health.

Exercised on 2026-09-09 against endpoints that take 5s to answer, so work was
genuinely in flight rather than theoretically so:

1. 20 events to a project with 10 slow endpoints. At the moment of the signal:
   **64 deliveries `processing`, 56 `pending`.**
2. `SIGTERM`.

Observed:

| | |
| --- | --- |
| readiness flipped to `draining` | within 1s, before any listener closed |
| process kept serving | ~5s propagation window, then exited cleanly |
| deliveries | 120 of 120 succeeded, 120 distinct (event, endpoint) pairs |
| attempts | 120 - exactly one per delivery, all HTTP 200 |
| attempt rows reading `context canceled` | **0** |
| rows still locked by the dead process | **0** |

The drain completed the in-flight work rather than abandoning it, so nothing
needed the shutdown-defer path. That path - where the drain window expires
before an attempt finishes, and the delivery is deferred with
`ReasonWorkerShutdown`, no attempt row and no retry budget spent - is covered by
`internal/worker/defer_test.go` and by the lease-keeper cancellation-cause test
in `internal/queue`, because reproducing it under load would mean an endpoint
slower than `DrainTimeout` and a 15s pause in every suite run.

Re-run this after any change to the drain ordering, the lease keeper, or the
cancellation cause. The number that matters is the zero on the `context
canceled` row: if it is ever non-zero, restarts are silently damaging customer
endpoint health.

## 8. Tuning knobs

Sizing (seed-time; re-seed after changing):

| variable | default | what it does |
| --- | --- | --- |
| `LOAD_FANOUT_ENDPOINTS` | 25 | endpoints one event fans out to |
| `LOAD_SLOW_ENDPOINTS` | 6 | slow endpoints in the isolation scenario |
| `LOAD_SLOW_CONTROL_ENDPOINTS` | 4 | fast endpoints alongside them |
| `LOAD_SLOW_MS` | 5000 | how long a slow endpoint takes |
| `LOAD_SLOW_MAX_CONCURRENCY` | 16 | their `max_concurrency` — see section 7 |
| `LOAD_TENANTS` | 5 | tenants, one of them noisy |
| `LOAD_LARGE_PAYLOAD_BYTES` | 98304 | must exceed `PAYLOAD_INLINE_MAX_BYTES` |
| `LOAD_SINK_PORTS` | 8 | destination hosts to spread endpoints over |

Run shape (run-time; no re-seed needed):

| variable | default | what it does |
| --- | --- | --- |
| `LOAD_DURATION` | 45 | seconds of publishing |
| `LOAD_DRAIN` | 90 | seconds the collector keeps draining afterwards |
| `LOAD_FANOUT_RATE` | 10 | events/s |
| `LOAD_FAST_RATE` | 20 | events/s to fast endpoints |
| `LOAD_SLOW_RATE` | 2 | events/s to slow endpoints |
| `LOAD_NOISY_RATE` | 15 | events/s from the noisy tenant |
| `LOAD_QUIET_RATE` | 3 | events/s per quiet tenant |
| `LOAD_SETTLE_TIMEOUT_MS` | 180000 | how long to wait for the backlog after k6 |

Targets: `LOAD_CONTROL_API`, `LOAD_INGEST_URL`, `LOAD_METRICS_URL`,
`LOAD_SINK_URL`, `LOAD_DATABASE_URL`.

## 9. Layout

```
tests/load/
  sink/sink.mjs           the configurable target, multi-port, shared stats
  lib/                    k6 modules (ES, no node builtins)
    manifest.js           what the seed created
    metrics.js            every custom metric, in one place
    publish.js            one event, and the payload it carries
    collector.js          drains the sink into k6 metrics
    options.js            scenario shapes and the shared thresholds
    summary.js            the PASS/FAIL report
  scenarios/              one file per scenario, each with its own thresholds
  scripts/
    run.mjs               seed -> quiesce -> k6 -> drain -> verify
    seed.mjs              creates everything through the real control API
    verify.mjs            the ledger check
    support/              env, control-API client, database, topology, metrics
  .artifacts/             manifests, summaries, API keys (gitignored)
```
