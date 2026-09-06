# Data plane handoff

Notes from the data plane to whoever owns the schema, the control API and the
later phases. Nothing here is actionable inside `services/data-plane` alone.

## Manifest comments to correct (owned by `deployments/`)

The Kubernetes manifests and Helm templates assert that "the readiness flag
flips to draining on SIGTERM". Until this change that was **false**: readiness
flipped only after the role loop unwound, i.e. after `ingest.Serve` had already
closed its listener and finished its 15s drain, so `/health/ready` answered 200
for the whole window while port 8080 refused connections - 502s on the write
path on every rolling update.

It is true now, but the manifests need two corrections:

1. The claim is only accurate because of `SHUTDOWN_READINESS_DELAY_MS`
   (default 5000). Readiness flips immediately on SIGTERM and the process
   **keeps accepting** for that window, so load balancers observe the not-ready
   state on an open socket. Set it to at least the ingress/kube-proxy
   convergence time. `0` drains immediately and reinstates the 502 window.
2. `terminationGracePeriodSeconds` must stay comfortably above
   `config.ShutdownGrace` (25s). The budget from SIGTERM to exit is
   readiness propagation (<=10s, default 5s) + longest role drain
   (`ingest.DrainTimeout`, 15s) + probe shutdown (the remainder, deadline-
   measured from the signal instant, so an overrunning role drain cannot push
   the total past 25s). Configuration refuses a readiness delay above
   `ShutdownGrace - ingest.DrainTimeout` = 10s.

## Schema requests (owned by `apps/control-api/prisma/schema.prisma`)

The data plane does not run DDL (ADR-0002). These are wanted, in rough order of
how much they will hurt if they are missing.

1. **`idempotency_keys` needs no new index** — `@@unique([projectId, key])`
   already backs both the ingest lookup and the `ON CONFLICT` claim. Noting it
   so nobody "optimises" it away: that unique index is the concurrency control,
   not just a constraint.

2. **`api_keys.key_hash`** is `@unique`, which gives the ingest lookup its
   index. The join to `projects` is on the primary key. No change needed; again,
   recorded because ingest authenticates on every request and this is the query.

3. **`events` wants an `ordering_key` column.** `Delivery` has one, `Event` does
   not, so the router has nowhere to read it from when it materialises the
   fan-out. Until it exists, ingest stores it in `events.headers` as
   `{"ordering_key": "..."}` (see `requestMetadata` in `internal/ingest`). That
   works, but it is a JSON lookup on a hot path and it hides a routing input
   inside a column named for something else. Requested:

   ```prisma
   orderingKey String? @map("ordering_key")
   ```

   When it lands, `requestMetadata` and `CreateEventParams` should move to it,
   and the router should read the column.

4. **Byte-exact payloads: resolved by `events.payload_raw` (bytea).**
   `events.payload` is jsonb, which normalises whitespace, key order and
   duplicate keys, so the bytes read back out of it are **not** the bytes
   received and a signature over them cannot verify (ARCHITECTURE.md 28).
   Before `payload_raw` existed, the two storage paths gave different
   guarantees for the same event depending only on its size: the S3 offload
   path preserved the bytes, the inline path did not.

   The data plane now writes both columns in the same INSERT
   (`insertEventSQL` in `internal/ingest/store.go`):

   - `payload_raw` - the exact request bytes. **AUTHORITATIVE.** Signing and
     delivery read this column and nothing else.
   - `payload` - the jsonb projection, for filtering, search and the operator
     UI. Never sign it, never deliver it.
   - `payload_hash` - SHA-256 of `payload_raw`, so the invariant is checkable:
     `HashPayload(payload_raw) == payload_hash`. That is asserted against a
     real database in `TestPostgresCreateEventPreservesRawPayloadBytes`
     (`internal/ingest/store_postgres_test.go`, skipped without
     `DATABASE_URL`).

   Both columns are NULL when the payload was offloaded; `payload_location`
   points at the object, whose bytes are also exact.

5. **Retention sweep for `idempotency_keys`.** Ingest takes over an expired row
   in place, so nothing breaks without a sweep, but rows for keys that are never
   reused accumulate forever. `@@index([expiresAt])` already exists for it.

6. **`deliveries_ready_idx` must include `'processing'` in its partial
   predicate.** ADR-0007 specifies:

   ```sql
   WHERE status IN ('pending', 'scheduled', 'queued', 'retrying')
   ```

   and argues `locked_until` need not be indexed because "a leased row has
   `status = 'processing'` and is therefore outside the partial predicate".
   That reasoning was built on a claim query that could not reclaim expired
   leases, which was a bug (fixed: `claimStatuses` in `internal/queue`). The
   claim now includes `'processing'`, so a row abandoned by a dead worker
   would fall **outside** that index and the indexed claim path would not find
   it cheaply. Please create it as:

   ```sql
   CREATE INDEX CONCURRENTLY deliveries_ready_idx
       ON deliveries (organization_id, project_id, next_attempt_at, created_at)
    WHERE status IN ('pending', 'scheduled', 'queued', 'retrying', 'processing');
   ```

   The index gets slightly larger (it now also holds currently-leased rows,
   bounded by in-flight concurrency, not by backlog). Until this lands, the
   scheduler's `ReclaimExpired` sweep is the *efficient* route back into the
   ready set rather than a redundant one - which is why its doc comment no
   longer calls it cosmetic.

