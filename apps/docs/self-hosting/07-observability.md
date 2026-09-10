# Observability

The platform exports health, metrics, traces and structured logs. It installs
none of the tooling that consumes them, in the same spirit as it installs no
database: a bundled Prometheus is a second thing to operate and the first
thing to be out of date. This page says what is exported, what it means, and
what to alert on.

## Health endpoints

| Service | Port | Liveness | Readiness |
|---|---|---|---|
| Control API | 3000 | `GET /health/live` -> `{"status":"ok"}` | `GET /health/ready` runs `SELECT 1`; 503 `{"status":"unavailable","checks":{"postgres":"down"}}` on failure |
| Ingest, router, scheduler, worker | 9090 | `GET /health/live` -> `{"status":"ok"}` | `GET /health/ready`, see below |
| Dashboard | 8080 | `GET /` | `GET /` |

Both health paths on the control API sit outside the `/v1` prefix and are
excluded from the API reference. Liveness never touches PostgreSQL on any
service: a database blip that restarted every pod would turn a recoverable
incident into an outage.

### What the data plane's readiness means

| Response | Meaning | What to do |
|---|---|---|
| 200 `{"status":"ok","checks":{"postgres":"up"}}` | Serving. | Nothing. |
| 503 `{"status":"starting"}` | The process has bound its port but has not yet finished connecting to PostgreSQL. It waits with backoff and stays alive; liveness is 200 throughout. | Look at the database. The pod is not broken. |
| 503 `{"status":"draining"}` | The process received SIGTERM. Readiness flipped before any listener closed; it keeps serving for `SHUTDOWN_READINESS_DELAY_MS` (5 s) so load balancers notice, then drains in-flight work and exits within its 25 s grace. | Nothing; it is leaving. A pod that stays `draining` past its grace period was SIGKILLed mid-attempt and its deliveries wait out their lease. |
| 503 `{"status":"unavailable","checks":{"postgres":"down"}}` | Was ready; the pool no longer answers a ping. | The database, or the network to it. |
| 503 with `{"postgres":"connecting"}` | The pool has not been opened yet (a sub-state of `starting`). | As for `starting`. |

`starting` and `draining` are the same status code and opposite operator
stories: one resolves itself, the other is the pod leaving.

## Metrics

Only the data plane exports Prometheus metrics, on `:9090/metrics`, the same
port as its probes, on all four roles. The control API has no metrics endpoint
today and the dashboard is static files.

Scraping: every data-plane pod carries `prometheus.io/scrape: "true"`,
`prometheus.io/port: "9090"` and `prometheus.io/path: /metrics`. The release
ships an annotation-driven `scrape_configs` entry and an equivalent
`PodMonitor` (select on `app.kubernetes.io/name: webhook-platform`, port
`probes`, 30 s interval). Scrape at 30 s, not 15 s: the histograms are read
over minutes and queue depth refreshes on its own 15 s ticker. Rewrite the
address to the annotated port; discovery otherwise targets the ingest pod's
first port, which is the public publish API, and produces 404s in its logs
instead of metrics.

No series is labelled by organization, project, endpoint, event or delivery
id. Cardinality is bounded by construction.

### Alerts worth having

The shipped rule file follows one rule: alert on symptoms a human must act on,
and say in the annotation what to do. Each expression uses a series the
platform actually writes.

