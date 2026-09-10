# Helm

The recommended way to run hookubit on Kubernetes. The chart is
`deployments/helm/webhook-platform` in the release; it installs six stateless
workloads, no database, and refuses to install without the things it cannot
run without.

Requires Kubernetes 1.25 or newer. There are no chart dependencies on purpose:
a bundled PostgreSQL subchart is the fastest way to lose a customer's delivery
history to `helm uninstall`.

## The six-step install

```bash
# 1. Provision PostgreSQL 15+ (external, yours, backed up by you).
#    Production topology: app -> PgBouncer -> PostgreSQL.

# 2-4. Secrets. There are no defaults, ever.
kubectl create namespace webhook-platform
kubectl -n webhook-platform create secret generic webhook-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=SMTP_URL='smtp://user:pass@mail.example.com:587'

helm upgrade --install webhooks deployments/helm/webhook-platform \
  -n webhook-platform \
  --set externalDatabase.url='postgresql://u:p@pgbouncer:6432/webhook_platform?schema=public&sslmode=require' \
  --set externalDatabase.directUrl='postgresql://u:p@db:5432/webhook_platform?schema=public&sslmode=require' \
  --set externalRedis.url='rediss://redis:6379/0' \
  --set secrets.existingSecret=webhook-secrets \
  --set app.publicUrl=https://webhooks.example.com \
  --set app.mailFrom='Hookubit <no-reply@example.com>' \
  --set ingress.enabled=true \
  --set ingress.appHost=webhooks.example.com \
  --set ingress.ingestHost=ingest.example.com

# 5. Migrations: explicit, separate, never on application start.
helm upgrade webhooks deployments/helm/webhook-platform -n webhook-platform \
  --reuse-values --set migrations.enabled=true
kubectl -n webhook-platform wait --for=condition=complete --timeout=10m \
  job -l app.kubernetes.io/component=migrate
helm upgrade webhooks deployments/helm/webhook-platform -n webhook-platform \
  --reuse-values --set migrations.enabled=false

# 6. Verify, then create the first owner.
kubectl -n webhook-platform rollout status deploy/webhooks-webhook-platform-control-api
```

`helm install` prints the full notes, including a ready-to-paste bootstrap Job
for your release name. The bootstrap reads `BOOTSTRAP_EMAIL`,
`BOOTSTRAP_PASSWORD` and `BOOTSTRAP_ORG` from its environment. Put them in a
Secret and run one Job that sources it, then delete both. Do not pass them as
`kubectl exec -- env ...` arguments: that puts the owner password in shell
history and in the API server audit log.

> **The worker needs the encryption key too.** With the default
> `dataPlane.separateSecret: true`, the four Go roles receive their own Secret
> holding `DATABASE_URL`, `REDIS_URL`, the S3 credentials and
> `ENCRYPTION_KEY` - the worker decrypts endpoint signing secrets with it and
> refuses to start without it (`build decryption keyring: ENCRYPTION_KEY is
> required`). It never receives `JWT_SECRET`, `SESSION_SECRET` or `SMTP_URL`.
> If you keep `ENCRYPTION_KEY` in `secrets.existingSecret` rather than
> `secrets.encryptionKey`, remember that the data plane does not read that
> Secret: put the key in `externalDatabase.existingSecret` as well (both planes
> read it), or set `dataPlane.separateSecret=false`. Rotation values
> (`ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_RETIRED`) reach both planes through
> `extraEnv` or that same shared Secret.

## Install-time guards

The chart fails at render time, with a message that names the fix, rather than
letting you discover the problem from a crash loop. Verbatim:

| Condition | Message |
|---|---|
| No `externalDatabase.url` | Rejected by the values schema: `externalDatabase.url` is required and must match `^postgres(ql)?://`. `helm install` with default values fails before anything is created. |
| No `secrets.jwtSecret` and no `secrets.existingSecret` | `secrets.jwtSecret is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 48) or point at a Secret you manage. This chart creates no default credentials.` |
| No `secrets.sessionSecret` and no `secrets.existingSecret` | `secrets.sessionSecret is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 48). It is NOT defaulted to jwtSecret: one key signing both API tokens and session cookies makes rotating either one invalidate both, and leaking either one leak both.` |
| No `secrets.encryptionKey` and no `secrets.existingSecret` | `secrets.encryptionKey is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 32, must decode to exactly 32 bytes).` |
| No `secrets.smtpUrl` and no `secrets.existingSecret` | `secrets.smtpUrl is empty and secrets.existingSecret is unset. Outbound mail (email verification, password reset, invitations) needs an SMTP URL, and the control API refuses to boot outside development without one - so this chart refuses to install without one, rather than deploying a service in which nobody can ever verify an address.` |
| `egress.allowPrivateNetworks: true` with `app.env: production` | `egress.allowPrivateNetworks: true is rejected by the data plane when app.env is production - every Go role would exit at startup. Use egress.privateAllowlist with specific CIDRs (e.g. '10.20.0.0/16'), which works in production, or set app.env=staging if this really is not a production install.` |
| `migrations.enabled: true` with no `externalDatabase.directUrl` and no `externalDatabase.existingSecret` | `migrations.enabled is true but externalDatabase.directUrl is empty. Migrations must bypass PgBouncer: transaction pooling breaks DDL and the session-scoped advisory lock Prisma takes, which can leave a half-applied migration. Set externalDatabase.directUrl to a DIRECT connection (port 5432, not the pooler), or supply DIRECT_DATABASE_URL via externalDatabase.existingSecret.` |

