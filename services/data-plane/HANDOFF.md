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

   *Landed* as `deliveries_ready_idx` in `20260907000000` with exactly that
   predicate, and *rebuilt* under the same name by `20260911000000` (item 7)
   as `(organization_id, project_id, next_attempt_at, created_at, id)` - no
   `NULLS FIRST`, `id` appended - once the column became NOT NULL.

7. **`deliveries.next_attempt_at` NOT NULL** (ADR-0007) — **RESOLVED** by
   `20260911000000_next_attempt_at_not_null`, applied to `hookubit` (10 legacy
   NULL rows backfilled to `created_at`, 0 remain) and `hookubit_test`.

   *Why it mattered, kept for the record because "make a column NOT NULL"
   reads like tidying and was not.* The claim used to order by
   `next_attempt_at NULLS FIRST`, so NULL was not a neutral value: it sorted
   **ahead of every due retry**. One code path writing a NULL silently promoted
   that row to the front of the queue and nothing failed - the symptom was a
   retry starving until `max_retry_duration` and being reported to the
   customer as their endpoint failing when the platform never re-attempted it.
   NOT NULL turns that into a constraint violation at the moment the mistake is
   made.

   *What the migration does.* Backfill `next_attempt_at = created_at` for
   legacy NULLs; `ADD CONSTRAINT ... CHECK (next_attempt_at IS NOT NULL) NOT
   VALID`, `VALIDATE`, `SET NOT NULL`, drop the check; `SET DEFAULT
   CURRENT_TIMESTAMP` (now() under the spelling Prisma emits for
   `@default(now())`, so the default is not drift). Every step is idempotent
   and the NOT NULL block is skipped when the column already is, so the
   header's hand-run recipe for a large installation (separate transactions,
   `CONCURRENTLY` index builds) leaves the migration a no-op. Prisma side:
   `nextAttemptAt DateTime @default(now())`.

   *It also rebuilt both ready-set indexes* (same names, same predicate) as
   `(organization_id, project_id, next_attempt_at, created_at, id)` and
   `(next_attempt_at, created_at, id)`: no `NULLS FIRST`, because the claim's
   ORDER BY dropped it and the planner matches an index to an ORDER BY on the
   nulls direction - measured before the rebuild, a plain `ORDER BY
   next_attempt_at, created_at, id` against the NULLS FIRST index planned as
   Index Scan -> **Sort** -> LockRows -> Limit; and `id` appended so the
   tiebreaker the claim statements gained the same day is served by the index
   instead of an Incremental Sort that has to read a whole fan-out's tie group
   before emitting the first row. `TestClaimStatementsCanUseTheReadySetIndexes`
   in `internal/queue` pins all three claim-path statements to their index with
   no sort node, under real statistics (400 ready rows, ANALYZEd inside the
   rolled-back EXPLAIN transaction - on a two-row table the costs tie and the
   planner picks a Bitmap scan or Prisma's `(project_id, created_at)` index by
   coin toss). `deployments/ci/expected-schema-drift.txt` still holds.

   *The Go side collapsed with it.* `readyPredicate` is a plain range
   predicate, `claimedColumns` reads `next_attempt_at` directly, every ORDER BY
   lost `NULLS FIRST`, and `queueDepthSQL` in `internal/metrics` matches. The
   terminal-transition write in `advanceSQL` still writes `now()` - a terminal
   row carries a `next_attempt_at` with no scheduling meaning, because
   `claimStatuses` keeps it out of the ready set whatever the timestamp says -
   and `TestStoreCompleteMarksTerminalStates` / `TestTerminalDeliveriesAreNeverClaimed`
   still prove both halves.

   **DEPLOY ORDERING - carried forward because it is not interchangeable and
   nothing is deployed anywhere yet.** The data-plane binary whose `advanceSQL`
   writes `now()` on the terminal branch **must be live everywhere before the
   constraint is applied**. Apply the constraint first and every terminal
   transition still in flight from an older worker - including successful
   deliveries - fails its UPDATE, the transaction rolls back, the
   `delivery_attempts` row goes with it, and the delivery stays `processing`
   until its lease expires and it is retried against an endpoint that has
   already received it. So, in the first environment where the planes roll
   separately:

   1. Deploy the data plane (workers, scheduler, router) at this revision.
   2. Confirm no older worker is still running.
   3. Run the backfill - idempotent, run it as often as you like.
   4. Apply the rest of the migration.

   Rolling the binary back after the constraint is applied has the same
   failure mode, so `ALTER COLUMN next_attempt_at DROP NOT NULL` must precede
   any rollback past this revision. The migration's header says all of this
   too.

   **Done on the dashboard side** (was: still open): the "Next attempt" cell in
   `DeliveryDetailPage.tsx` and `EventDetailPage.tsx` used to render
   `next_attempt_at ? formatRelativeTime(...) : '—'` ungated on status, so a
   succeeded delivery would have read "2 minutes ago" once the column became
   NOT NULL. Both now gate on a non-terminal status
   (`features/deliveries/next-attempt.ts`); a terminal delivery reads "None". The API contract is unchanged
   (`next_attempt_at` stays `string | null` on the wire; its description now
   says it is always set and to read it with `terminal`).