7. **`deliveries.next_attempt_at` NOT NULL, defaulted to `created_at`**, as
   ADR-0007 asks. Every ready-set predicate in `internal/queue` still carries
   `(next_attempt_at IS NULL OR next_attempt_at <= now())` and every ordering
   still carries `NULLS FIRST` to work around it. `readyPredicate` in
   `internal/queue/postgres.go` is the single place that collapses when the
   column becomes NOT NULL.

## Object storage reconciliation: orphaned payloads (owned by whoever runs the bucket)

`PlanPayload` uploads an offloaded payload to `s3://<bucket>/<project>/<event>`
**before** the ingest transaction, because the object key contains the event ID
and the event row carries the location. If `CreateEvent` then reports
`created=false` (a lost idempotency race) or fails, the object is already
written and no `events` row will ever reference it. Nothing reclaims it today,
so the cost leaks: one orphaned object per lost race, forever.

Restructuring so the upload happens only after the claim is won is not free -
the claim and the event insert are one transaction on purpose (an idempotency
row that points at an event which was never written is worse than an orphan),
and holding that transaction open across an S3 round trip is exactly the thing
ARCHITECTURE.md forbids. So this is a reconciliation requirement, not an
ingest bug:

- **Preferred:** an object lifecycle rule on the payload prefix, plus a
  sweep that deletes objects older than the idempotency window with no
  matching `events.payload_location`. The event ID is in the key, so the sweep
  is a single indexed lookup per candidate.
- The sweep must never delete an object younger than the ingest deadline
  (`INGEST_DB_TIMEOUT_MS`, default 5s) plus a margin, or it will race a
  request that is between the upload and its COMMIT.

Until one of those exists, the leak is bounded only by how often two requests
with the same idempotency key race.

## Timeouts on the ingest hot path

`http.Server.WriteTimeout` does **not** cancel `r.Context()` - it only sets a
write deadline - and `r.Context()` is cancelled solely on client disconnect.
pgxpool has no default statement timeout either. So the accept pipeline imposes
its own deadline, and the pool sets one server side:

| Setting | Default | What it stops |
|---|---|---|
| `INGEST_DB_TIMEOUT_MS` | 5000 | One accept's database work, `FindAPIKey` through `CreateEvent`. Without it a lock wait pins a goroutine and a pool connection per request until the pool is exhausted, after which new requests block in `Acquire` with no deadline of their own and shutdown cannot drain. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30000 | Server-side backstop, set per connection via `AfterConnect` in `internal/db`. Catches the paths that forget a context deadline. |

Configuration refuses a statement timeout below the ingest deadline: the
backstop firing first would mask the request deadline. Note the interaction
with PgBouncer in transaction mode - `AfterConnect` runs `SET
statement_timeout` on the server connection, so a statement-pooling deployment
should set it on the database role instead and pass `0` here.

## Recorded, not fixed: `idempotency_keys.expires_at` has no time zone

