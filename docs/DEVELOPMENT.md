# Development state

**This file is the handover document.** ARCHITECTURE.md is the specification and
does not change; this file records what has actually been built against it, what
was decided along the way, and what the next task is. Any engineer — or any AI
model — should be able to read ARCHITECTURE.md, then this file, and continue
without archaeology.

Update it at the end of every working session. Keep it factual: what exists,
what does not, what is known-broken.

---

## Current state — Phase 1 complete (foundation)

Last updated: 2026-09-06

### What exists and works

| Area | State |
|---|---|
| Monorepo (pnpm workspaces + Go module) | Done |
| `schema.prisma` — 21 models, full ARCHITECTURE.md §12/§13 model | Done, migration not yet generated |
| NestJS control API skeleton: config validation, Prisma module, health probes, error model, AES-256-GCM crypto, bootstrap CLI | Done |
| React dashboard skeleton: Vite, Router, TanStack Query, Tailwind, typed fetch client | Done |
| Go data plane: config, structured logging, pool, health/metrics server, `webhookd` roles, graceful shutdown | Done |
| Go `internal/signing` — HMAC-SHA256, rotation overlap, replay tolerance | **Done, tested** |
| Go `internal/retry` — backoff, jitter, retryable-status policy, exhaustion | **Done, tested** |
| Go `internal/egress` — SSRF guard, bounded HTTP client | **Done, tested** |
| Go `internal/router` — event-type matching | **Done, tested** |
| Go `internal/queue` — `SKIP LOCKED` claim / renew / release / reclaim | Done, needs integration test |
| Dev + production compose, three Dockerfiles, CI, six ADRs | Done |

### What does NOT exist yet

- **No migration has been generated.** `schema.prisma` has never been applied.
  Run `pnpm migrate` against a live database first (see Getting started).
- **Every control-plane domain module.** Only health exists. No auth, no
  organizations, no projects, no endpoints. Phase 2.
- **The delivery pipeline bodies.** `runIngest`, `runRouter` and the worker's
  attempt loop are stubs marked `PHASE 3`; they start, serve probes and shut
  down cleanly, but deliver nothing. Phase 3.
- Rate limiting, circuit breakers, replay, payload offload to S3, OpenTelemetry
  traces, Kubernetes/Helm manifests.

### Known gaps to watch

- `go.mod` targets Go 1.21 (the toolchain on the original dev machine); the
  Dockerfiles and CI use 1.23. Align when convenient.
- `PostgresQueue.Claim` orders by `next_attempt_at, created_at` with no tenant
  fairness yet. As written, one tenant with a large burst can dominate a claim
  batch. Fairness (ARCHITECTURE.md 24) must land with the worker in Phase 3 —
  see "Next task".
- The claim query needs a partial index (`WHERE status IN (...)`) before it
  meets any real volume; add it with the first migration that follows load
  testing.

**Fairness decision — settled, see [ADR-0007](adr/0007-tenant-fairness.md).**
The open question from the 2026-09-06 session log is closed. The claim becomes a
1s-ticker tenant snapshot (a loose index scan over the ready set) plus a
`CROSS JOIN LATERAL … LIMIT cap FOR UPDATE SKIP LOCKED` claim, where
`cap = max(1, ceil(claim_limit / K))` is **derived from the active tenant count,
never a constant** — with one tenant it degrades to FIFO, and a fixed cap would
throttle a lone tenant while workers idle. Org fairness is applied in Go over
the snapshot list; endpoint fairness is a Redis semaphore in Phase 4 with the
circuit breaker. The ADR carries the exact SQL, the one required index, the
`next_attempt_at NOT NULL` schema change it depends on, and the four metrics to
add. Ordering and thresholds for everything after it are in
[docs/design/scale-and-partitioning.md](design/scale-and-partitioning.md) —
including the trap that this claim query prunes no partitions until a
`created_at` floor is added to it.

---

## Getting started

```bash
cp .env.example .env                     # then fill JWT_SECRET, SESSION_SECRET, ENCRYPTION_KEY
openssl rand -base64 48                  # JWT_SECRET / SESSION_SECRET
openssl rand -base64 32                  # ENCRYPTION_KEY (must decode to exactly 32 bytes)

pnpm install
pnpm dev:infra                           # postgres + redis + minio + a webhook sink, dev only
pnpm generate && pnpm migrate            # Prisma client, then the first migration

pnpm dev:api                             # control plane  :3000  (/docs for OpenAPI)
pnpm dev:dashboard                       # dashboard      :5173
pnpm dev:data-plane                      # webhookd all   :8080 ingest, :9090 probes/metrics
```