## Object storage reconciliation: orphaned payloads — RESOLVED

`PlanPayload` uploads an offloaded payload to
`s3://<bucket>/<prefix>/<project_id>/<event_id>` **before** the ingest
transaction, because the key contains the event ID and the row carries the
location, and because holding that transaction open across an S3 round trip is
what ARCHITECTURE.md forbids on the hot path. That window is now closed from
both ends rather than accepted as a leak.

1. **Compensating delete, in-request** (`ingest.DisposeOrphan`). Every path
   where ingest KNOWS no `events` row was written — a lost idempotency race, a
   failure before the INSERT — deletes the object it just uploaded. That was
   the recorded cause ("one orphaned object per lost race, forever") and it now
   costs one DELETE in the same request.

   It is deliberately **not** done when `CreateEvent` returns an error: a COMMIT
   that timed out may still have landed, and deleting then destroys a live
   event's payload. Leaking an object is recoverable; that is not. Pinned by
   `TestAmbiguousPersistFailureLeavesTheObjectAlone`.

2. **A sweep for the residue** (`payloadstore.Store.Reconcile`, run hourly by
   the scheduler role). What (1) cannot cover is the process dying between the
   PUT and the COMMIT. The sweep lists the prefix, derives each object's age
   **from its key** — the event ID is a ULID, so no HEAD request is needed — and
   deletes only what no `events` row references.

A bucket lifecycle rule was considered and rejected as the primary mechanism:
orphans and live payloads share a prefix and are indistinguishable by age alone,
so any expiry broad enough to catch orphans also deletes payloads events still
point at. One remains useful *after* event retention, not instead of this.

The sweep is timid on purpose, because its failure mode is deleting customer
data:

| Guard | Effect |
|---|---|
| `ParseKey` | only keys of the exact shape this package writes are candidates |
| `PAYLOAD_SWEEP_MIN_AGE_MS` (24h, floored at 1h) | never touches an object young enough to belong to a request mid-COMMIT |
| object `LastModified` | corroborates the key's age; whichever is younger wins |
| lookup error | skips the object, never deletes it |
| `PAYLOAD_SWEEP_MAX_DELETES` (1000) | one run cannot cascade |

Concurrent sweeps across replicas need no lease: deleting an already-deleted key
succeeds.

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
- `ingest.PayloadStore` — now `payloadstore.Store` (AWS SDK v2, S3-compatible,
  path-style for MinIO) whenever `S3_BUCKET` is set. With `S3_BUCKET` **unset**
  it is still `NewUnconfiguredPayloadStore()`, and the consequence is unchanged
  and worth knowing before someone debugs it in production: **the effective
  maximum event size is `PAYLOAD_INLINE_MAX_BYTES`, not `PAYLOAD_MAX_BYTES`**,
  and a payload above it is rejected `413 payload_too_large` with a message
  saying exactly that. The ingest role logs a warning at startup when the
  bucket is unset.
- `idempotency_keys` TTL is a constant (`DefaultIdempotencyTTL`, 24h), not
  configuration. Promote it to an env var if a customer needs a longer window.

---

# Event router (`internal/router`) — wiring, requests, and what is left

Owned by the router branch. Everything below is actionable outside
`internal/router` and needs someone else to apply it.

## 1. Wire `runRouter` (owned by `cmd/webhookd/roles.go`)

`runRouter` currently ticks and sets `metrics.OutboxLag` to a hard-coded zero.
Replace the whole body with:

