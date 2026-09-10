# Configuration

Every environment variable the platform reads, its default, which plane reads
it, and what it means. The first table is generated from the `.env.example`
that ships with the release and follows its order; the second lists the keys
the data plane reads that `.env.example` does not mention.

## How configuration reaches each process

| Deployment | Mechanism |
|---|---|
| Helm | One ConfigMap and one or more Secrets, projected into every pod with `envFrom`. Keys the chart has no value for go in `extraEnv` (quoted strings). |
| Raw manifests | `01-configmap.yaml` plus the three Secrets. Edit the ConfigMap directly. |
| Compose | The host environment, forwarded per service. Optional keys are forwarded only when set. |

Three things to know before reading the tables:

- **Both planes read the same ConfigMap**, and a handful of keys are
  per-process settings two processes cannot both be right about. That is why
  the data plane has its own `DATA_PLANE_OTEL_SERVICE_NAME` and
  `DATA_PLANE_OTEL_TRACES_SAMPLER_ARG` with no fallback to the bare keys, and
  its own `WORKER_DB_TIMEOUT_MS` separate from `INGEST_DB_TIMEOUT_MS`.
- **The data plane does not read `.env`.** It reads the process environment.
  `.env.example` is a reference (and what the development stack copies); in a
  deployment, the environment has to actually be set on the container. On a
  developer machine that means `set -a; source .env; set +a` in every shell
  that runs a Go role.
- **Unset is not empty.** The control plane treats a blank optional value as
  unset for most keys, but Kubernetes `envFrom` and Compose `${VAR:-}` both
  produce set-but-empty variables, and the required secrets are validated
  strictly. Omit optional keys rather than blanking them.

## Values that refuse to boot

Each plane validates its environment at startup and reports every problem at
once. The rules an operator is most likely to trip:

| Rule | Who enforces it | Message (verbatim or close) |
|---|---|---|
| `DATABASE_STATEMENT_TIMEOUT_MS` >= `WORKER_DB_TIMEOUT_MS` | data plane | `DATABASE_STATEMENT_TIMEOUT_MS must not be below WORKER_DB_TIMEOUT_MS; the server-side backstop would fire first and mask the delivery deadline`. Same rule against `INGEST_DB_TIMEOUT_MS`. |
| `EGRESS_MAX_CONNS_PER_HOST` unset derives `WORKER_CONCURRENCY`; explicit 0 or negative is refused | data plane | `EGRESS_MAX_CONNS_PER_HOST must be positive; net/http reads zero as UNLIMITED connections to one host, which is not a bound`. Only an unset value derives; a wrong explicit value is never silently replaced. |
| `SMTP_URL` scheme | control plane | `SMTP_URL must start with smtp:// or smtps://`. `host:587` parses as a URL whose scheme is the hostname. Required in `staging` and `production`; `MAIL_FROM` required with it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` scheme | control plane refuses; data plane logs an error and disables tracing | `OTEL_EXPORTER_OTLP_ENDPOINT must start with http:// or https://`. `otel-collector:4318` would boot cleanly and export nothing for ever. |
| `DASHBOARD_URL` scheme | control plane | `DASHBOARD_URL must start with http:// or https://`. Every mail link is built from it. |
| Retention knobs | data plane (scheduler) | The `RETENTION_*` keys are the one set that **refuse to fall back to a default** when malformed: `retention: RETENTION_DELIVERY_AGE_DAYS must be positive, got ...; set RETENTION_ENABLED=false to turn retention off`. Both horizons are floored at 48 h, and attempts cannot outlive their delivery. A mistyped egress timeout costs latency; a mistyped horizon deletes the ledger on a schedule nobody chose. |
| `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA` | data plane (worker) | With `REDIS_URL` unset and `APP_ENV=production`: `REDIS_URL is not set, so endpoint delivery rate limits would be enforced PER WORKER REPLICA ... Set REDIS_URL, or set DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true to take per-replica limits deliberately`. |
| `EGRESS_ALLOW_PRIVATE_NETWORKS` in production | data plane | `EGRESS_ALLOW_PRIVATE_NETWORKS must not be true in production; use EGRESS_PRIVATE_ALLOWLIST for specific subnets`. |
| `ENCRYPTION_KEY` | both | Must decode to exactly 32 bytes. The worker: `ENCRYPTION_KEY is required` / `must be 32 bytes, base64-encoded`. The control plane: `ENCRYPTION_KEY must be 32 bytes, base64-encoded`. |
| `JWT_SECRET`, `SESSION_SECRET` | control plane | At least 32 characters each. Not defaulted to each other. |
| `PAYLOAD_INLINE_MAX_BYTES` <= `PAYLOAD_MAX_BYTES` | data plane | `PAYLOAD_INLINE_MAX_BYTES cannot exceed PAYLOAD_MAX_BYTES`. |
| `MAX_CONCURRENCY_PER_ENDPOINT` <= `MAX_CONCURRENCY_PER_PROJECT` | data plane | `MAX_CONCURRENCY_PER_ENDPOINT cannot exceed MAX_CONCURRENCY_PER_PROJECT`. |
| Ingest rate-limit bursts | data plane | A burst below its limit makes the limit unreachable: `INGEST_RATE_LIMIT_BURST must not be below INGEST_RATE_LIMIT` (and the `SOURCE` pair). |
| `ENDPOINT_AUTO_DISABLE_AFTER_HOURS` >= 24 | control plane | A delivery's own retry window is 24 h; disabling sooner would cancel deliveries still legitimately retrying. |
| `TRUST_PROXY_HOPS` 0..10, `INGEST_TRUSTED_PROXY_HOPS` >= 0 | each plane | Exact hop counts. Never inferred. |
| `SHUTDOWN_READINESS_DELAY_MS` 0..10000 | data plane | The delay plus the longest role drain (15 s) must fit inside the 25 s shutdown grace. |
| `PAYLOAD_SWEEP_MIN_AGE_MS` >= 3600000 | data plane | Shorter races a publish between its upload and its commit. |
| `CLAIM_STRATEGY` | data plane | `fifo` (default) or `tenant_fair`. |

