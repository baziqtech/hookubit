# Webhook Platform

Multi-tenant webhook infrastructure: durable event ingestion, materialised
fan-out to subscribed endpoints, retries with backoff, HMAC signing, and a
delivery log you can actually answer questions from.

Runs as hosted SaaS or as a self-hosted Docker/Kubernetes deployment against
**the customer's own PostgreSQL**.

## Reading order

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The specification. Fixed. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | What is actually built, and what to do next. **Start here.** |
| [docs/adr/](docs/adr/) | Decisions and their reasoning. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases. |

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

PostgreSQL is durable state. Redis is cache and coordination — wipe it and you
lose time, never an accepted event. S3 holds large payloads. Containers hold
nothing.

## Quick start

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#getting-started).

**Requires PostgreSQL 15 or newer** — the schema uses `NULLS NOT DISTINCT`
unique indexes. The migration refuses to run on anything older.

```bash
cp .env.example .env    # fill the three secrets
pnpm install
pnpm dev:infra          # postgres + redis + minio, DEVELOPMENT ONLY
pnpm generate && pnpm migrate
pnpm dev:api & pnpm dev:dashboard & pnpm dev:data-plane
```

Production does **not** run PostgreSQL in the stack:
`deployments/compose/docker-compose.prod.yml` has no `postgres` service and
refuses to start without an external `DATABASE_URL`.

## Status

Phase 1 (foundation) complete. The control-plane domain modules and the delivery
pipeline are not yet implemented — see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#what-does-not-exist-yet).