```go
func runRouter(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) error {
	r, err := router.New(router.Options{
		Store:       router.NewPostgresStore(pool),
		RouterID:    instanceID, // MUST be unique per process - it is the lease owner
		Logger:      log,
		BatchSize:   cfg.OutboxBatchSize,
		Concurrency: cfg.RouterConcurrency,       // see 2 below; router.DefaultConcurrency (4) until it exists
		Lease:       cfg.RouterLease,             // see 2 below; router.DefaultLease (60s) until it exists
		MaxSubscriptionsPerEvent: cfg.MaxSubscriptionsPerEvent, // see 2; default 2000
		MaxOutboxAttempts:        cfg.MaxOutboxAttempts,        // see 2; default 5
	})
	if err != nil {
		return err
	}
	return r.Run(ctx, cfg.OutboxPollInterval)
}
```

Two things that are not optional:

- **`RouterID` must be unique per process.** It is the value written to
  `event_outbox.locked_by`, and every write the router makes is guarded on
  still owning that value. Two processes sharing an id can retire each other's
  rows. `runAll` already threads an `instanceID` through to `runWorker`; pass
  the same one here (or `instanceID + "-router"`). `router.New` refuses an empty
  id rather than defaulting to something plausible.
- **`Concurrency` consumes pooled connections.** Each in-flight fan-out holds
  one connection for the length of its transaction. Keep
  `RouterConcurrency + WorkerConcurrency` comfortably below
  `DATABASE_MAX_CONNECTIONS`, or a busy router starves the delivery loop of
  connections and the failure looks like slow deliveries, not a config error.

`runAll` needs no change beyond that — the role already exists in its map.

There is also `RunOnce(ctx) (int, error)` if you want eager draining: keep
calling it while it returns `BatchSize` instead of waiting a tick per batch.
`Run` deliberately does not do this, so a backlog cannot monopolise the process.

## 2. Configuration (owned by `internal/config/config.go`)

`OutboxBatchSize` and `OutboxPollInterval` already exist and are used. Four
knobs have package defaults today and should become environment variables:

| Env var | Default | What it bounds |
| --- | --- | --- |
| `ROUTER_CONCURRENCY` | 4 | Events fanned out at once. One pooled connection each. |
| `ROUTER_LEASE_SECONDS` | 60 | How long a claimed outbox row is unavailable after a router dies. Must exceed the worst-case fan-out transaction, not the poll interval. |
| `MAX_SUBSCRIPTIONS_PER_EVENT` | 2000 | Subscriptions examined **and** deliveries created for one event. |
| `MAX_OUTBOX_ATTEMPTS` | 5 | The poison bound. Claims before a row is parked. |

Suggested validation, in the same style as the existing rules:

- `ROUTER_CONCURRENCY` must be positive.
- `ROUTER_CONCURRENCY + WORKER_CONCURRENCY <= DATABASE_MAX_CONNECTIONS - 2`
  (headroom for probes and the claim itself). This one has teeth: without it the
  first busy day looks like a delivery-latency incident.
- `ROUTER_LEASE_SECONDS` must be greater than `DATABASE_STATEMENT_TIMEOUT_MS`,
  or a transaction can outlive its own lease and lose the row mid-flight.

## 3. Metrics (owned by `internal/metrics`)

Six instruments are declared in `internal/router/metrics.go` rather than in
`internal/metrics`, purely to keep the router and worker branches off the same
file while both were being written. They register against the same default
registry, so `/metrics` is already correct. **Please move them into
`internal/metrics` verbatim once both branches land** — the split is an artefact
of the merge, not a design:

`router_outbox_claimed_total`, `router_events_routed_total{outcome}`,
`router_fan_out_size`, `router_subscriptions_skipped_total{reason}`,
`router_outbox_parked_total{reason}`, `router_route_duration_seconds`.

The existing `deliveries_created_total` and `outbox_pending_age_seconds` are
driven by the router as specified; nothing about them changed.

**The two to alert on.** `router_outbox_parked_total` at any non-zero rate is an
event that will never be delivered without a human replaying it.
`router_subscriptions_skipped_total{reason="fan_out_cap_exceeded"}` means
endpoints were silently left out of a fan-out.

## 4. Schema and index requests (owned by `apps/control-api/prisma`)

1. **`event_outbox` wants a partial claim index.** The claim orders by
   `(available_at, created_at)` over a two-status ready set;
   `event_outbox_status_available_at_idx` covers the status/available_at
   predicate but the whole index is scanned for the `MIN(available_at)` lag
   query and the ordering tiebreak is not covered. Requested:

   ```sql
   CREATE INDEX CONCURRENTLY event_outbox_ready_idx
       ON event_outbox (available_at, created_at)
    WHERE status IN ('pending', 'processing');
   ```

   Note the predicate includes `processing`, for the same reason ADR-0007's
   `deliveries_ready_idx` must (item 6 above): a leased row is `processing`, and
   a crashed router's rows have to be reclaimable *cheaply*, not just possible
   to reclaim.

