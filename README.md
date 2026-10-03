# HookuBit

Multi-tenant webhook infrastructure: durable event ingestion, materialised
routing to subscribed endpoints, retries with backoff, per-endpoint circuit
breaking and auto-disable, HMAC signing with overlapping secret rotation, and a
delivery ledger you can actually answer "what happened to this event?" from —
without opening psql.

Runs as hosted SaaS, as a self-hosted Docker or Kubernetes deployment, or on a
plain Ubuntu box with `make deploy` — always against **the customer's own
PostgreSQL**.

**It all ships together, to one box.** `make deploy` builds the control API, the
Go data plane and the React dashboard into one release, and nginx serves the
dashboard's files and proxies `/v1/*` to the control API on the same hostname.
One origin: relative `fetch('/v1/…')` is correct by construction, there is no
CORS, and the session cookie never crosses an origin. Cloudflare sits in front
as a proxy — TLS, caching, DDoS — and hosts nothing. Containerise the whole
thing instead and the images are still there — see
[Deploying it](#deploying-it).

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
| [docs/DESIGN_GAP_AND_SPECS.md](docs/DESIGN_GAP_AND_SPECS.md) | The pen.dev design's 71 screens against what is built — now mostly a record of what landed, the six silent bugs the tests caught on the way, and what is deliberately still open. |
| [docs/DESIGN_BRIEF.md](docs/DESIGN_BRIEF.md) | A prompt for a design agent: every feature and state the interface must express, with no visual direction at all. Hand this over when you want a design, not a restyle. |
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
- **Routing** — one event becomes N delivery rows, each with its own retry
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
  and renders the trace id of any sampled attempt. It reports what became of an
  EVENT (six states rolled up from its deliveries, including `dropped` — routing
  completed and matched nobody) rather than only what became of the ingest, and
  keeps an endpoint's two facts apart: what you asked for, and what we are doing
  about it.
- **Alerting** — per-project email destinations for the things a person has to
  act on, confirmed before they receive anything, grouped within half an hour,
  and quiet between 22:00 and 07:00 except for an endpoint we stopped.
- **Guardrails you configure** — a publish allowlist checked in the ingest path
  *before* anything is said about the API key, so a refused address learns
  nothing about the credential it presented.
- **Accounts** — self-serve registration with email verification, password
  reset, team invitations, roles; all outbound mail through SMTP with a
  transport that refuses to boot in production unless configured.
- **Observability** — Prometheus metrics with Grafana dashboards, structured
  logs carrying trace ids, and OpenTelemetry traces that follow an event
  across ingest, router and worker by carrying W3C context through PostgreSQL
  (each stage a new root linked to its cause, not a six-hour parent).
- **Housekeeping** — attempt detail pruned at 60 days, delivery summaries at
  90, in batches that never queue behind live traffic; large payloads offloaded
  to object storage with an orphan sweep; hourly usage rollups, so what a
  customer was charged for outlives the ledger it was counted from.

## Quick start

Full steps, including the gotchas, are in
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md). The shape:

```bash
# Three env files, split by who reads them. The nine variables BOTH planes read
# live in the root one, exactly once, so they cannot drift apart.
cp .env.example                     .env   # APP_ENV, DATABASE_URL, ENCRYPTION_KEY, REDIS_URL, ...
cp apps/control-api/.env.example    apps/control-api/.env
cp services/data-plane/.env.example services/data-plane/.env
pnpm install
pnpm dev:infra               # dev-only compose: postgres + redis + minio + mailpit
pnpm generate && pnpm migrate:deploy
pnpm dev:api & pnpm dev:dashboard & pnpm dev:data-plane
```

Three things people trip on. The Go data plane does **not** read a file — it
reads the process environment, so export **both** of its files in each shell that
runs a Go role (`cd services/data-plane && set -a; source ../../.env; source
.env; set +a`), common first. With `SMTP_URL` unset the control plane uses a stub
mailer that delivers nothing, so point it at Mailpit (`smtp://localhost:1025`,
inbox at `http://localhost:8025`) or no account can be verified. And the Prisma
CLI reads `.env` from its working directory only, so use `pnpm generate` /
`pnpm migrate:deploy` rather than calling `prisma` by hand — the package scripts
export the common file for it.

**Requires PostgreSQL 15 or newer** — the schema uses `NULLS NOT DISTINCT`
unique indexes. The migration refuses to run on anything older.