Tests:

```bash
pnpm go:test                             # Go unit tests (signing, retry, egress, router)
pnpm test                                # TypeScript
```

---

## Decisions already made — do not relitigate without a new ADR

Read `docs/adr/` in full before changing any of these.

1. **NestJS is never in the delivery hot path.** Workers read PostgreSQL and
   cache; they never call the control API synchronously (ARCHITECTURE.md 54).
2. **Prisma owns all DDL.** Go issues SQL, never migrations (ADR-0002).
3. **PostgreSQL is the queue for now** (ADR-0003). Redis holds rate limits,
   breaker state and config cache only. If Redis is wiped, nothing accepted is lost.
4. **One Go binary, roles by subcommand** (ADR-0005).
5. **`ordering_key` is stored, ordering is not enforced** (ADR-0004).
6. **No default credentials, ever** (ADR-0006).
7. **Filters fail closed.** An empty or unmatched pattern list matches nothing.
   Silently widening a filter to `*` is a data leak — the exact bug that made
   Convoy's community licence unusable here.

---

## Invariants — a change that breaks one of these is a bug, not a trade-off

- An event that returned `202 accepted` is recoverable from PostgreSQL alone.
- The event row and its outbox row are written in one transaction; nothing is
  published before that commit.
- A delivery row is written before its first attempt is made.
- `delivery_attempts` is append-only. Replay creates new rows; it never mutates
  the original delivery.
- No two workers process the same delivery concurrently.
- Every outbound request has a deadline and a response-size cap.
- Every customer-supplied URL is validated at dial time, per resolved address.
- Secrets are encrypted at rest and never logged.
- Containers are disposable; deleting all of them and reinstalling against the
  same database restores everything.

---

## Next task — Phase 2, control plane

Work in this order; each step is independently shippable.

1. `prisma migrate dev --name init` and commit the migration.
2. `auth` module: registration, login, logout, email verification, password
   reset. Argon2id, HTTP-only session cookies, no token in `localStorage`.
3. `organizations` + `memberships` + RBAC guards. Permissions are explicit
   (`events.replay`, `endpoints.write`, …) and enforced in one central policy
   layer, never scattered through controllers.
4. `projects`, then `api-keys` (prefix + hash, shown once, scoped, revocable).
5. `endpoints` + `endpoint-secrets`, including rotation with an overlap window —
   `internal/signing` already emits one `v1=` per active secret, so the control
   plane only has to keep two rows active.
6. `webhook-subscriptions`, `retry-policies`, `rate-limits`.

Then Phase 3 (data plane), where the first three tasks are:

1. `runIngest` — the ARCHITECTURE.md 16 sequence, ending in one transaction that
   writes `events` + `event_outbox` and returns 202.
2. `runRouter` — drain the outbox, match subscriptions, insert delivery rows
   keyed on `(event_id, endpoint_id)` so a retried batch cannot double-fan-out.
3. The worker attempt loop, with tenant fairness added to the claim query at the
   same time (see "Known gaps").

Phases 4–6 are unchanged from ARCHITECTURE.md 62.

---

## Session log

Append one entry per session. Newest last.

### 2026-09-06 — Phase 1 foundation

Created the monorepo, the full Prisma model, both service skeletons, the
dashboard shell, dev/prod compose, Dockerfiles, CI and ADRs 0001–0006.

Wrote and tested the four pieces of pure logic the rest of the platform depends
on: HMAC signing with rotation overlap, retry backoff with jitter, the SSRF
guard, and subscription matching. The SSRF suite includes the two tests that
matter — a hostname resolving to loopback is refused at dial time (not by string
inspection), and a redirect into the cloud metadata service is refused even when
private networks are otherwise permitted.

Open question for the next session: tenant fairness in `PostgresQueue.Claim`.
The current `ORDER BY next_attempt_at, created_at` is FIFO across all tenants,
so a burst from one project can fill every claim batch. The likely fix is a
lateral join that takes at most N per project per batch, but it needs measuring
against a plain partial index before adding query complexity.