2. **`deliveries_event_endpoint_original_key` must not be "cleaned up".**
   `prisma migrate diff` reports the partial unique index as drift because
   schema.prisma cannot express a partial index. It is the ON CONFLICT arbiter
   for the entire fan-out. Regenerating the migration without it does not
   produce an error — it produces duplicate deliveries after any router restart.
   The migration file already says so; repeating it here because that is the
   file someone will "fix".

3. **`events.ordering_key` exists but ingest does not write it.** The router
   reads `COALESCE(events.ordering_key, events.headers->>'ordering_key')`, so
   both work today. When `internal/ingest` moves to the column (item 3 in the
   schema-requests section above), the COALESCE can be dropped — it is one line
   in `loadEventSQL`.

4. **`event_outbox` needs a retention sweep.** Rows retire to `processed` (or
   `failed`, when parked) with `processed_at` set, and nothing deletes them.
   `DELETE FROM event_outbox WHERE status = 'processed' AND processed_at < now() - interval '7 days'`
   is the shape. `failed` rows should NOT be swept automatically; they are the
   parking bay and an operator has to see them.

## 5. Operator surface that does not exist yet (owned by the control API)

Parking a poisoned outbox row is only half a recovery story. There is currently
no way to un-park one. The control plane needs an endpoint that sets a `failed`
outbox row back to `pending` with `attempts = 0`; re-running it is safe by
construction (see below). Until that exists, recovery is a manual `UPDATE`, and
"a human needs psql to answer that" is the thing this product is supposed to
avoid.

## 6. Decisions taken, so they can be argued with

- **A `paused` endpoint is skipped, not buffered.** Deliveries are created only
  for `status = 'active' AND enabled = true`. Buffering into a paused endpoint
  would materialise rows every worker poll claims and immediately puts back —
  the dead-tuple churn the worker stub's comment already warns about — and would
  make queue depth meaningless. The cost: an event published while an endpoint
  is paused is never delivered to it, and recovering it needs a replay. This is
  a product decision. If buffering is wanted, the change is one line in
  `gate()`, plus a worker that understands "queued but not runnable".
- **Subscriptions are loaded unfiltered and gated in Go.** The query could
  filter on enabled/status and return fewer rows. It deliberately does not,
  because "no subscription matched this event type" and "every subscription in
  this project is disabled" are different answers to the same 2am question, and
  `router_subscriptions_skipped_total{reason}` can only distinguish them if the
  rejected rows are seen. Bounded by `MAX_SUBSCRIPTIONS_PER_EVENT`.
- **Two subscriptions on one endpoint produce ONE delivery.** The uniqueness
  arbiter is `(event_id, endpoint_id)`, not subscription id. The plan
  deduplicates explicitly (lowest subscription id wins, so the oldest
  subscription is recorded) rather than letting `ON CONFLICT DO NOTHING` swallow
  the second row, so the created count means what it says.
- **The fan-out cap truncates rather than fails.** Over the cap, the oldest
  subscriptions are served and the rest are dropped with an `ERROR` log naming
  the project and the remedy. Partial delivery beats none; silence would be the
  bug.

## 7. Failure cases, and what each one does

| Scenario | Behaviour |
| --- | --- |
| Crash before commit | Nothing written. The lease lapses; the row is reclaimable because `processing` is in the claim's status set. |
| Crash after inserting deliveries, before retiring the outbox row | **Cannot happen**: the inserts, the event transition and the outbox retirement are one transaction. The equivalent — the row being replayed later — inserts nothing, arbitrated by the partial unique index. |
| Lease stolen mid-transaction | `markOutboxProcessedSQL` is guarded on `locked_by`; zero rows affected rolls the whole transaction back, deliveries included. Verified in `TestPostgresRouteRollsBackEverythingWhenTheLeaseIsLost`. |
| Subscription → soft-deleted or disabled endpoint | Skipped, counted under `endpoint_not_active` / `endpoint_disabled`. |
| Endpoint whose project or organisation is soft-deleted | Skipped, counted under `project_not_active` / `organization_not_active`. The event is still marked `processed` and the outbox row still leaves the queue. |
| Subscription pointing across a tenant boundary | Skipped as `tenant_mismatch`, checked before every other gate. The tenant columns come from the endpoint's own project/organisation, never from the event. |
| Outbox row whose event was deleted | Parked with reason `event_missing`. Unreachable through the FK (it cascades), handled because a retention job that bypasses it would otherwise wedge the queue. |
| Poisoned row | `attempts` is incremented by the **committed claim**, not on the failure path, so a row that kills the process still counts. Over `MAX_OUTBOX_ATTEMPTS` it is parked as `failed` with a recorded reason and never claimed again. |
| Transient database failure mid-fan-out | Row released back to `pending` with an exponential backoff (1s → 60s) and `last_error` recorded. |
| Zero matching subscriptions | Normal. Event `processed`, outbox row `processed`, logged at INFO with the skip breakdown, `router_events_routed_total{outcome="no_subscriptions"}`. |