Production does **not** run PostgreSQL in the stack: the Helm chart and the
production compose file refuse to start without an external `DATABASE_URL`, and
both refuse without an SMTP URL. CI renders the chart, the raw manifests and the
compose file and asserts what reaches each process — the worker gets the
encryption key it decrypts endpoint secrets with, never the session key; both
planes are told how many proxies stand in front of them.

## Deploying it

Three paths, all documented in the self-hosting guide under `apps/docs/`:

| Path | Where it lives |
|---|---|
| **Bare-metal Ubuntu** — systemd, nginx, your own PostgreSQL and Redis | [deployments/deployer/](deployments/deployer/) and [apps/docs/self-hosting/09-bare-metal-ubuntu.md](apps/docs/self-hosting/09-bare-metal-ubuntu.md) |
| **Docker Compose** | [deployments/docker/](deployments/docker/), [apps/docs/self-hosting/04-docker-compose.md](apps/docs/self-hosting/04-docker-compose.md) |
| **Kubernetes** — [Helm chart](apps/docs/self-hosting/02-helm.md) or [raw manifests](apps/docs/self-hosting/03-kubernetes-manifests.md) | [deployments/helm/](deployments/helm/), [deployments/kubernetes/](deployments/kubernetes/) |

The bare-metal path is automated end to end:

```bash
make deploy          # release directory, build, migrate, atomic symlink swap, health check
dep hookubit:health  # just the probes, read-only
dep rollback         # read deployments/deployer/README.md first — the database does not roll back
```

It is a Deployer recipe, so the one file you edit is
`deployments/deployer/hosts.yml`. It deploys a **pushed** git ref; it stops the
data plane across a migration, because two migrations in the history fail
*silently* in the other order; it refuses outright when the database has applied
a migration this release does not carry, which is what deploying an older ref
looks like and what `prisma migrate status` calls "up to date"; and it will not
roll back for you after the symlink swap, deliberately.
[deployments/deployer/README.md](deployments/deployer/README.md) is the
reasoning.

**It deploys the whole platform, dashboard included.** The dashboard is built
into the release and nginx serves it off that release as the document root for
`hookubit.com`, with `/v1/*` proxied to the control API on the same hostname.
One origin, one deploy, one artifact set — the `current` symlink swaps all three
together, so there is no state in which the front end and the API are from
different commits.

What that costs the API is **one** setting on the server: `DASHBOARD_URL`, the
base of every link in outbound mail. `CORS_ORIGINS` stays empty, and empty is
now the correct value — a same-origin request runs no CORS check at all, so
there is no preflight to allow and no header to spell exactly.

What it costs the nginx config is one thing worth knowing before you write it:
with an SPA's `try_files $uri /index.html` fallback, a **missing `location /v1/`
returns `index.html` with a `200`**, and the dashboard dies on `JSON.parse` of
HTML with nothing naming the cause. §8 of the bare-metal guide leads with it,
`hookubit:dashboard:check` asserts it on every deploy, and the one-line proof is

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://hookubit.com/v1/auth/session
```

See `apps/dashboard/README.md` and §8–§9 of the bare-metal guide. If you
self-host in containers instead,
`deployments/docker/dashboard.Dockerfile` builds and serves the same bundle.

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

The Go integration and failure-injection suites all share the one migrated
`hookubit_test` database. Each test binary takes a PostgreSQL advisory lock on
it, empties it, and holds the lock until it exits, so DB-backed packages queue
rather than interleave — `go test ./...` costs the sum of those suites rather
than the longest. Two runs at once queue the same way. **A database whose name
does not end in `_test` is refused outright**, because the first thing a run
does is truncate every table in it.

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

The dashboard has since been rebuilt against the pen.dev design —
[docs/DESIGN_GAP_AND_SPECS.md](docs/DESIGN_GAP_AND_SPECS.md) records what
landed and what is deliberately still open, the largest being Slack
destinations, prices and the marketing site.

One gap stays open by choice: per-endpoint isolation is a **ceiling, not a
reservation**. It holds when `sum(max_concurrency of endpoints that can be slow)`
is under `WORKER_CONCURRENCY`, and the worker now says so at startup and
exposes the occupancy that proves it — but nothing enforces the rule. See G13
in [docs/FAILURE_RECOVERY.md](docs/FAILURE_RECOVERY.md).
