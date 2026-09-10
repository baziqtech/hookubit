# HookuBit

Multi-tenant webhook infrastructure: durable event ingestion, materialised
fan-out to subscribed endpoints, retries with backoff, per-endpoint circuit
breaking and auto-disable, HMAC signing with overlapping secret rotation, and a
delivery ledger you can actually answer "what happened to this event?" from —
without opening psql.

Runs as hosted SaaS or as a self-hosted Docker/Kubernetes deployment against
**the customer's own PostgreSQL**.

> **Renamed to HookuBit.** The npm scope is `@hookubit/*`, the Go module is
> `github.com/shaq/hookubit/services/data-plane`, the Helm chart is
> `deployments/helm/hookubit`, and Kubernetes objects are `hookubit-*` in a
> `hookubit` namespace. A Kubernetes selector is immutable, so an existing
> install is an **uninstall and reinstall**, not an upgrade — keep the same
> `ENCRYPTION_KEY` or the signing secrets already in your database cannot be
> decrypted. The delivery wire contract is deliberately unchanged: the
> `Webhook-Id` / `Webhook-Signature` / `Webhook-Timestamp` headers and the
> `whsec_` and `wk_live_` prefixes are exactly what they were, so no consumer's
> verification code has to change. The outbound `User-Agent` is now
> `HookuBit/1.0` — only relevant if a partner allowlisted the old value.

## Reading order

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The specification. Fixed. |
| [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) | Running it on your machine, with the gotchas called out. **Start here.** |
| [docs/API.md](docs/API.md) | The publish and management contract. |
| [docs/FAILURE_RECOVERY.md](docs/FAILURE_RECOVERY.md) | Every one of ARCHITECTURE.md's twenty failure scenarios: what breaks, what recovers it, what is still open. Written for 2am. |
| [docs/LOAD_TESTING.md](docs/LOAD_TESTING.md) | The k6 suite, what each scenario proves, and the two that fail on purpose. |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | What to back up, the two traps a restore hits, and the destroy-and-recreate proof. |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | The interface as built — tokens, type, components, voice — and the brand decisions nobody has made yet. Written to be handed to a designer. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases 1–6, all complete, and what is explicitly not now. |
| [docs/adr/](docs/adr/) | Decisions and their reasoning. |

## Shape

```
React dashboard ──► NestJS control API ──► PostgreSQL ◄── Go data plane ──► customer endpoints
                     (configuration)        (truth)       (ingest · router ·
                                                           scheduler · worker · egress)
```

The control plane configures the system. The data plane executes it. NestJS is
never in the delivery hot path, so the control plane can be down, deploying or
broken without stopping deliveries that were already accepted.

## The rule everything else follows

> Containers are disposable. Customer data is not.

PostgreSQL is durable state **and the queue**. Redis holds rate-limiter token
buckets and nothing else — lose it and limits degrade to per-replica until it
returns; delivery never depends on it, and a test fails the build if any
delivery-path package ever imports a Redis client. Object storage holds payloads
above the inline limit. Containers hold nothing.

## What is built

- **Ingest** — API-key auth, rate limiting (pre-auth per source, then per
  policy), idempotency keys, a transactional outbox: nothing is published
  before COMMIT, and the reply is 202 only for what is durable.
- **Fan-out** — one event becomes N delivery rows, each with its own retry
  chain, in batches bounded by a cap that resumes rather than truncates, pinned
  to the subscriptions that existed at publish time.
- **Delivery** — a bounded worker pool with per-endpoint, per-project and
  per-org concurrency gates; leases with `FOR UPDATE SKIP LOCKED`; jittered
  exponential backoff; `Retry-After` honoured and clamped; every attempt
  recorded.
- **Protection** — HMAC over the exact wire bytes with overlapping secret
  rotation; SSRF refusal judged per resolved address immediately before
  connect; per-endpoint circuit breakers with a single half-open probe;
  endpoints open for 72h are disabled automatically and re-enabled with one
  probe, not a thundering herd.
- **Operator surface** — the dashboard answers "what happened to this event?",
  replays a delivery or an event, shows why an event parked and requeues it,
  and renders the trace id of any sampled attempt.