Setting `secrets.existingSecret` satisfies the four secret guards. The chart
does not check that the Secret actually contains the keys; the control API
does, at boot, and fails by name.

## Secrets you manage: `existingSecret`

Environment is layered in this order, and later entries win on duplicate keys:

1. the chart ConfigMap
2. the chart Secret (`<release>-secrets`)
3. `externalDatabase.existingSecret`
4. `externalRedis.existingSecret`
5. `secrets.existingSecret`

So pointing at External Secrets Operator, Vault or SOPS needs no template
change: set the `existingSecret` names and the chart's own rendered values are
overridden. `externalDatabase.url` is still required by the schema; set it to
the same value or accept that the Secret wins.

The Go roles get a shorter chain: ConfigMap, then their own Secret (or the
chart Secret when `dataPlane.separateSecret=false`), then the database and Redis
`existingSecret`s. `secrets.existingSecret` is deliberately not in it, so the
process that dials customer URLs never holds the session-signing key.

> Secrets given as values (`--set secrets.jwtSecret=...`) are stored in the
> Helm release history in the cluster. The install notes warn about this. Use
> `existingSecret` for anything beyond a demo.

## The migration job

`migrations.enabled` renders a Job named `<release>-migrate-<revision>`. It is
**not a Helm hook**, on purpose: a `pre-upgrade` hook would let a log-level
change alter the schema. The flow is flip on, wait, flip off, as in step 5
above. Because the name carries the release revision, a second run at the same
revision fails loudly rather than silently doing nothing.

The Job runs the `migrate` image (`<appVersion>-migrate` by default), which is
the control API build with the migration tooling still present. It reads
`DIRECT_DATABASE_URL` through the same `envFrom` chain as the control API, so
your `existingSecret` is honoured.

**Read the upgrade notes before running it.** One migration in the history must
be applied *after* the new data plane is live, not before. See
[Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades).

## Probes

| Workload | Startup | Liveness | Readiness |
|---|---|---|---|
| Control API (`:3000`) | `/health/live`, every 5 s, 24 failures (2 min) | `/health/live`, every 20 s | `/health/ready`: runs `SELECT 1` |
| Go roles (`:9090`) | `/health/live`, every 5 s, 30 failures (150 s); tunable under `dataPlane.startupProbe` | `/health/live`, every 20 s | `/health/ready`: pings the pool; 503 `starting` before the pool is open, 503 `draining` after SIGTERM |
| Dashboard (`:8080`) | none | `GET /` | `GET /` |

**Liveness never touches PostgreSQL.** A database blip that restarted every pod
would turn a recoverable incident into an outage. The startup probe targets
`/health/live` for the same reason: startup means "the process bound its port",
never "it can reach the database". With PostgreSQL down the Go pods stay up,
liveness answers 200, readiness reports `starting`, and traffic is held until
the pool connects. If you lower `dataPlane.startupProbe.failureThreshold` below
the schema floor of 6, a slow node starts to look like a broken image.

Only ingest is behind a Service, so for router, scheduler and worker the
readiness probe is a status signal rather than a traffic one. See
[Observability](/self-hosting/07-observability) for what each response means.

## Rollouts and termination

| Workload | Strategy | Grace period | Why |
|---|---|---|---|
| Control API | RollingUpdate, surge 1, unavailable 0 | 45 s | Above the HTTP server's own drain. |
| Ingest, router | RollingUpdate, surge 1, unavailable 0 | 60 s | Above the data plane's 25 s in-process drain. |
| Scheduler | Recreate | 60 s | Singleton; a rolling update that briefly runs two buys nothing. |
| Worker | RollingUpdate, surge 2, unavailable 0 | 90 s | An attempt can run for `egress.totalTimeoutMs` (30 s). SIGKILL mid-attempt means the delivery waits out its lease (`leaseSeconds`, 120 s) before another worker reclaims it. |

Pods roll automatically when the ConfigMap or Secret changes, via a checksum
annotation, so a value edit takes effect on the next `helm upgrade` rather than
on the next unrelated deploy. On SIGTERM readiness flips to `draining` first and
the process keeps serving for `SHUTDOWN_READINESS_DELAY_MS` (5 s) so load
balancers see it before the socket closes. A drain does not charge in-flight
attempts to the customer's endpoint health.

## Autoscaling, and the database ceiling

`dataPlane.worker.autoscaling` renders a CPU-based HPA (2 to 8 replicas, 70%
target). Scale-up is fast (100% or 4 pods per 30 s); scale-down is deliberately
slow (1 pod per minute after a 5-minute window), because every scale-down
evicts pods mid-delivery.

`maxReplicas` is bounded by the **database**, not by CPU. Each worker pod opens
`externalDatabase.maxConnections` and exits 1 if it cannot; a ceiling the
database cannot serve converts a traffic spike into crash-looping workers.
Before raising either number:

```
(maxReplicas + ingest + router + scheduler) x maxConnections + control API pool
  < max_connections / PgBouncer default_pool_size
```

At the defaults: `(8 + 2 + 2 + 1) x 10 = 130` plus the control API.

There is no memory target. Nothing has measured this workload's memory profile,
and an unmeasured memory metric scales on Go heap retention rather than on
load. CPU is a proxy; queue depth via prometheus-adapter or KEDA is the right
trigger once you have one.

PodDisruptionBudgets: `minAvailable: 1` for control API, dashboard, ingest and
router; `maxUnavailable: 25%` for workers (a percentage because the HPA owns
the count); none for the scheduler, because a budget over a singleton blocks
node drains forever.

## NetworkPolicies

On by default (`networkPolicy.enabled`). The in-process SSRF guard is one
process making one decision about URLs a customer typed; these policies are a
second layer in the kernel that Go cannot bypass.

| Policy | Rule |
|---|---|
| `default-deny` | Every pod, ingress and egress. A workload added later is denied by omission. |
| `allow-dns` | UDP/TCP 53 to `networkPolicy.dnsNamespace` (`kube-system`) only. Without it nothing resolves. |
| `allow-datastore-egress` | Control API, the Go roles and the migration job may reach `datastoreCidrs` (RFC1918 plus `100.64/10`) on `datastorePorts` (5432, 6432, 6379) only. A forged request to `http://10.0.0.5/` is dropped: wrong port. |
| `allow-worker-public-egress` | The worker, and only the worker, to `0.0.0.0/0` on every port, minus `blockedEgressCidrs`: `0/8`, RFC1918, CGNAT, loopback, link-local (the metadata endpoint lives there), `192.0.0.0/24`, benchmarking, multicast, reserved. Router, scheduler and ingest get no internet egress at all. |
| `allow-http-ingress` | Ports 3000 and 8080 on control API, dashboard and ingest, from `ingressControllerNamespace` if set, otherwise from anywhere in the cluster. |
| `allow-metrics-scrape` | Port 9090 on the Go roles, from `monitoringNamespace` if set. |
| `allow-extra-egress` | Whatever you put in `networkPolicy.extraEgress`: an SMTP relay, an OTLP collector in another namespace, IPv6. |

Two ways this breaks an install, both checked before you believe you are
protected:

1. **Your CNI must enforce NetworkPolicy.** Calico, Cilium, Antrea and Weave
   do. Stock EKS without the policy agent, flannel and a default kind or
   minikube accept the objects and silently ignore them. Verify with a test pod.
2. **A database on a public address is not covered.** Neon, Upstash, Supabase,
   a public RDS endpoint: none are in private space, and the control plane
   fails readiness with a connection timeout. Add the provider's range to
   `datastoreCidrs`, or set `networkPolicy.enabled=false` and write down why.

The worker egress rule allows every port because `https://hooks.example.com:8443`
is a legal endpoint. Narrowing it to 80/443 would drop those deliveries into a
retry loop with no diagnosable cause. IPv6 egress is not granted; add an
`::/0` rule with `fc00::/7`, `::1/128`, `fe80::/10` and `64:ff9b::/96` excepted
via `extraEgress` if you need it. Never a bare `::/0`: it reopens the NAT64
spelling of the metadata address.

## Behind a proxy: the hop count

`ingress.trustedProxyHops` (default `1`) is rendered into both
`TRUST_PROXY_HOPS` (control API) and `INGEST_TRUSTED_PROXY_HOPS` (ingest),
whether or not the chart's own Ingress is enabled - on Kubernetes something is
in front of the pods either way. It is the **exact** number of proxies between
the internet and the pods: the ingress controller is 1; a CDN or a cloud load
balancer that rewrites `X-Forwarded-For` in front of it makes 2.

```bash
--set ingress.trustedProxyHops=2      # CDN -> ingress controller -> pod
```

Too low and every request is attributed to the proxy's own address, so per-IP
rate limiting collapses into one bucket for the whole internet and a trickle of
anonymous requests locks everybody out of login. Too high and a client can
forge `X-Forwarded-For` and get a fresh bucket per request. The schema refuses
anything outside 0..10; set 0 only if clients really reach the pods directly.

## The Grafana dashboard sidecar

`observability.grafanaDashboard.enabled` ships the delivery dashboard as a
ConfigMap labelled for the Grafana sidecar (`kiwigrid/k8s-sidecar`, which the
Grafana and kube-prometheus-stack charts both run). Off by default because it
fails silently in two ways: with no sidecar it is an inert ConfigMap, and with
a label the sidecar is not watching it is an invisible one. Check
`sidecar.dashboards.label` in your Grafana values, set
`observability.grafanaDashboard.label` to match, then look for the dashboard
rather than assuming it arrived. `folder` files it into a Grafana folder via
`folderAnnotation`.

The panels are described in [Observability](/self-hosting/07-observability).

## Integers, and why `--set` is safe

Helm parses numbers in a values file as floating point. Rendered naively,
`1048576` becomes `"1.048576e+06"`, which the data plane cannot parse as an
integer, so it silently falls back to its built-in default while the ConfigMap
shows you the value you set. `PAYLOAD_MAX_BYTES` shipped that way once.