## 8. Tests, and what was not run

`go vet`, `go build`, `go test -race`, `gofmt` are clean for
`./internal/router/...`. `go vet ./...` currently fails in `internal/worker`
(`undefined: HealthStore`), which is the concurrently-developed worker branch,
not this one.

The DB-dependent tests in `internal/router/store_postgres_test.go` are written
and compile but **have not been executed**: no migrated database was reachable
from this environment (`DATABASE_URL` unset; the local 5432 is a different
instance). Run them with:

```
cd services/data-plane
DATABASE_URL=postgresql://webhook:webhook@localhost:5432/webhook_platform go test -race -count=1 ./internal/router/
```

They assert the properties that cannot be unit-tested: that a re-run inserts
nothing, that a lost lease rolls back the deliveries too, that the partial
unique index rejects a second original row but permits a replay row, that an
expired lease is reclaimable and a live one is not, and that a parked row never
returns to the ready set.

Two SQL details in `insertDeliveriesSQL` are the most likely place a first run
against a real database will complain, and both are deliberate: the explicit
`'pending'::"DeliveryStatus"` cast (an `INSERT ... SELECT` resolves unknown
literals to `text` before it sees the target column, and there is no assignment
cast from text to an enum), and the `WHERE replay_of_delivery_id IS NULL`
repeated in the conflict target (PostgreSQL only infers a partial index when the
statement restates its predicate).

---

# Delivery worker (`internal/worker`) — wiring, crypto interop, and what is left

The stage that actually sends webhooks. It claims a lease, loads the endpoint
and the event's raw bytes, checks the breaker and the rate limit, signs with
every active secret, delivers through `internal/egress`, appends a
`delivery_attempts` row and advances the delivery state machine — all under the
lease, and all in one transaction at the end.

## 1. Wire `runWorker` (owned by `cmd/webhookd/roles.go`)

Replace the Phase 3 stub body with this. It is the whole wiring; nothing else in
`cmd/` changes.

```go
func runWorker(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger, workerID string) error {
	guard, err := egress.NewGuard(cfg.EgressAllowPrivateNetworks, cfg.EgressPrivateAllowlist)
	if err != nil {
		return fmt.Errorf("build egress guard: %w", err)
	}
	client := egress.NewClient(guard, egress.Limits{
		DNSTimeout:            cfg.EgressDNSTimeout,
		ConnectTimeout:        cfg.EgressConnectTimeout,
		TLSHandshakeTimeout:   cfg.EgressTLSTimeout,
		ResponseHeaderTimeout: cfg.EgressResponseHeaderTimeout,
		TotalTimeout:          cfg.EgressTotalTimeout,
		MaxResponseBytes:      cfg.EgressMaxResponseBytes,
		MaxRedirects:          cfg.EgressMaxRedirects,
		IdleConnsPerHost:      4,
	})

	// Same three env vars the control plane reads. See section 2 - these are
	// NOT yet fields on config.Config.
	keyring, err := worker.ParseKeyring(
		os.Getenv("ENCRYPTION_KEY"),
		os.Getenv("ENCRYPTION_KEY_ID"),
		os.Getenv("ENCRYPTION_KEYS_RETIRED"),
	)
	if err != nil {
		return fmt.Errorf("build encryption keyring: %w", err)
	}

	store := worker.NewPostgresStore(pool)
	w, err := worker.New(worker.Options{
		Queue:        newQueue(cfg, pool, log),
		Store:        store,
		Health:       store,
		Client:       client,
		Keyring:      keyring,
		WorkerID:     workerID,
		Concurrency:  cfg.WorkerConcurrency,
		ClaimBatch:   cfg.WorkerClaimBatch,
		PollInterval: cfg.WorkerPollInterval,
		Lease:        cfg.DeliveryLease,
		DBTimeout:    cfg.IngestDBTimeout, // see section 2: it wants its own knob
		Logger:       log,
		Limits: worker.GateLimits{
			Global:   cfg.MaxConcurrencyGlobal,
			Org:      cfg.MaxConcurrencyPerOrg,
			Project:  cfg.MaxConcurrencyProject,
			Endpoint: cfg.MaxConcurrencyEndpoint,
		},
	})
	if err != nil {
		return err
	}
	return w.Run(ctx)
}
```