| Alert | Expression (summary) | Severity | What it means, what to do |
|---|---|---|---|
| `WebhookQueueBacklogGrowing` | `sum(queue_depth{state="ready"}) > 1000` and rising for 15 m | warning | Deliveries become claimable faster than workers finish them. If `worker_active_count` is pinned at replicas x concurrency the pool is saturated: add workers (and raise the database ceiling with them). If it is near zero, workers are not claiming: look at `queue_claim_duration_seconds` and the database. |
| `WebhookQueueDepthNotExported` | `absent(queue_depth)` for 30 m | info | Nothing is refreshing the gauge, so the backlog alert cannot fire and the backlog panel reads a confident, permanent zero. The scheduler role refreshes it; check that role is running. |
| `WebhookDeliveriesExhausting` | `rate(deliveries_completed_total{outcome="exhausted"}) > 0.1/s` for 10 m | warning | Deliveries are running out of retry budget and will never be attempted again without replay. One customer's endpoint down for the whole window, or, if fleet-wide, something on your side. Cross-check `egress_http_responses_total{class="error"}`. |
| `WebhookOutboxLagHigh` | `max(outbox_pending_age_seconds) > 300` for 10 m | warning | The router is not draining the outbox. Every second here is latency before a delivery row even exists, so nothing downstream shows it. Check router pods and `router_events_routed_total` for `parked` or `retried`. |
| `WebhookEgressBlockedMetadataAddress` | `increase(egress_blocked_total{reason="metadata"}[15m]) > 0` | critical | A registered endpoint pointed at the cloud instance metadata service. The guard held; the attempt is the signal. Find the endpoint in the delivery log, then who registered it. |
| `WebhookEgressBlockedSpike` | `rate(egress_blocked_total{reason!="metadata"}) > 1/s` for 15 m | info | Usually a customer who configured an internal URL and is watching every delivery fail permanently. Tell them; no retry will fix it. |
| `WebhookRateLimiterDegraded` | `rate(rate_limiter_degraded_total) > 0` for 10 m | warning | Redis is unreachable. Limits are per replica: the effective ceiling is roughly N x what was configured. Nothing fails while this is true, which is why it needs an alert. |
| `WebhookCircuitBreakersOpeningRapidly` | `rate(circuit_breaker_open_total) > 0.5/s` for 10 m | warning | A burst for one customer is normal. A sustained fleet-wide rate is usually you: check error classes and DNS. Deliveries held behind an open breaker make no attempts and are visible only in `queue_depth`. |
| `WebhookIngestRejectionRatioHigh` | rejected / (accepted + rejected) > 10% for 15 m | warning | Break `events_ingestion_failed_total` down by `reason`. A publisher that just deployed shows as one reason dominating. |
| `WebhookPayloadOffloadFailing` | `rate(payload_offloads_total{outcome="error"}) > 0` for 10 m | critical | Oversized payloads cannot reach object storage. A failed offload is a 500 to the publisher, never a 202: dropped ingest. Check bucket credentials and reachability. |

There is deliberately no rule for "circuit breakers currently open" or
"endpoints disabled": no such gauge exists, and a rule against a series that
is never written always looks healthy.

### Other series worth a dashboard panel

| Metric | Says |
|---|---|
| `queue_depth{state}` | Work that is not happening. `ready` growing means workers cannot keep up; `delayed` growing means backoff; `in_flight` pinned at the pool size means saturation. Refreshed every 15 s by the scheduler; goes stale, not zero, if the scheduler is down, so check `up` first. |
| `queue_head_of_line_delay_seconds` | Tenant starvation. The number that decides whether to switch `CLAIM_STRATEGY` to `tenant_fair`. |
| `rate_limit_hits_total{scope}` | Which ceiling bit. `endpoint_concurrency` climbing while deliveries are slow means a few slow endpoints are holding the pool (the isolation rule in [Requirements](/self-hosting/01-requirements)). |
| `router_outbox_parked_total{reason}` | An event will not be delivered until an operator requeues it. Any non-zero value is an incident. Reasons: `attempts_exhausted`, `retry_duration_exceeded`, `unknown_outbox_type`, `event_missing`. |
| `router_subscriptions_skipped_total{reason}` | A subscription was considered and not delivered to. Answers "we configured it, why is nothing arriving" without a database session. |
| `router_fan_out_batches_total` | Some events are wider than one fan-out transaction. A capacity signal, not an error. |
| `queue_leases_reclaimed_total` | Workers are dying mid-attempt. |
| `queue_leases_lost_total{phase}` | Leases lapsing under live attempts: duplicates are being sent. |
| `egress_blocked_total{reason}` | SSRF refusals by bounded code (`metadata`, `private`, `loopback`, `link_local`, `redirect`, ...). Never labelled by customer text. |
| `payload_orphan_objects_total{outcome="leaked"}` | Ingest failed after a payload upload. Storage cost only; the sweep reclaims it. |
| `delivery_rate_limit_fleet_wide` | 0 while limits are per replica. |

## The Grafana dashboard

One dashboard, "Webhook platform - delivery", ships with the release (as JSON
to import, or via the Helm sidecar toggle). Every panel is backed by a series
the platform writes.

| Row | Panels |
|---|---|
| Ingest: is work arriving, and is any of it being refused? | Events accepted /s, Rejected /s, Ingest rate by outcome, Payload offloads and fetches |
| Delivery: what happened to the events we accepted? | Delivery outcomes /s, Outbound response classes /s, Attempt latency, End-to-end delivery latency (acceptance to first success), First-attempt success ratio, Retries scheduled /s, Deliveries created /s, Attempts in flight |
| Backlog: is work piling up faster than it drains? | Queue depth by state, Head-of-line delay, Outbox age, Lease churn, Router outcomes /s |
| Endpoint health and egress safety | Circuit breakers opening /s, SSRF refusals /s by reason, Rate limit deferrals /s by scope, Rate limiter running without its shared store, Fan-out size |

