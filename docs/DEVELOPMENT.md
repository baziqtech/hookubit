# Development state

**This file is the handover document.** ARCHITECTURE.md is the specification and
does not change; this file records what has actually been built against it, what
was decided along the way, and what the next task is. Any engineer — or any AI
model — should be able to read ARCHITECTURE.md, then this file, and continue
without archaeology.

Update it at the end of every working session. Keep it factual: what exists,
what does not, what is known-broken.

---

## Current state — Phases 1–6 complete (2026-09-10)

Everything ARCHITECTURE.md 62 lists is built, and every line of the definition
of done in ARCHITECTURE.md 63 has been exercised rather than argued. The
sections that follow are a map; the detailed accounts live in `docs/` and the
per-app `HANDOFF.md` files.

### What exists and works

- **Control plane** (`apps/control-api`) — users with email verification,
  sessions, organizations, memberships and roles, invitations, projects, API
  keys, endpoints with secrets and rotation, subscriptions, retry and
  rate-limit policies, the delivery and event read APIs, replay, the outbox
  recovery API for parked events, analytics, audit, endpoint auto-disable, an
  SMTP notifications module, OpenTelemetry. The OpenAPI document is emitted
  offline (`pnpm openapi`) and the dashboard client is generated from it.
- **Data plane** (`services/data-plane`) — ingest with pre-auth and policy rate
  limits, idempotency and the transactional outbox; router with batched,
  resumable, publish-time-pinned routing; scheduler; bounded worker pool with
  per-endpoint/project/org gates, leases, retries, circuit breakers, HMAC
  signing, SSRF refusal at dial time, payload offload, retention sweeps,
  Prometheus metrics, OpenTelemetry traces carried through PostgreSQL.
- **Dashboard** (`apps/dashboard`) — the operator surface: events, deliveries
  and attempts (with pruned-detail and trace-id states), replay, endpoints and
  breaker state, subscriptions, keys, team, audit, analytics, the parked-event
  recovery page, onboarding tour, and the full signup / verify / reset / invite
  flows.
- **Verification** — failure-injection suites for all twenty scenarios in
  ARCHITECTURE.md 57 (`services/data-plane/internal/failure/`), a k6 load suite
  (`tests/load/`), destroy-and-recreate and graceful-shutdown exercised for real
  (`docs/BACKUP_RESTORE.md`, `docs/LOAD_TESTING.md` 7b).
- **Deployment** — Dockerfiles for four images, dev and prod compose, raw
  Kubernetes manifests and a Helm chart that refuses to install without an
  external database and an SMTP URL, Prometheus/Grafana assets, CI that runs
  all of the above.

### What does NOT exist, on purpose

Kafka, multi-region, ClickHouse, SAML, static egress IPs, private network
connectors, dedicated tenant databases, payload transformations, WASM, global
routing — ARCHITECTURE.md 61, unchanged. Also not built: an admin surface above
organization owner, and billing beyond an honest empty state.

### Known gaps to watch

- **G13 — per-endpoint isolation is a ceiling, not a reservation.** The only
  open item in `docs/FAILURE_RECOVERY.md`. Isolation holds when the sum of
  `max_concurrency` across endpoints that can be slow stays under
  `WORKER_CONCURRENCY`; the worker warns at startup with the arithmetic and
  exposes gate occupancy, but nothing enforces the rule. The reservation is
  deliberately unbuilt until those gauges have run under real traffic.
- Two load scenarios (`slow-endpoints` at default caps, `many-tenants`) fail by
  design; their thresholds encode the claim above.
- The outbox recovery API would serve its UI better with a `park_reason` enum,
  a remaining-count on bulk requeue, and `event_type` on the row.
- `deliveries.next_attempt_at` is NOT NULL since `20260911000000`; the
  migration header carries a deploy-ordering rule for the first environment
  where the planes roll separately.

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

## Next task

There is no phase left on the roadmap. The candidates, in the order they will
cost you: G13's reservation (after real occupancy data), the outbox API
additions above, an admin surface, billing. Anything else should start from a
new ADR.

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