Notes on the wiring:

- **The worker owns its `LeaseKeeper` now.** Delete the one `runWorker`
  currently constructs; `worker.New` builds it (or accepts one via
  `Options.Keeper`) and runs it on a context that outlives `ctx`, so leases keep
  being renewed *during* the shutdown drain. Two keepers renewing the same
  worker id would be harmless but pointless.
- `Options.Limiter` defaults to an in-process token bucket. When the Redis
  limiter exists, pass it here; it must fail open (section 4).
- `Options.Breaker` is a `BreakerConfig`; the zero value takes
  `DefaultBreakerConfig()` (degraded at 3 consecutive failures, open at 5, 30s
  cooldown doubling to a 10m cap, one successful probe closes it).
- Imports to add in `roles.go`: `os`, `fmt`, `internal/egress`,
  `internal/worker`.

## 2. Configuration requests (owned by `internal/config/config.go`)

None of these block the wiring above; all of them make it tidier.

| Env var | Why |
|---|---|
| `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_RETIRED` | The worker reads them from `os.Getenv` today. They belong on `Config`, and `Load()` should call `worker.ParseKeyring` so a bad key is a startup failure with every other config problem, not a per-delivery signing error at 3am. **`ENCRYPTION_KEY` should be `require()`d for the worker role**: without it every delivery fails closed. Only `ENCRYPTION_KEY` is in `.env.example`; the other two default to `k1` and empty, matching `crypto.service.ts`. |
| `WORKER_DB_TIMEOUT_MS` | The worker currently borrows `IngestDBTimeout`. They are different hot paths with different shapes. |
| `BREAKER_*` (`OPEN_THRESHOLD`, `DEGRADED_THRESHOLD`, `BASE_COOLDOWN_MS`, `MAX_COOLDOWN_MS`, `HALF_OPEN_SUCCESSES`) | Hard-coded defaults today. They are the numbers an operator will want to change first, per ARCHITECTURE.md 26's "rate-limit values should be configurable" applied to the breaker. |
| `WORKER_MAX_STORED_RESPONSE_BYTES` | Defaults to 8 KiB. The egress client already caps what is *read* (64 KiB); this caps what is kept forever in `delivery_attempts.response_body`. |

`config.Load` should also reject `MAX_CONCURRENCY_PER_ENDPOINT > WORKER_CONCURRENCY`
for the same reason it already rejects endpoint > project: a per-endpoint
ceiling above the pool size is not a ceiling.

## 3. Cross-language crypto interop — STATUS: VERIFIED against real TS output

This was called out as the most likely thing to be silently wrong, so here is
exactly what was done and exactly what it proves.

**The fixture is generated by the control plane's own compiled `CryptoService`**
(`apps/control-api/dist/common/crypto.service.js` — the file NestJS actually
loads), not reconstructed from reading the TypeScript. The generator is
`internal/worker/testdata/generate_crypto_fixture.js`; the captured envelopes
are `internal/worker/testdata/crypto_interop.json`; `crypto_interop_test.go`
decrypts them with the Go implementation and asserts the plaintexts.

It covers three vectors: one under the primary key id, one under a *retired* key
id (so keyring lookup is exercised, not just the happy key), and one for a
second endpoint. `TestDecryptsTypeScriptEnvelopes` passes.

Pinned in both directions:

- AAD is `` `${table}:${id}:${owner}` `` UTF-8, asserted byte for byte, and
  asserted negatively: a ciphertext moved to another `endpoint_secrets.id` and
  a row re-pointed at another `endpoint_id` both fail to authenticate.
- The four-part legacy envelope is rejected. The control plane deleted that
  branch because it decrypted with the row binding switched off; if anyone
  reinstates it there, this test fails here.
- An unknown key id names the kid and never the key material.
- Node writes base64url unpadded; the Go decoder accepts padded and unpadded,
  and standard or URL-safe alphabets for the key itself, matching Node's
  permissive `Buffer.from`.

**Regenerate the fixture after any change to `crypto.service.ts`:**