Integer knobs that fail to parse (other than retention) fall back silently to
their built-in default. The Helm chart renders integers correctly; if you
manage the ConfigMap yourself, quote every number as a plain integer string.

## Reference, from `.env.example`

The **Default** column is the value in `.env.example`, which is a development
default (it points at a laptop's PostgreSQL). `unset` means the file leaves it
blank; the code default, if any, is in the Meaning column. **Read by** is
which plane's configuration loader reads the key.

| Key | Default (`.env.example`) | Read by | Meaning |
|---|---|---|---|
| `APP_ENV` | `development` | both | `development`, `test`, `staging` or `production`. Gates several refusals (see below). |
| `LOG_LEVEL` | `debug` | both | `trace`..`fatal`. The data plane maps `trace` to debug. |
| `DATABASE_URL` | `postgresql://webhook:webhook@localhost:5432/webhook_platform?schema=public` | both | PostgreSQL URL. Point at PgBouncer in production. **Required.** |
| `DIRECT_DATABASE_URL` | `postgresql://webhook:webhook@localhost:5432/webhook_platform?schema=public` | control plane | Direct (non-pooled) URL for migrations. Must bypass PgBouncer. |
| `DATABASE_MAX_CONNECTIONS` | `20` | data plane | Per-process pool size for the Go roles. |
| `REDIS_URL` | `redis://localhost:6379/0` | both | Optional. Token buckets only; delivery never depends on it. Leave **unset** rather than empty. |
| `S3_ENDPOINT` | `http://localhost:9000` | data plane | S3-compatible endpoint. Empty means no object storage. |
| `S3_BUCKET` | `webhook-payloads` | data plane | Bucket for oversized payloads. Empty disables offload and the orphan sweep. |
| `S3_REGION` | `us-east-1` | data plane | Bucket region. |
| `S3_ACCESS_KEY` | `minioadmin` | data plane | Access key (secret). |
| `S3_SECRET_KEY` | `minioadmin` | data plane | Secret key (secret). |
| `S3_FORCE_PATH_STYLE` | `true` | data plane | Path-style addressing; needed for MinIO and most non-AWS stores. |
| `PAYLOAD_INLINE_MAX_BYTES` | `65536` | data plane | Payloads at or above this size are written to object storage instead of the row. Must not exceed `PAYLOAD_MAX_BYTES`. |
| `PAYLOAD_MAX_BYTES` | `1048576` | data plane | Largest event accepted at all. |
| `JWT_SECRET` | unset | control plane | API token signing key, at least 32 characters. **Required.** |
| `SESSION_SECRET` | unset | control plane | Session cookie key, at least 32 characters. **Required**, and not defaulted to `JWT_SECRET`. |
| `ENCRYPTION_KEY` | unset | both | Base64 AES-256-GCM key, exactly 32 bytes decoded. **Required by both planes**; the worker will not start without it. |
| `CONTROL_API_PORT` | `3000` | control plane | Listen port of the control API. |
| `CONTROL_API_URL` | `http://localhost:3000` | neither (informational) | Public URL of the control API. |
| `DASHBOARD_URL` | `http://localhost:5173` | control plane | Public origin of the dashboard; the base of every link in outbound mail. Scheme required. |
| `SMTP_URL` | `smtp://localhost:1025` | control plane | `smtp://` or `smtps://` with credentials. Set means SMTP everywhere; unset refuses to boot under `staging`/`production`. `host:587` is refused. |
| `MAIL_FROM` | `"Hookubit <no-reply@localhost>"` | control plane | From header, `Name <address>` or bare address. Required whenever `SMTP_URL` is set. |
| `CORS_ORIGINS` | `http://localhost:5173` | control plane | Comma-separated browser origins allowed to call the control API. |
| `TRUST_PROXY_HOPS` | `0` | control plane | Exact number of reverse proxies in front of the control API (0..10). Wrong in either direction breaks per-IP rate limiting. |
| `INGEST_PORT` | `8080` | data plane | Listen port of the ingest API. |
| `DATA_PLANE_METRICS_PORT` | `9090` | data plane | Port serving `/health/*` and `/metrics` on every Go role. |
| `WORKER_CONCURRENCY` | `64` | data plane | In-flight deliveries per worker process. Must be positive. |
| `WORKER_DB_TIMEOUT_MS` | `5000` | data plane | Deadline for one database call on the delivery path. Must be positive and at most `DATABASE_STATEMENT_TIMEOUT_MS`. |
| `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA` | `false` | data plane | Acknowledge per-replica rate limits when `REDIS_URL` is unset. Without it, a production worker refuses to start. |
| `RETENTION_ENABLED` | `true` | data plane | Sweep the delivery ledger (scheduler role). |
| `RETENTION_DELIVERY_AGE_DAYS` | `90` | data plane | Delete delivery rows older than this. Floor 48 h. **Malformed values refuse to boot.** |
| `RETENTION_ATTEMPT_AGE_DAYS` | `60` | data plane | Delete attempt rows older than this. Floor 48 h; must not exceed the delivery horizon. **Refuses to default.** |
| `RETENTION_INTERVAL_MS` | `3600000` | data plane | Sweep interval. **Refuses to default.** |
| `RETENTION_BATCH_SIZE` | `1000` | data plane | Rows per delete statement. **Refuses to default.** |
| `RETENTION_MAX_DELETES_PER_RUN` | `50000` | data plane | Cap per pass. **Refuses to default.** |
| `RETENTION_BATCH_TIMEOUT_MS` | `30000` | data plane | Deadline per delete batch. **Refuses to default.** |
| `ENDPOINT_AUTO_DISABLE_ENABLED` | `true` | control plane | Disable endpoints whose breaker has been continuously open. |
| `ENDPOINT_AUTO_DISABLE_AFTER_HOURS` | `72` | control plane | Hours of continuous open breaker first. Floor 24, ceiling 8760. |
| `ENDPOINT_AUTO_DISABLE_INTERVAL_MINUTES` | `15` | control plane | Sweep interval (1..1440). |
| `ENDPOINT_AUTO_DISABLE_MAX_PER_RUN` | `200` | control plane | Endpoints one sweep may disable (1..10000). |
| `WORKER_POLL_INTERVAL_MS` | `250` | data plane | Idle worker poll interval. |
| `WORKER_CLAIM_BATCH_SIZE` | `100` | data plane | Deliveries claimed per poll. |
| `DELIVERY_LEASE_SECONDS` | `120` | data plane | Lease on a claimed delivery; lapsed leases are reclaimable. Keep above `EGRESS_TOTAL_TIMEOUT_MS`. |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | data plane | Router poll interval for unrouted events. |
| `ROUTER_MAX_OUTBOX_RETRY_DURATION_MS` | `3600000` | data plane | Elapsed time a failing fan-out is retried before the event is parked. |
| `MAX_CONCURRENCY_GLOBAL` | `512` | data plane | In-flight attempts per process across all tenants. |
| `MAX_CONCURRENCY_PER_ORG` | `128` | data plane | Per organization. |
| `MAX_CONCURRENCY_PER_PROJECT` | `64` | data plane | Per project. |
| `MAX_CONCURRENCY_PER_ENDPOINT` | `16` | data plane | Per endpoint. Must not exceed the per-project value. |
| `EGRESS_DNS_TIMEOUT_MS` | `2000` | data plane | Name resolution budget. 0 merges it into the connect budget. |
| `EGRESS_CONNECT_TIMEOUT_MS` | `3000` | data plane | TCP connect timeout. |
| `EGRESS_TLS_TIMEOUT_MS` | `3000` | data plane | TLS handshake timeout. |
| `EGRESS_RESPONSE_HEADER_TIMEOUT_MS` | `10000` | data plane | Wait for response headers. |
| `EGRESS_TOTAL_TIMEOUT_MS` | `30000` | data plane | Ceiling on one whole attempt. |
| `EGRESS_MAX_RESPONSE_BYTES` | `65536` | data plane | Response body bytes read and stored. |
| `EGRESS_MAX_REDIRECTS` | `0` | data plane | Redirects followed (0..5). |
| `EGRESS_MAX_CONNS_PER_HOST` | `0` | data plane | Concurrent connections per destination `host:port`. **Empty derives `WORKER_CONCURRENCY`**; 0 or negative after derivation is refused. |
| `EGRESS_ALLOW_PRIVATE_NETWORKS` | `false` | data plane | Disable the SSRF private-range refusal. **Refused when `APP_ENV=production`.** |
| `EGRESS_PRIVATE_ALLOWLIST` | unset | data plane | Comma-separated CIDRs deliverable despite being private. Works in production. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | both | Collector base URL; `/v1/traces` is appended. **Scheme required**: `host:4318` is refused by the control plane and logged-and-disabled by the data plane. Unset means tracing off. |
| `OTEL_SERVICE_NAMESPACE` | `webhook-platform` | both | `service.namespace` on every span (max 64 chars). |
| `OTEL_SERVICE_NAME` | `control-api` | control plane | `service.name` for the control API (max 64 chars). |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | control plane | Control-plane head sampling ratio 0..1. |
| `DATA_PLANE_OTEL_SERVICE_NAME` | `data-plane` | data plane | `service.name` for the Go roles. No fallback to `OTEL_SERVICE_NAME`. |
| `DATA_PLANE_OTEL_TRACES_SAMPLER_ARG` | `0.05` | data plane | Data-plane sampling ratio. No fallback to `OTEL_TRACES_SAMPLER_ARG`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | data plane | Signal-specific endpoint; takes precedence over the base endpoint and is the one validated. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `5000` | data plane | Export timeout in ms (standard OTel variable). |
| `OTEL_BSP_MAX_QUEUE_SIZE` | `4096` | data plane | Span processor queue size (standard OTel variable). |
| `ALLOW_OPEN_REGISTRATION` | `false` | control plane | Self-serve signup. Keep `false` on shared or internet-facing installs. |
| `INGEST_RATE_LIMIT` | `1000` | data plane | Per-API-key ceiling, requests per window. A live default; 0 leaves only policy rows in force. |
| `INGEST_RATE_LIMIT_BURST` | `2000` | data plane | Per-key burst. Must not be below the limit. |
| `INGEST_RATE_LIMIT_WINDOW_SECONDS` | `1` | data plane | Per-key window. Must be positive when the limit is on. |
| `INGEST_SOURCE_RATE_LIMIT` | `300` | data plane | Per-source-address ceiling, checked before authentication. 0 disables it. |
| `INGEST_SOURCE_RATE_LIMIT_BURST` | `600` | data plane | Per-source burst. Must not be below the limit. |
| `INGEST_SOURCE_RATE_LIMIT_WINDOW_SECONDS` | `1` | data plane | Per-source window. |
| `INGEST_SOURCE_AUTH_FAILURE_PENALTY` | `20` | data plane | Extra tokens charged for a failed authentication. Must not be negative. |
| `INGEST_TRUSTED_PROXY_HOPS` | `0` | data plane | Exact number of proxies in front of the ingest API. At 0 `X-Forwarded-For` is ignored entirely. |
| `RATE_LIMIT_POLICY_CACHE_TTL_MS` | `30000` | data plane | How stale a rate-limit policy row may be fleet-wide. Must be positive. |

## Keys the data plane reads that `.env.example` does not list

Defaults are the code's. Set them through `extraEnv` (Helm), the ConfigMap
(manifests) or the service environment (Compose). `ENCRYPTION_KEYS_RETIRED`
contains keys and belongs in a Secret.

| Key | Default (code) | Read by | Meaning |
|---|---|---|---|
| `BREAKER_BASE_COOLDOWN_MS` | `30000` | data plane | Base cooldown before a half-open probe. |
| `BREAKER_DEGRADED_THRESHOLD` | `3` | data plane | Failures that mark an endpoint degraded. |
| `BREAKER_FAILURE_THRESHOLD` | `5` | data plane | Consecutive failures that open an endpoint's circuit breaker. |
| `BREAKER_HALF_OPEN_SUCCESSES` | `2` | data plane | Successes needed to close a half-open breaker. |
| `CLAIM_STRATEGY` | `fifo` | data plane | `fifo` or `tenant_fair`. Invalid values refuse to boot. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | data plane | Server-side `statement_timeout` applied to every pooled connection. Must not be below `INGEST_DB_TIMEOUT_MS` or `WORKER_DB_TIMEOUT_MS`. |
| `ENCRYPTION_KEYS_RETIRED` | unset | both | Comma-separated `<kid>:<base64key>` pairs accepted for decryption only. Keep old keys here through rotation and for as long as your oldest restorable backup. |
| `ENCRYPTION_KEY_ID` | `k1` | both | Key id written into new ciphertext (1-16 chars of `[A-Za-z0-9_-]`). |
| `INGEST_DB_TIMEOUT_MS` | `5000` | data plane | Deadline for the database work of one publish. Must be positive. |
| `MAX_STORED_RESPONSE_BYTES` | `65536` | data plane | Response body bytes persisted per attempt. |
| `PAYLOAD_DOWNLOAD_TIMEOUT_MS` | `10000` | data plane | Bound on one payload download (worker). Must be positive. |
| `PAYLOAD_STORE_MAX_ATTEMPTS` | `3` | data plane | SDK retry count for one object-storage call. Must be positive. |
| `PAYLOAD_SWEEP_ENABLED` | `true` | data plane | Run the orphan payload sweep (scheduler role). |
| `PAYLOAD_SWEEP_INTERVAL_MS` | `3600000` | data plane | Sweep interval. |
| `PAYLOAD_SWEEP_MAX_DELETES` | `1000` | data plane | Objects deleted per sweep pass. |
| `PAYLOAD_SWEEP_MIN_AGE_MS` | `24*3600000` | data plane | Objects younger than this are never considered. Floor 1 h; shorter races an in-flight publish. |
| `PAYLOAD_UPLOAD_TIMEOUT_MS` | `10000` | data plane | Bound on one payload upload (ingest hot path). Must be positive. |
| `REDIS_TIMEOUT_MS` | `50` | data plane | Bound on one rate-limiter round trip. Deliberately tiny. |
| `ROUTER_BATCH_SIZE` | `100` | data plane | Outbox rows claimed per router poll. |
| `ROUTER_CONCURRENCY` | `8` | data plane | Parallel fan-outs per router process. |
| `ROUTER_LEASE_SECONDS` | `60` | data plane | Lease on a claimed outbox row. |
| `ROUTER_MAX_OUTBOX_ATTEMPTS` | `10` | data plane | Attempt count before an outbox row is parked. |
| `ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT` | `1000` | data plane | Subscriptions materialised per fan-out transaction; wider events take several. |
| `S3_PREFIX` | `events` | data plane | Key namespace inside the bucket. Must not be empty when a bucket is set. |
| `SHUTDOWN_READINESS_DELAY_MS` | `5000` | data plane | How long a role keeps accepting after readiness flips to `draining` on SIGTERM. 0..10000. |

## Keys set by the deployments but read by nothing

`CONTROL_API_URL` is written by the Helm ConfigMap and listed in `.env.example`
but no process reads it today. Harmless; do not rely on it.

---

**Where this comes from.** `.env.example` (key order and defaults), `services/data-plane/internal/config/{config,isolation}.go`, `services/data-plane/internal/retention/config.go`, `services/data-plane/internal/tracing/tracing.go`, `apps/control-api/src/config/env.schema.ts`, `deployments/helm/webhook-platform/templates/configmap.yaml`. The two tables are produced by a generator that parses those files; regenerate them when a key is added.
