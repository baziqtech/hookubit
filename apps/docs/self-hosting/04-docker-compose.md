# Docker Compose

For a single host: a small installation, a staging environment, an evaluation.
The production file is `deployments/compose/docker-compose.prod.yml` in the
release. It runs every process and, deliberately, no database.

## No bundled database, on purpose

There is no `postgres` service in the production file and it will not start
without an external `DATABASE_URL`. That is what makes "delete every container,
reinstall, keep your history" true. Provision PostgreSQL 15 or newer first
(see [Requirements](/self-hosting/01-requirements)), then:

```bash
export DATABASE_URL='postgresql://u:p@db.example.com:5432/webhook_platform?schema=public&sslmode=require'
export ENCRYPTION_KEY="$(openssl rand -base64 32)"
export JWT_SECRET="$(openssl rand -base64 48)"
export SESSION_SECRET="$(openssl rand -base64 48)"

# 1. Migrate. A one-shot job under the `migrate` profile; never on app start.
docker compose -f docker-compose.prod.yml run --rm migrate

# 2. Start.
docker compose -f docker-compose.prod.yml up -d

# 3. Scale workers, the throughput dial.
docker compose -f docker-compose.prod.yml up -d --scale worker=4
```

## Environment

The file reads its configuration from the host environment (or an `--env-file`).

**Required.** Each fails the command with a readable message when unset:

| Variable | Failure message |
|---|---|
| `DATABASE_URL` | `DATABASE_URL is required - this platform does not ship a database` |
| `ENCRYPTION_KEY` | `ENCRYPTION_KEY is required` |
| `JWT_SECRET` | `JWT_SECRET is required` |
| `SESSION_SECRET` | `SESSION_SECRET is required` |
| `SMTP_URL` | `SMTP_URL is required in production (smtp://user:pass@mail.example.com:587) - the control API refuses to start without a mail transport` |
| `MAIL_FROM` | `MAIL_FROM is required with SMTP_URL, e.g. "Hookubit <no-reply@example.com>"` |
| `DASHBOARD_URL` | `DASHBOARD_URL is required - the origin the dashboard is served from, e.g. https://webhooks.example.com` |

**Optional, passed through.** These are forwarded only when the host sets them.
A key with no value in the file is *absent* from the container, not empty,
which matters: the control API accepts a missing `REDIS_URL` and rejects an
empty one.

| Variable | Effect |
|---|---|
| `REDIS_URL` | Fleet-wide rate limits. Without it, see the note below. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object storage for payloads at or above 64 KiB. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Tracing. |
| `DIRECT_DATABASE_URL` | Direct connection for the migrate job. Defaults to `DATABASE_URL`, which is correct only when that is not a pooler. |
| `LOG_LEVEL` | Default `info`. |
| `WORKER_CONCURRENCY` | Default 64. |
| `WORKER_REPLICAS` | Default 2. `--scale worker=N` overrides it. |
| `CORS_ORIGINS` | Browser origins allowed to call the control API. |
| `TRUST_PROXY_HOPS`, `INGEST_TRUSTED_PROXY_HOPS` | Exact number of reverse proxies in front of `:3000` and `:8080`. Absent means 0, "no proxy". See the note below. |
| `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA` | Required (`true`) to run production workers without `REDIS_URL`. See the note below. |
| `IMAGE_CONTROL_API`, `IMAGE_CONTROL_API_MIGRATE`, `IMAGE_DATA_PLANE`, `IMAGE_DASHBOARD` | Image references. Default to `ghcr.io/shaq/...:latest` and `:latest-migrate`. Pin them. |
| `CONTROL_API_BIND`, `INGEST_BIND`, `DASHBOARD_BIND` | Host bind addresses. Control API and dashboard default to `127.0.0.1` (put a reverse proxy in front); ingest defaults to `0.0.0.0:8080`. |

`APP_ENV` is hard-set to `production` inside the file.

> **Mail is required, because `APP_ENV` is `production`.** The control API
> refuses to boot in production without a mail transport (`SMTP_URL is required
> when APP_ENV=production`), so the file requires `SMTP_URL`, `MAIL_FROM` and
> `DASHBOARD_URL` with the same `:?` guard as the secrets: `compose up` stops
> with a readable message rather than starting a container that crash-loops.
> `DASHBOARD_URL` is the origin every mail link is built on
> (`/verify-email`, `/reset-password`, `/accept-invitation`).
>
> **Two workers and no Redis needs an explicit choice.** The file runs 2 worker
> replicas. With no `REDIS_URL`, endpoint delivery rate limits are enforced per
> replica - a customer's limit of N becomes N x 2 - and a production worker
> refuses to start rather than quietly weaken a limit the control plane
> accepted. Set `REDIS_URL`, or export
> `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true` to take per-replica limits
> deliberately. The variable is passed through, not defaulted, so the refusal
> stands until you decide.
>
> **Behind a reverse proxy, set the hop counts.** `TRUST_PROXY_HOPS`
> (control API) and `INGEST_TRUSTED_PROXY_HOPS` (ingest) are passed through and
> default to 0 ("no proxy") when unset. With the usual nginx or Caddy
> terminating TLS in front of `127.0.0.1:3000` and `:8080`, export both as `1`;
> at 0 every request behind a proxy shares one per-IP rate-limit bucket.