```sh
cd apps/control-api && pnpm build
node services/data-plane/internal/worker/testdata/generate_crypto_fixture.js \
  > services/data-plane/internal/worker/testdata/crypto_interop.json
```

**The one gap:** the fixture was produced from `dist/`, which was already built
in this checkout. It matches `src/common/crypto.service.ts` as it stands
(verified by reading both), but nobody has yet decrypted a secret that the
*running* control API wrote into a *real* `endpoint_secrets` row. That is the
last mile, and it is one command once a database exists:

```sh
# create an endpoint via the control API, then:
DATABASE_URL=... ENCRYPTION_KEY=<the same key the control API runs with> \
  go test ./internal/worker/ -run TestStoreLoad -v
```
followed by an end-to-end delivery, whose success proves the decrypt. Until
that has been done once, treat "the control API and the worker share a key
correctly" as verified in the algorithm and unverified in the deployment.

## 4. Deliberate seams and their honest limits

- **`RateLimiter` is per PROCESS.** `TokenBucket` gives one endpoint `limit`
  tokens per window *per worker*, so eight workers mean up to eight times the
  configured rate at the endpoint. The interface exists so the Redis token
  bucket (ARCHITECTURE.md 25) is a substitution; until then the endpoint rate
  limit stops one worker hammering an endpoint flat out, which is most of the
  value, but it is not the fleet-wide limit the control API's UI implies. Say
  so in the UI or land Redis.
- **Concurrency ceilings are per process too**, for the same reason and with the
  same arithmetic. The per-endpoint ceiling that must hold across the fleet is
  the rate limit.
- **`endpoint_health` is authoritative and un-cached.** Every attempt does one
  extra PK lookup for `Allow` and one upsert for `RecordOutcome`. Redis may
  front the *read* later; the probe admission must stay a conditional UPDATE in
  PostgreSQL, because it is the mutual exclusion that stops a thousand workers
  probing a recovering endpoint at once.
- **Large payloads ARE deliverable.** The worker fetches
  `events.payload_location` through `worker.PayloadFetcher` and signs the exact
  bytes it fetched, after checking they hash to `events.payload_hash`. Four
  outcomes, and they are deliberately distinct:

  | Situation | Outcome | Reason |
  |---|---|---|
  | fetched, hash matches | delivered | — |
  | bucket unreachable / no client configured | **deferred**, no attempt row, retry budget untouched | `payload_unavailable` |
  | object missing (404, swept, never written) | terminal `failed` | `payload_object_missing` |
  | bytes do not match `payload_hash` | terminal `failed` | `payload_hash_mismatch` |

  The last two are permanent (`retry.IsPermanentError`) because no retry can
  change them, and both carry `http_status = 0` so the ledger never implies the
  customer's endpoint rejected anything.

  The fetch happens after the endpoint concurrency gate and **before** the
  breaker: `Breaker.Allow` claims the half-open probe slot, and spending a
  recovering endpoint's one probe on a delivery that never reaches the network
  would delay its recovery by a whole cooldown for a reason unrelated to it.

## 5. Decisions taken, so they can be argued with

- **`deliveries.max_attempts` beats the endpoint's current retry policy.** The
  router freezes a budget onto the delivery; editing a retry policy mid-flight
  must not extend or truncate deliveries already in progress. Everything else in
  the policy (delays, multiplier, jitter, duration cap) is read live.
- **A 4xx does not open the circuit breaker.** The breaker is about
  availability. A 400 means the endpoint is up and dislikes one payload;
  opening on it would remove delivery pressure from a healthy endpoint.
  Breaker failures are exactly the retryable set: transport errors, timeouts,
  408, 429, 5xx. An SSRF rejection counts for neither — that is our policy, not
  their health.
- **A disabled/paused/deleted endpoint `cancelled`s the delivery, it does not
  retry.** The retry budget is for endpoints that might come back; an operator
  toggling `enabled` is not a transient fault. This keeps `failed` meaning "the
  endpoint rejected it".
- **A deferral writes the reason into `deliveries.last_error`.** That column is
  the only free-text field the operator UI has, and "why is this delivery not
  moving" is the question it exists to answer. The alternative is a row sitting
  in `scheduled` with no explanation anywhere a human looks. A *succeeded*
  delivery clears it rather than writing "delivered" into a column called
  `last_error`.
- **One undecryptable secret does not stop the delivery.** If an endpoint has
  two active secrets and one fails to decrypt, the worker logs it at ERROR with
  the secret id and signs with the other. Failing the whole delivery would hand
  anyone with database write access a denial of service on the endpoint —
  re-point one secret row and the endpoint goes dark. Zero usable secrets still
  fails closed.