The column is `TIMESTAMP(3)` without time zone. Go writes it from `time.Now()`
and pgx discards the location, while the claim's `WHERE
idempotency_keys.expires_at <= now()` compares against PostgreSQL's clock.
In the distroless image `time.Local` is UTC and the drift is zero, but a
non-UTC host skews the effective TTL by that host's UTC offset - a 24h window
becomes 23h or 25h. The fix is `@db.Timestamptz` on the column (schema owner),
or writing `time.Now().UTC()`; either alone is enough. Not urgent, and not
worth a schema change on its own.

## Claim strategy: CLAIM_STRATEGY defaults to `fifo`, inverting ADR-0007

ADR-0007 states that `Claim` "stops being FIFO" and keeps FIFO only as a
fallback. **The implementation ships with the opposite default, deliberately.**
Both strategies are fully implemented in `internal/queue/postgres.go`; the ADR's
lateral/tenant-snapshot path is one env var away (`CLAIM_STRATEGY=tenant_fair`,
aliases `tenant-fair` and `lateral`), and it is covered by integration tests for
both the burst-monopoly case and the lone-tenant case.

The default is `fifo` because:

- **Nothing has been measured.** Every number in ADR-0007's option (a) analysis
  is explicitly an estimate awaiting the Phase 3 load test. Choosing the complex
  plan on estimates is the thing engineering rule 23 forbids.
- **The prerequisite migration has not been applied.** Neither
  `deliveries_ready_idx` nor the NOT NULL change exists. Without the partial
  index the tenant-snapshot recursive CTE has no loose index scan to ride, which
  is exactly the "full scan of the ready set on every poll" the ADR says must
  not be used.
- **ARCHITECTURE.md 2565** requires the simplest production-grade option that
  preserves the architecture. FIFO behind the `queue.Queue` seam preserves it;
  the ADR itself keeps the FIFO statement shippable for this reason.
- **A recursive CTE plus a lateral is not readable at 2am**, which the ADR
  concedes under "What this costs".

**Promotion criterion, so this is not left to taste:** flip the default when
`queue_head_of_line_delay_seconds` shows starvation - a p99 that tracks a
tenant's burst drain time while p50 stays flat - on a deployment with more than
one active tenant, *after* `deliveries_ready_idx` exists. Record the
`EXPLAIN (ANALYZE, BUFFERS)` for both statements in
`docs/design/scale-and-partitioning.md` at the same time, as the ADR requires.

The ADR has **not** been edited; this note is the deviation record.

## Metrics added for ADR-0007

In `internal/metrics`, all free of per-tenant or per-entity labels:

| Metric | Kind | Notes |
|---|---|---|
| `queue_head_of_line_delay_seconds` | histogram | The fairness SLI. `now() - next_attempt_at` computed **by PostgreSQL at claim time**, so it carries no app/DB clock skew. Scheduling delay only; excludes the attempt. |
| `queue_claim_duration_seconds{strategy}` | histogram | Proves the single-tenant tenant-fair case is free. |
| `queue_claim_batch_size{strategy}` | histogram | Saturation vs. poll-interval-bound. |
| `queue_claim_tenants` | histogram | K. Zero for a FIFO claim. |
| `queue_leases_reclaimed_total` | counter | Scheduler sweep. Sustained non-zero means workers die mid-attempt. |
| `queue_leases_lost_total{operation}` | counter | Attempts abandoned to avoid a duplicate delivery. |

The only label anywhere is `strategy` (two values) and `operation` (two values).

## Contract change in `internal/queue` (Phase 3 must honour it)

`Queue.Renew` now returns the delivery IDs it could **not** renew, and
`Queue.Release` returns `queue.ErrLeaseLost` when the lease was already gone. A
worker that ignores either signal will deliver a webhook twice and let two
processes race over the delivery's terminal status.

`queue.LeaseKeeper` is the wiring for this and is already constructed in
`runWorker`. Every Phase 3 attempt must run under the context from
`keeper.Track(...)`: when the lease is lost that context is cancelled with cause
`queue.ErrLeaseLost`, and **no `delivery_attempts` row and no status transition
may be written for that delivery**. Check `context.Cause(ctx)` to tell a lost
lease from an endpoint timeout.

## Conventions this package established

- **API key format**: `wk_live_<random>` / `wk_test_<random>`.
  `api_keys.key_hash` is the **lowercase hex SHA-256 of the full plaintext
  key**; `key_prefix` is its first 12 characters. The control API's key
  generator must match `HashKey`/`KeyPrefix` in `internal/ingest/apikey.go` or
  no key will ever authenticate. There is a known-vector test guarding the
  hash, so a change on either side fails loudly.
- **Key environment must equal project environment.** A `wk_test_` key against
  a `live` project is `403 forbidden`.
- **A key for another project is `404 not_found`**, never `403`: confirming that
  someone else's project exists is itself a disclosure.
- **Request ID prefix `req_`** is generated per request, returned in
  `X-Request-Id` and in every error body.

## Deliberate stubs, for phase 3

- `runWorker` deliberately does **not** claim. The previous stub claimed 100
  rows every 250ms and released them without advancing `next_attempt_at`, so it
  re-claimed the same rows forever: ~800 UPDATEs/sec of dead tuples against an
  idle database and an operator UI in which every delivery looked freshly
  touched. Phase 3 replaces the wait with the real loop; do not reinstate a
  claim without a dispatcher behind it.
- `ingest.RateLimiter` — `AllowAll` today. The real one is the Redis token
  bucket (ARCHITECTURE.md 25). It must **fail open**: `internal/ingest` already
  logs a limiter fault and admits the request, and there is a test pinning that
  behaviour.
- `ingest.PayloadStore` — `NewUnconfiguredPayloadStore()` today, which refuses
  every write. Consequence worth knowing before someone debugs it in
  production: **with `S3_BUCKET` unset, the effective maximum event size is
  `PAYLOAD_INLINE_MAX_BYTES`, not `PAYLOAD_MAX_BYTES`**, and a payload above it
  is rejected `413 payload_too_large` with a message saying exactly that. The
  ingest role logs a warning at startup when the bucket is unset.
- `idempotency_keys` TTL is a constant (`DefaultIdempotencyTTL`, 24h), not
  configuration. Promote it to an env var if a customer needs a longer window.