The chart now pipes every integer knob through `int64` before quoting, so
values files, `--set` and `--set-string` all render correctly for the keys the
chart owns. `--set` is additionally safe on its own because Helm parses
`--set key=1048576` as an integer, not a float.

The one place you must be careful is `extraEnv`, which the chart renders
verbatim. Quote large numbers there as strings (`PAYLOAD_SWEEP_MAX_DELETES:
"1000"`) rather than writing bare integers in a values file.

## The dashboard image

`dashboard.build.ingestBaseUrl` and `dashboard.build.apiTransport` are not
settings. The dashboard is a static bundle: its values were inlined when the
image was built and nginx reads no environment. Those two keys record what the
image in `dashboard.image` was built with, and are rendered as annotations on
the Deployment so `kubectl describe` can answer "why does the get-started curl
point at localhost". The install notes warn when `ingestBaseUrl` is empty,
disagrees with `ingress.ingestHost`, or `apiTransport` is `mock` (which shows a
permanent "Demo data" banner). To change either, build the image:

```bash
docker build -f deployments/docker/dashboard.Dockerfile \
  --build-arg VITE_INGEST_BASE_URL=https://ingest.example.com \
  --build-arg VITE_API_TRANSPORT=http \
  -t ghcr.io/shaq/webhook-dashboard:<tag> .
```

Also note: the control API does not serve `/docs` when `app.env` is
`production`. The Ingress routes the path; it answers nothing there.

## Values reference

Generated from the chart's `values.yaml`. Every key, its default, and what it
does. Keys the chart has no value for are set through `extraEnv`; the full
environment reference is in [Configuration](/self-hosting/05-configuration).

### Naming and global

| Key | Default | What it does |
|---|---|---|
| `nameOverride` | `''` | Overrides the chart name used in resource names. |
| `fullnameOverride` | `''` | Overrides the full release-derived resource name prefix. |
| `global.imageRegistry` | `ghcr.io/shaq` | Prefix for all three images. Point at an internal mirror if you cannot pull from `ghcr.io`. |
| `global.imagePullSecrets` | `[]` | Pull secrets applied to every pod. |
| `global.nodeSelector` | `{}` | Node selector applied to every pod; useful for a dedicated node pool. |
| `global.tolerations` | `[]` | Tolerations applied to every pod. |

### External PostgreSQL (required)

| Key | Default | What it does |
|---|---|---|
| `externalDatabase.directUrl` | `''` | Direct (non-pooled) PostgreSQL URL used only by the migration job. Empty falls back to `url`, and the chart then refuses to render the migration job (see guards). |
| `externalDatabase.maxConnections` | `10` | Per-pod pool size for the Go roles (`DATABASE_MAX_CONNECTIONS`). Every data-plane pod opens this many; a pod that cannot get them exits 1. Sizes the worker ceiling. |
| `externalDatabase.existingSecret` | `''` | Name of a Secret you manage carrying `DATABASE_URL` (and `DIRECT_DATABASE_URL` if you run migrations from the chart). Wins over `url`. |

### External Redis (optional)

| Key | Default | What it does |
|---|---|---|
| `externalRedis.url` | `''` | Optional `redis://` or `rediss://` URL. Empty disables Redis: the platform runs, with delivery rate limits enforced per replica (and refuses in production unless acknowledged). |
| `externalRedis.existingSecret` | `''` | Secret carrying `REDIS_URL`. |

### Application secrets

| Key | Default | What it does |
|---|---|---|
| `secrets.existingSecret` | `''` | Secret carrying `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `SMTP_URL` (and, if you rotate keys, `ENCRYPTION_KEY_ID` / `ENCRYPTION_KEYS_RETIRED`). Use this for anything beyond a demo; values-supplied secrets end up in the Helm release history. |
| `secrets.jwtSecret` | `''` | API token signing key. `openssl rand -base64 48`. |
| `secrets.sessionSecret` | `''` | Session cookie signing key. Deliberately not defaulted to `jwtSecret`. |
| `secrets.encryptionKey` | `''` | AES-256-GCM key for stored endpoint signing secrets. Must decode to exactly 32 bytes. Changing it without re-encrypting makes every stored secret unreadable. |
| `secrets.smtpUrl` | `''` | `smtp://` or `smtps://` URL with credentials. Required: the control API refuses to boot outside development without it. |

### Object storage (optional)

| Key | Default | What it does |
|---|---|---|
| `objectStorage.endpoint` | `''` | S3-compatible endpoint URL (`S3_ENDPOINT`). Empty means no object storage: payloads at or above `payload.inlineMaxBytes` are rejected. |
| `objectStorage.bucket` | `''` | Bucket for oversized payloads (`S3_BUCKET`). |
| `objectStorage.region` | `us-east-1` | Bucket region (`S3_REGION`). |
| `objectStorage.accessKey` | `''` | Access key; rendered into the Secret only when set. |
| `objectStorage.secretKey` | `''` | Secret key; rendered into the Secret only when set. |
| `objectStorage.forcePathStyle` | `false` | Path-style addressing (`S3_FORCE_PATH_STYLE`). Needed for MinIO and most non-AWS stores. |