**The one panel to read first at 2am is "Queue depth by state".** A delivery
held back by an open breaker or a rate limit produces no attempt, no response
class and no latency sample: it is work that is not happening, and counters of
things that happened cannot show it. `ready` climbing while the attempt rate
stays flat is that failure, and this is the only place it is visible.

## OpenTelemetry

Traces are exported over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
Unset means off, and off means nothing is constructed at all: no exporter, no
processor, no provider, nothing to sit retrying against a collector that does
not exist.

| Variable | Control API | Data plane |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL, `/v1/traces` appended. Scheme required; refused at boot without it. | Same. A bad value logs `OTEL_EXPORTER_OTLP_ENDPOINT is not a usable collector URL; tracing is DISABLED` and continues. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal-specific override; takes precedence and is the one validated. | Same. |
| `OTEL_SERVICE_NAMESPACE` | `service.namespace`; separates two installs on one collector. | Same key. |
| Service name | `OTEL_SERVICE_NAME`, default `control-api` | `DATA_PLANE_OTEL_SERVICE_NAME`, default `data-plane`. **No fallback** to the bare key. |
| Sampling ratio | `OTEL_TRACES_SAMPLER_ARG`, default 1 | `DATA_PLANE_OTEL_TRACES_SAMPLER_ARG`, default 0.05. **No fallback** to the bare key. |
| Other `OTEL_EXPORTER_OTLP_*`, `OTEL_BSP_*` | Standard variables; read by the exporter. | Same. |

**Why the two planes must not share a sampling ratio.** Both read the same
ConfigMap. The control plane is the operator surface: its request rate is small
and losing the one slow request costs a lot, so it samples everything. The data
plane records a span per attempt of every delivery of every event; at a ratio
of 1 that is a span volume nobody asked for. Inheriting the control plane's
name would also make every delivery span claim to come from the control API.
So the data plane reads its own two keys and ignores the bare ones.

Sampling is parent-based, but a remote `traceparent` is capped at the configured
ratio rather than obeyed: it is an unauthenticated header on an internet-facing
API, and a caller, including one being refused at the login rate limiter, must
not get to set your span volume.

The worker writes the trace id of each attempt into the delivery log
(`delivery_attempts.trace_id`), only when the trace was actually sampled, so a
non-null id is a promise the backend can keep.

## Logs

Both planes log JSON to stdout, one object per line.

| Plane | Shape |
|---|---|
| Data plane | `slog` JSON with a `service` field (`ingest`, `router`, `scheduler`, `worker`). When tracing is on, lines inside a traced operation carry `trace_id` and `span_id`. Values for keys named `authorization`, `cookie`, `secret`, `password`, `api_key`, `signing_secret`, `encryption_key`, `token` and `webhook-signature` are replaced with `[redacted]`: present, so you can see they were there, never readable. |
| Control API | `pino` JSON via `nestjs-pino`, one line per request with the request id, and `trace_id` on every line when tracing is on. |

`LOG_LEVEL` applies to both. The data plane maps `trace` to debug and `fatal`
to error.

Lines worth searching for:

| Line | Meaning |
|---|---|
| `data plane starting` | Boot, with the resolved configuration (secrets redacted). |
| `worker started` with `concurrency` and `max_conns_per_host` | The two ceilings the isolation rule depends on. |
| `per-endpoint concurrency is a CEILING, not a reservation` | Advisory at startup: fewer than eight endpoints at the per-endpoint cap would fill the pool. |
| `REDIS_URL is not set; endpoint delivery rate limits are enforced PER REPLICA` | Running without Redis. |
| `object storage is not configured; payloads at or above the inline limit will be rejected` | No bucket. |
| `shutdown signal received; readiness now reports draining` | SIGTERM handled. |
| `trust proxy: 0 hops` | Control API is not reading `X-Forwarded-For`. Correct only with no proxy in front. |
| `Failed to send <kind> to <hash>@domain` | SMTP is configured but not accepting mail. |

---

**Where this comes from.** `services/data-plane/internal/httpx/health.go`, `services/data-plane/cmd/webhookd/main.go` (readiness checks, shutdown), `apps/control-api/src/health/health.controller.ts`, `deployments/observability/README.md`, `deployments/observability/prometheus/{alerts,scrape-config}.yaml`, `docs/FAILURE_RECOVERY.md` Appendix B, `deployments/helm/webhook-platform/dashboards/webhook-platform.json` (panel titles), `services/data-plane/internal/tracing/{tracing,context}.go`, `services/data-plane/internal/logging/logging.go`, `apps/control-api/src/config/env.schema.ts` (OTEL keys).