## The services

| Service | Image | Notes |
|---|---|---|
| `migrate` | `webhook-control-api:<tag>-migrate` | Profile `migrate`, so it never starts with `up`. Runs `prisma migrate deploy` with `--no-install`, which makes it impossible to silently fetch a different migration tool from the registry. Uses `DIRECT_DATABASE_URL`. |
| `control-api` | `webhook-control-api` | Port 3000 on `127.0.0.1` by default. Health check on `/health/live`. 30 s stop grace so in-flight requests finish. |
| `ingest` | `webhook-data-plane` `ingest` | Port 8080. 40 s stop grace: the in-process drain is 25 s, and Docker's 10 s default used to SIGKILL ingest mid-drain, so a publish whose row had committed never got its `202` and the publisher correctly republished it. Duplicate events from a routine `compose down`. |
| `router`, `scheduler` | `webhook-data-plane` | 40 s stop grace. One scheduler; do not scale it. |
| `worker` | `webhook-data-plane` `worker` | 60 s stop grace: above the drain and above one full 30 s outbound attempt. Scale this. |
| `dashboard` | `webhook-dashboard` | Port 8088 on `127.0.0.1` by default. Static bundle: nothing here configures it. |

All data-plane containers share one environment block and read `ENCRYPTION_KEY`
from it; the worker needs it to decrypt endpoint signing secrets.

## Put a reverse proxy in front

The control API and dashboard bind to loopback by default. Terminate TLS in
nginx, Caddy or Traefik and route:

| Path | Upstream |
|---|---|
| `/v1`, `/docs` on the app host | `127.0.0.1:3000` |
| `/` on the app host | `127.0.0.1:8088` |
| `/` on the ingest host | `:8080` (or bind ingest to loopback too and proxy it) |

Set the proxy's body-size limit just above 1 MiB for ingest so an oversized
publish is rejected by the application with a useful error. `/docs` is not
served when `APP_ENV` is `production`.

## The dashboard image

The dashboard's API address and the ingest URL on its get-started page are
baked in when the image is built. If the get-started page tells publishers to
send to `http://localhost:8080`, or the UI shows a "Demo data" banner, build
your own:

```bash
docker build -f deployments/docker/dashboard.Dockerfile \
  --build-arg VITE_INGEST_BASE_URL=https://ingest.example.com \
  --build-arg VITE_API_TRANSPORT=http \
  -t webhook-dashboard:local .
IMAGE_DASHBOARD=webhook-dashboard:local docker compose -f docker-compose.prod.yml up -d dashboard
```

## First owner

There is no default account. After the stack is up:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e BOOTSTRAP_EMAIL='owner@example.com' \
  -e BOOTSTRAP_ORG='Acme' \
  -e BOOTSTRAP_PASSWORD="$(openssl rand -base64 24)" \
  control-api node dist/cli/bootstrap.js
```

It refuses to run if any user already exists. Hand the password over out of
band and have the owner change it. The `-e` flags land in your shell history;
prefer an `--env-file` you delete afterwards.

## The development file is not for production

`docker-compose.dev.yml` exists so a laptop has infrastructure. It must never
be production, and the reasons are specific:

| Service | Why it disqualifies the file |
|---|---|
| `postgres` | A database inside the stack with the credentials `webhook`/`webhook`. Losing the volume loses every event, delivery and attempt. The whole point of the production shape is that this cannot happen. |
| `redis` | `--appendonly no`. Fine for token buckets, and the only thing in the file that would be acceptable. |
| `minio` | `minioadmin`/`minioadmin` root credentials, one node, no versioning. |
| `mailpit` | Catches every message and delivers none. Perfect for staging; it means no customer ever receives an invitation. |
| `sink` | An HTTP echo server to deliver to while developing. Not part of any deployment. |

It also runs nothing of the platform itself; the application processes are
started separately against it. Use it, with Mailpit, for a staging sandbox if
you want a throwaway database, and know that "throwaway" is exactly what it is.

---

**Where this comes from.** `deployments/compose/docker-compose.prod.yml`, `deployments/compose/docker-compose.dev.yml`, `apps/control-api/src/config/env.schema.ts` (the `superRefine` block), `services/data-plane/internal/config/isolation.go` (`ValidateDeliveryRateLimitScope`), `docs/adr/0006-no-default-credentials.md`.