### Application

| Key | Default | What it does |
|---|---|---|
| `app.env` | `production` | `APP_ENV`: `production`, `staging` or `development`. Production and staging refuse to boot without SMTP; production refuses `egress.allowPrivateNetworks` and Redis-less rate limits. |
| `app.logLevel` | `info` | `LOG_LEVEL` for both planes. |
| `app.allowOpenRegistration` | `false` | Self-serve signup (`ALLOW_OPEN_REGISTRATION`). Keep false on anything internet-facing; create the first owner with the bootstrap job. |
| `app.publicUrl` | `'https://webhooks.example.com'` | Public origin of the dashboard and control API. Becomes `CONTROL_API_URL`, `DASHBOARD_URL` (base of every link in outbound mail) and `CORS_ORIGINS`. |
| `app.mailFrom` | `'Hookubit <no-reply@example.com>'` | `MAIL_FROM`: the From header, e.g. `Hookubit <no-reply@example.com>`. Required whenever SMTP is set; the display name is the product name in subjects. |

### Outbound HTTP (egress)

| Key | Default | What it does |
|---|---|---|
| `egress.dnsTimeoutMs` | `2000` | Bounds name resolution alone. Keep below `connectTimeoutMs`; 0 merges it back into the connect budget. |
| `egress.connectTimeoutMs` | `3000` | TCP connect timeout for an outbound attempt. |
| `egress.tlsTimeoutMs` | `3000` | TLS handshake timeout. |
| `egress.responseHeaderTimeoutMs` | `10000` | How long to wait for the endpoint's response headers. |
| `egress.totalTimeoutMs` | `30000` | Ceiling on one whole outbound attempt. `dataPlane.worker.leaseSeconds` must exceed it. |
| `egress.maxResponseBytes` | `65536` | Bytes of an endpoint's response body read and stored per attempt. |
| `egress.maxRedirects` | `0` | Redirects followed. 0 by design: a redirect is a second SSRF decision. |
| `egress.maxConnsPerHost` | `null` | Concurrent connections to one destination `host:port`, shared by every endpoint and tenant resolving there. `null` follows `dataPlane.worker.concurrency`. Lower than the pool silently overrides the concurrency gates. |
| `egress.allowPrivateNetworks` | `false` | Disables the SSRF guard's private-range refusal. Cannot be combined with `app.env=production`: the chart fails at render time. Prefer `privateAllowlist`. |
| `egress.privateAllowlist` | `''` | Comma-separated CIDRs that may be delivered to despite being private. The supported way to reach internal consumers; works in production. |

### Concurrency ceilings

| Key | Default | What it does |
|---|---|---|
| `concurrency.global` | `512` | `MAX_CONCURRENCY_GLOBAL`: in-flight attempts per process across all tenants. |
| `concurrency.perOrg` | `128` | `MAX_CONCURRENCY_PER_ORG`. |
| `concurrency.perProject` | `64` | `MAX_CONCURRENCY_PER_PROJECT`. |
| `concurrency.perEndpoint` | `16` | `MAX_CONCURRENCY_PER_ENDPOINT`. Must not exceed `perProject`. A ceiling, not a reservation (see Requirements). |

### Payload sizes

| Key | Default | What it does |
|---|---|---|
| `payload.inlineMaxBytes` | `65536` | `PAYLOAD_INLINE_MAX_BYTES`: payloads at or above this go to object storage instead of the database row. |
| `payload.maxBytes` | `1048576` | `PAYLOAD_MAX_BYTES`: largest event accepted at all. Must be at least `inlineMaxBytes`. |

### Observability

| Key | Default | What it does |
|---|---|---|
| `observability.otlpEndpoint` | `''` | OTLP/HTTP collector base URL (`http://` or `https://` required). Empty disables tracing entirely. |
| `observability.serviceNamespace` | `webhook-platform` | `service.namespace` on every span; separates two installs sharing a collector. |
| `observability.serviceName` | `control-api` | `service.name` for the control API. |
| `observability.tracesSamplerArg` | `1` | Control-plane head sampling ratio, 0..1. A remote `traceparent` is capped at it, not obeyed. |
| `observability.dataPlaneServiceName` | `data-plane` | `service.name` for the four Go roles. No fallback to `serviceName`. |
| `observability.dataPlaneTracesSamplerArg` | `0.05` | Data-plane head sampling ratio. No fallback to `tracesSamplerArg`; at 1 it records a span for every attempt. |
| `observability.prometheusAnnotations` | `true` | Adds `prometheus.io/scrape`, `prometheus.io/port` and `prometheus.io/path` annotations to data-plane pods. |
| `observability.grafanaDashboard.enabled` | `false` | Ships the delivery dashboard as a ConfigMap for a Grafana sidecar. Inert without a sidecar; invisible if the label does not match. |
| `observability.grafanaDashboard.label` | `grafana_dashboard` | Label key the sidecar watches (`sidecar.dashboards.label` in the Grafana chart). |
| `observability.grafanaDashboard.labelValue` | `'1'` | Label value the sidecar matches. |
| `observability.grafanaDashboard.folderAnnotation` | `grafana_folder` | Annotation the sidecar reads to file the dashboard into a folder. |
| `observability.grafanaDashboard.folder` | `''` | Grafana folder name. Empty uses the default folder. |