- **`Webhook-Signature` is stored unredacted in `delivery_attempts`**, while
  `Authorization`, `Cookie` and anything containing `secret`/`token`/`api-key`
  are replaced with `[redacted]`. The signature is derived from the secret but
  does not reveal it, and it is the first thing anyone debugging "verification
  fails" needs. Customer credentials in `custom_headers` are the real hazard and
  they never reach the ledger.

## 6. Crash safety (ARCHITECTURE.md 57, cases 3-5, 17)

Three mechanisms, in the order they fire:

1. Every attempt runs under `LeaseKeeper.Track`. A lost lease cancels it with
   cause `queue.ErrLeaseLost`, and the worker then writes **nothing** — checked
   immediately after the HTTP call returns and again before it is made.
2. The final write is one transaction whose `UPDATE ... WHERE locked_by = $me`
   is the guard. Zero rows matched means the lease lapsed while the request was
   in flight: the transaction rolls back and the `delivery_attempts` row goes
   with it. Without that guard two workers append an attempt and race over the
   terminal status, and whichever commits last decides whether the customer's
   delivery "succeeded".
3. Bookkeeping runs on `context.WithoutCancel`. A SIGTERM landing between the
   HTTP response and the write does not lose the attempt record.

What is deliberately NOT prevented: a worker killed between the response and the
write leaves the row leased, the lease lapses, another worker delivers again.
That is at-least-once, it is the documented contract, and the duplicate is
detectable because both deliveries carry the same `Webhook-Delivery-Id`.

## 7. Tests, and what was not run

`go vet ./... && go build ./... && go test -race -count=1 ./... && gofmt -l .`
all pass.

Covered: the state machine as a table (every status class, both exhaustion
budgets, blocked/permanent/timeout classification, "every transition has a
reason"); retry scheduling growth and jitter; breaker transitions as a pure
function and exactly-one-probe under 20 concurrent workers; header construction
including that no custom header can override or append to `Webhook-Signature`,
that CRLF/NUL values are dropped and that a re-serialised payload does **not**
verify; the crypto interop vectors; and the delivery path against `httptest`
servers for 2xx, 4xx, 429, 5xx, timeout, a body that hangs, an oversized
response, and a redirect to `169.254.169.254`. Plus: lease lost mid-attempt
writes nothing, an open breaker and a rate limit defer without burning an
attempt, one slow endpoint does not consume the pool, the claim is sized to free
slots, and shutdown drains rather than kills.

**Not run: everything gated on `DATABASE_URL`.** `store_integration_test.go` and
`breaker_integration_test.go` skip cleanly and have never executed — the only
PostgreSQL on this machine is 14, and the schema requires 15+. They are the only
check on column and enum drift against Prisma, and on the breaker SQL agreeing
with `NextHealth`, so **run them first** against the real database:

```sh
cd services/data-plane && DATABASE_URL=... go test -race -count=1 ./internal/worker/ -v
```

The likeliest failures there, in order: an enum cast (`$n::text::"DeliveryStatus"`,
`"AttemptStatus"`, `"EndpointHealthState"`) that pgx encodes differently than
expected; `make_interval(secs => ...)` argument typing in the breaker cooldown;
and `TIMESTAMP(3)` versus `time.Time` location on `delivery_attempts.started_at`
— every other time value is computed by the server precisely to avoid that.

## 8. Still missing from the delivery stage

- **Ordered delivery.** `ordering_key` is loaded and ignored. Per-key
  serialisation alongside retries is genuinely hard (ADR-0004) and nothing in
  this package pretends otherwise.
- **`queue_depth` is never set.** The scheduler is the natural owner of that
  gauge; the worker sees only what it claimed.
- **No OpenTelemetry spans.** ARCHITECTURE.md 44 wants a trace from ingest
  through egress; the worker emits metrics and structured logs only.
- **`meta_events`** — the platform's own events about delivery outcomes, which
  Convoy has and this does not.
- **Per-endpoint egress clients.** `endpoints.timeout_ms` is applied as a
  context deadline, so it can only ever *shorten* an attempt; the process still
  shares one transport built from `EGRESS_TOTAL_TIMEOUT_MS`, so the per-phase
  timeouts (DNS, connect, TLS, response header) are global. `HTTPDoer` is an
  interface so a per-endpoint client is a substitution rather than a rewrite.