- **Accounts** — self-serve registration with email verification, password
  reset, team invitations, roles; all outbound mail through SMTP with a
  transport that refuses to boot in production unless configured.
- **Observability** — Prometheus metrics with Grafana dashboards, structured
  logs carrying trace ids, and OpenTelemetry traces that follow an event
  across ingest, router and worker by carrying W3C context through PostgreSQL
  (each stage a new root linked to its cause, not a six-hour parent).
- **Housekeeping** — attempt detail pruned at 60 days, delivery summaries at
  90, in batches that never queue behind live traffic; large payloads offloaded
  to object storage with an orphan sweep.

## Quick start

Full steps, including the gotchas, are in
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md). The shape:

```bash
cp .env.example .env         # PostgreSQL 15+, Redis, MinIO, Mailpit, and the four secrets
pnpm install
pnpm dev:infra               # dev-only compose: postgres + redis + minio + mailpit
pnpm generate && pnpm migrate:deploy
pnpm dev:api & pnpm dev:dashboard & pnpm dev:data-plane
```

Two things people trip on: the Go data plane does **not** read `.env` — export
its variables or use the compose file; and with `SMTP_URL` unset the control
plane uses a stub mailer that delivers nothing, so point it at Mailpit
(`smtp://localhost:1025`, inbox at `http://localhost:8025`) or no account can be
verified.

**Requires PostgreSQL 15 or newer** — the schema uses `NULLS NOT DISTINCT`
unique indexes. The migration refuses to run on anything older.

Production does **not** run PostgreSQL in the stack: the Helm chart and the
production compose file refuse to start without an external `DATABASE_URL`, and
both refuse without an SMTP URL. CI renders the chart, the raw manifests and the
compose file and asserts what reaches each process — the worker gets the
encryption key it decrypts endpoint secrets with, never the session key; both
planes are told how many proxies stand in front of them.

## Documentation for customers

`apps/docs` is the customer-facing documentation site — the integration guide
(publish, receive, verify, retries, rotation, replay), the dashboard guide, a
self-hosting guide, and an API reference **generated from the control plane's
own OpenAPI document on every build**, so a field on the site is a field the
product has. It is public by design: no sign-in.

```bash
pnpm docs:dev        # http://localhost:4000, with search and rendered diagrams
pnpm docs:build      # what CI runs; dead-link checking is on and fails the build
```

Read the markdown under `apps/docs/` directly if you prefer an editor — the
site renders those same files, there is no second copy.

## Verifying it

```bash
pnpm -r lint && pnpm -r build && pnpm -r test    # control plane + dashboard
pnpm go:test:race                                 # data plane, against hookubit_test
pnpm load:all                                     # k6; two scenarios are red by design
```

The Go integration and failure-injection suites give every package its own
copy of the migrated `hookubit_test` database. Two runs at once against one
`DATABASE_URL` refuse to start rather than corrupt each other; set
`TEST_DB_RUN_ID` per run if you need that.

The dashboard is also proved **against the real stack**, not its mock: a
Playwright journey registers an account through the verification mail, creates
a project, key, endpoint and subscription, publishes through the ingest API,
verifies the HMAC on what a local receiver got, replays, fails and retries,
pauses, rotates a secret, creates policies, invites, renames, revokes and
deletes - every control the dashboard offers.

```bash
pnpm --filter @hookubit/dashboard test:e2e     # needs the stack running; see docs/LOCAL_SETUP.md 9
```

## Status

Phases 1–6 of [the roadmap](docs/ROADMAP.md) are complete and every line of
ARCHITECTURE.md's definition of done has been exercised rather than argued —
crash recovery, tenant fairness, SSRF, double-claim safety, graceful shutdown
under load, and destroy-and-recreate against the same PostgreSQL.

One gap stays open by choice: per-endpoint isolation is a **ceiling, not a
reservation**. It holds when `sum(max_concurrency of endpoints that can be slow)`
is under `WORKER_CONCURRENCY`, and the worker now says so at startup and
exposes the occupancy that proves it — but nothing enforces the rule. See G13
in [docs/FAILURE_RECOVERY.md](docs/FAILURE_RECOVERY.md).