### Extra environment and service account

| Key | Default | What it does |
|---|---|---|
| `extraEnv` | `{}` | Free-form extra environment for every workload, rendered into the ConfigMap. The route to any key the chart has no value for. Never put secrets here. |
| `serviceAccount.create` | `true` | Create a ServiceAccount (with `automountServiceAccountToken: false`; nothing talks to the Kubernetes API). |
| `serviceAccount.name` | `''` | Name of the ServiceAccount to create or use. |
| `serviceAccount.annotations` | `{}` | Annotations on the ServiceAccount (IRSA, Workload Identity). |

### Control API

| Key | Default | What it does |
|---|---|---|
| `controlApi.endpointAutoDisable.enabled` | `true` | Disable endpoints whose breaker has been continuously open (`ENDPOINT_AUTO_DISABLE_ENABLED`). |
| `controlApi.endpointAutoDisable.afterHours` | `72` | Hours of continuous open breaker before disabling. Floor 24 (a delivery's own retry window). |
| `controlApi.endpointAutoDisable.intervalMinutes` | `15` | How often the sweep runs. |
| `controlApi.endpointAutoDisable.maxPerRun` | `200` | Endpoints one sweep may disable. |
| `controlApi.image.repository` | `webhook-control-api` | Control API image name under `global.imageRegistry`. |
| `controlApi.image.tag` | `''` | Image tag. Empty uses the chart `appVersion`. |
| `controlApi.image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `controlApi.replicaCount` | `2` | Control API replicas. Never in the delivery hot path; 2 is for availability, not throughput. |
| `controlApi.resources.requests.cpu` | `200m` | CPU request. |
| `controlApi.resources.requests.memory` | `256Mi` | Memory request. |
| `controlApi.resources.limits.cpu` | `'1'` | CPU limit. |
| `controlApi.resources.limits.memory` | `768Mi` | Memory limit. |
| `controlApi.podDisruptionBudget.enabled` | `true` | Create a PDB. |
| `controlApi.podDisruptionBudget.minAvailable` | `1` | PDB `minAvailable`. |
| `controlApi.nodeSelector` | `{}` | Overrides `global.nodeSelector` for this workload. |
| `controlApi.tolerations` | `[]` | Overrides `global.tolerations`. |
| `controlApi.affinity` | `{}` | Pod affinity rules. |

### Dashboard

| Key | Default | What it does |
|---|---|---|
| `dashboard.image.repository` | `webhook-dashboard` | Dashboard image name. |
| `dashboard.image.tag` | `''` | Image tag. Empty uses the chart `appVersion`. |
| `dashboard.image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `dashboard.build.ingestBaseUrl` | `''` | **Not a setting.** Records the `VITE_INGEST_BASE_URL` the image was built with; rendered as a Deployment annotation. Empty means the get-started page tells operators to publish to `http://localhost:8080`. |
| `dashboard.build.apiTransport` | `'mock'` | **Not a setting.** Records `VITE_API_TRANSPORT` (`mock` or `http`) the image was built with. A `mock` image shows a permanent demo-data banner. |
| `dashboard.replicaCount` | `2` | Dashboard (nginx) replicas. |
| `dashboard.resources.requests.cpu` | `10m` | CPU request. |
| `dashboard.resources.requests.memory` | `32Mi` | Memory request. |
| `dashboard.resources.limits.cpu` | `200m` | CPU limit. |
| `dashboard.resources.limits.memory` | `128Mi` | Memory limit. |
| `dashboard.podDisruptionBudget.enabled` | `true` | Create a PDB. |
| `dashboard.podDisruptionBudget.minAvailable` | `1` | PDB `minAvailable`. |
| `dashboard.nodeSelector` | `{}` | Overrides `global.nodeSelector`. |
| `dashboard.tolerations` | `[]` | Overrides `global.tolerations`. |
| `dashboard.affinity` | `{}` | Pod affinity rules. |

### Data plane: image, secret, probes

| Key | Default | What it does |
|---|---|---|
| `dataPlane.image.repository` | `webhook-data-plane` | Data plane image; all four roles run it and differ by argument. |
| `dataPlane.image.tag` | `''` | Image tag. Empty uses the chart `appVersion`. |
| `dataPlane.image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `dataPlane.separateSecret` | `true` | Give the Go roles their own Secret without `JWT_SECRET`/`SESSION_SECRET`. See the defect note below before relying on the default. |
| `dataPlane.startupProbe.enabled` | `true` | Startup probe on `/health/live` for the Go roles; suspends liveness while a pod binds its port. |
| `dataPlane.startupProbe.periodSeconds` | `5` | Probe period. |
| `dataPlane.startupProbe.failureThreshold` | `30` | Failures allowed; `period x threshold` is the whole boot budget (150 s by default). Floor 6. |
| `dataPlane.startupProbe.timeoutSeconds` | `3` | Probe timeout. |

### Data plane: ingest, router, scheduler

| Key | Default | What it does |
|---|---|---|
| `dataPlane.ingest.replicaCount` | `2` | Ingest replicas (the public write path). |
| `dataPlane.ingest.resources.requests.cpu` | `100m` | CPU request. |
| `dataPlane.ingest.resources.requests.memory` | `64Mi` | Memory request. |
| `dataPlane.ingest.resources.limits.cpu` | `500m` | CPU limit. |
| `dataPlane.ingest.resources.limits.memory` | `256Mi` | Memory limit. |
| `dataPlane.ingest.podDisruptionBudget.enabled` | `true` | Create a PDB. Ingest is the one role a node drain must never fully evict. |
| `dataPlane.ingest.podDisruptionBudget.minAvailable` | `1` | PDB `minAvailable`. |
| `dataPlane.router.replicaCount` | `2` | Router replicas. Safe above 1: fan-out inserts are keyed on `(event, endpoint)`. |
| `dataPlane.router.resources.requests.cpu` | `100m` | CPU request. |
| `dataPlane.router.resources.requests.memory` | `64Mi` | Memory request. |
| `dataPlane.router.resources.limits.cpu` | `500m` | CPU limit. |
| `dataPlane.router.resources.limits.memory` | `256Mi` | Memory limit. |
| `dataPlane.router.podDisruptionBudget.enabled` | `true` | Create a PDB. |
| `dataPlane.router.podDisruptionBudget.minAvailable` | `1` | PDB `minAvailable`. |
| `dataPlane.scheduler.replicaCount` | `1` | Scheduler replicas. Schema caps it at 1: a second one only duplicates polling. Rolled with `Recreate`. |
| `dataPlane.scheduler.resources.requests.cpu` | `50m` | CPU request. |
| `dataPlane.scheduler.resources.requests.memory` | `64Mi` | Memory request. |
| `dataPlane.scheduler.resources.limits.cpu` | `250m` | CPU limit. |
| `dataPlane.scheduler.resources.limits.memory` | `128Mi` | Memory limit. |
| `dataPlane.scheduler.podDisruptionBudget.enabled` | `false` | Keep false: a PDB over a singleton blocks node drains forever. |

### Data plane: worker and autoscaling

| Key | Default | What it does |
|---|---|---|
| `dataPlane.worker.replicaCount` | `2` | Worker replicas when autoscaling is off. The throughput dial. |
| `dataPlane.worker.concurrency` | `64` | `WORKER_CONCURRENCY`: in-flight deliveries per worker pod. |
| `dataPlane.worker.pollIntervalMs` | `250` | How often an idle worker polls for claimable deliveries. |
| `dataPlane.worker.claimBatchSize` | `100` | Deliveries claimed per poll. |
| `dataPlane.worker.dbTimeoutMs` | `5000` | `WORKER_DB_TIMEOUT_MS`: deadline for one database call on the delivery path. Must not exceed the server statement timeout. |
| `dataPlane.worker.allowPerReplicaRateLimits` | `false` | `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA`: acknowledge that without Redis an endpoint's rate limit is multiplied by the replica count. Required to start in production without `externalRedis.url`. |
| `dataPlane.worker.leaseSeconds` | `120` | `DELIVERY_LEASE_SECONDS`: a claimed delivery whose lease lapses is reclaimable by another worker. Must exceed `egress.totalTimeoutMs`. Floor 30. |
| `dataPlane.worker.resources.requests.cpu` | `250m` | CPU request. |
| `dataPlane.worker.resources.requests.memory` | `128Mi` | Memory request. |
| `dataPlane.worker.resources.limits.cpu` | `'1'` | CPU limit. |
| `dataPlane.worker.resources.limits.memory` | `512Mi` | Memory limit. |
| `dataPlane.worker.autoscaling.enabled` | `true` | Create a CPU-based HPA for workers. |
| `dataPlane.worker.autoscaling.minReplicas` | `2` | HPA floor. |
| `dataPlane.worker.autoscaling.maxReplicas` | `8` | HPA ceiling. A **database** ceiling: `(maxReplicas + ingest + router + scheduler) x externalDatabase.maxConnections` plus the control API pool must fit your `max_connections` / PgBouncer pool. |
| `dataPlane.worker.autoscaling.targetCPUUtilizationPercentage` | `70` | CPU target. A proxy: workers are I/O bound, and queue depth is the better signal once you have a metrics adapter. |
| `dataPlane.worker.podDisruptionBudget.enabled` | `true` | Create a PDB. |
| `dataPlane.worker.podDisruptionBudget.maxUnavailable` | `25%` | PDB as a percentage, because the HPA owns the replica count. |

### Data plane: retention and outbox

| Key | Default | What it does |
|---|---|---|
| `dataPlane.retention.enabled` | `true` | `RETENTION_ENABLED`: sweep the delivery ledger on a schedule (scheduler role). |
| `dataPlane.retention.deliveryAgeDays` | `90` | `RETENTION_DELIVERY_AGE_DAYS`: age at which delivery summary rows are deleted. Floor 48 h. |
| `dataPlane.retention.attemptAgeDays` | `60` | `RETENTION_ATTEMPT_AGE_DAYS`: age at which per-attempt rows (headers, bodies) are deleted. Floor 48 h; must not exceed `deliveryAgeDays`. |
| `dataPlane.retention.intervalMs` | `3600000` | How often the sweep runs. |
| `dataPlane.retention.batchSize` | `1000` | Rows deleted per statement. |
| `dataPlane.retention.maxDeletesPerRun` | `50000` | Cap per pass, so a first sweep of a never-pruned table drains over hours rather than causing replication lag. |
| `dataPlane.retention.batchTimeoutMs` | `30000` | Deadline for one delete batch. |
| `dataPlane.outbox.pollIntervalMs` | `250` | `OUTBOX_POLL_INTERVAL_MS`: router poll interval for unrouted events. |
| `dataPlane.outbox.maxRetryDurationMs` | `3600000` | `ROUTER_MAX_OUTBOX_RETRY_DURATION_MS`: how long an event that keeps failing to fan out is retried before being parked for an operator. |

### Ingress

| Key | Default | What it does |
|---|---|---|
| `ingress.enabled` | `false` | Create the two Ingress objects. |
| `ingress.className` | `nginx` | IngressClass name. |
| `ingress.annotations` | `{}` | Annotations applied to both Ingresses (cert-manager issuer, etc.). The ingest Ingress also carries a 2m body-size annotation for nginx. |
| `ingress.trustedProxyHops` | `1` | Exact number of proxies between the internet and the pods; becomes `TRUST_PROXY_HOPS` and `INGEST_TRUSTED_PROXY_HOPS`. Rendered whether or not `ingress.enabled`. 0..10. See [Behind a proxy](#behind-a-proxy-the-hop-count). |
| `ingress.appHost` | `webhooks.example.com` | Browser host: dashboard at `/`, control API at `/v1` and `/docs`. |
| `ingress.ingestHost` | `ingest.example.com` | Publisher host for the ingest API. Separate on purpose so bursts and browser traffic scale and rate-limit independently. |
| `ingress.tls.enabled` | `true` | Add `tls:` blocks. |
| `ingress.tls.appSecretName` | `webhook-platform-tls` | TLS Secret for `appHost`. |
| `ingress.tls.ingestSecretName` | `webhook-platform-ingest-tls` | TLS Secret for `ingestHost`. |

### Migrations

| Key | Default | What it does |
|---|---|---|
| `migrations.enabled` | `false` | Render the migration Job. Off in the steady-state release; flip on for one upgrade, wait, flip off. |
| `migrations.image.repository` | `webhook-control-api` | Migration image; the `migrate` target of the control API build, which still carries the Prisma CLI. |
| `migrations.image.tag` | `''` | Empty uses `<appVersion>-migrate`. |
| `migrations.image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `migrations.backoffLimit` | `2` | Job retries on failure. |
| `migrations.ttlSecondsAfterFinished` | `86400` | Seconds a finished Job is kept (and its logs readable). |
| `migrations.resources.requests.cpu` | `100m` | CPU request. |
| `migrations.resources.requests.memory` | `256Mi` | Memory request. |
| `migrations.resources.limits.cpu` | `'1'` | CPU limit. |
| `migrations.resources.limits.memory` | `1Gi` | Memory limit. |

### NetworkPolicies

| Key | Default | What it does |
|---|---|---|
| `networkPolicy.enabled` | `true` | Render default-deny NetworkPolicies plus the minimum holes. Only enforced if your CNI implements NetworkPolicy. |
| `networkPolicy.dnsNamespace` | `kube-system` | Namespace running CoreDNS/kube-dns; the only permitted DNS egress. |
| `networkPolicy.datastoreCidrs` | `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10` | Where PostgreSQL/PgBouncer/Redis live. A database on a public address is not covered: add its range. |
| `networkPolicy.datastorePorts` | `5432, 6432, 6379` | Ports reachable inside `datastoreCidrs`; everything else there is dropped. |
| `networkPolicy.blockedEgressCidrs` | `0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4` | Subtracted from the worker's `0.0.0.0/0` egress. Mirrors the SSRF guard's blocklist; do not shorten it. |
| `networkPolicy.ingressControllerNamespace` | `''` | Restrict HTTP ingress to your ingress controller's namespace. Empty allows the service ports from anywhere in the cluster. |
| `networkPolicy.monitoringNamespace` | `''` | Restrict `:9090` scrapes to your monitoring namespace. |
| `networkPolicy.extraEgress` | `[]` | Raw `NetworkPolicyEgressRule` entries applied to every pod: an SMTP relay, an OTLP collector elsewhere, IPv6 egress. |

---

**Where this comes from.** `deployments/helm/webhook-platform/{values.yaml,values.schema.json,Chart.yaml}`, `templates/{_helpers.tpl,configmap.yaml,secret.yaml,data-plane.yaml,control-api.yaml,migration-job.yaml,worker-hpa.yaml,networkpolicy.yaml,grafana-dashboard.yaml,NOTES.txt}`, `deployments/HANDOFF.md`, `services/data-plane/cmd/webhookd/roles.go` (`runWorker`, the keyring). The values table is produced by a generator from `values.yaml`; regenerate it when the chart changes.
