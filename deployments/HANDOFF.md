# Deployment handoff

Owner of this document: whoever runs the platform. Scope: `deployments/**` and
`.github/**`.

**The rule everything here follows: containers are disposable, customer data is
not.** There is no PostgreSQL anywhere in the production path — no StatefulSet,
no Helm subchart, no compose service. Delete every pod, reinstall against the
same database, and every event, delivery and attempt is still there
(ARCHITECTURE.md 36, engineering rule 4/34). CI enforces this: the `manifests`
job fails if a StatefulSet or a `postgres`-ish image ever appears under
`deployments/kubernetes` or `deployments/helm`.

---

## What shipped

### `deployments/kubernetes/` — plain manifests

Apply with `kubectl apply -k deployments/kubernetes`.

| File | Contents |
|---|---|
| `00-namespace.yaml` | Namespace, labelled for Pod Security Admission `restricted` |
| `01-configmap.yaml` | All non-secret configuration |
| `02-secret.template.yaml` | **Template only** — placeholders, never a filled copy. Not in the kustomization |
| `10-migration-job.yaml` | Explicit migration Job. `generateName`, so `kubectl create`, not `apply`. **Not in the kustomization** |
| `20-control-api.yaml` | Control plane Deployment + Service (2 replicas) |
| `21-dashboard.yaml` | Static dashboard Deployment + Service (2 replicas) |
| `30-ingest.yaml` | `webhookd ingest` Deployment + Service (2 replicas) |
| `31-router.yaml` | `webhookd router` Deployment (2 replicas) |
| `32-scheduler.yaml` | `webhookd scheduler` Deployment (1 replica, `Recreate`) |
| `33-worker.yaml` | `webhookd worker` Deployment + HPA (2–8, a database ceiling) |
| `40-pdb.yaml` | PodDisruptionBudgets for everything except the scheduler |
| `41-ingress.yaml` | Two Ingresses: app host and ingest host |
| `50-networkpolicy.yaml` | Default-deny + five allow policies. **In the kustomization** — read its header before applying |

All four Go roles run **one image**, `ghcr.io/shaq/webhook-data-plane`, and
differ only by argv (ADR-0005).

Security posture on every pod: `runAsNonRoot`, explicit uid (1000 node, 101
nginx, 65532 distroless), `readOnlyRootFilesystem: true`, `capabilities: drop
[ALL]`, `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`,
`automountServiceAccountToken: false`. Writable paths are `emptyDir` mounts
only — `/tmp` everywhere, plus `/var/cache/nginx` for the dashboard.

Probes: liveness on `/health/live`, readiness on `/health/ready`. **Liveness
never touches PostgreSQL** (ARCHITECTURE.md 46) — a database blip that restarts
every pod turns a recoverable incident into an outage. Go roles serve both on
port 9090 alongside `/metrics`; the control API serves them on 3000, outside the
`/v1` prefix.

Grace periods sit above the 25s in-process drain in `cmd/webhookd/main.go`:
60s for ingest/router/scheduler, 90s for workers (a worker attempt can run for
`EGRESS_TOTAL_TIMEOUT_MS` = 30s, and being SIGKILLed mid-attempt means the
delivery waits out `DELIVERY_LEASE_SECONDS` before another worker reclaims it),
45s control API, 30s dashboard.

### `deployments/helm/webhook-platform/` — Helm chart

`Chart.yaml` (v0.1.0, `kubeVersion >=1.25`, **no dependencies** — a bundled
PostgreSQL subchart is the fastest way to lose delivery history to a
`helm uninstall`), `values.yaml`, `values.schema.json`, twelve templates and
`NOTES.txt` carrying the six-step install.

`values.schema.json` makes `externalDatabase.url` **required**, with a
`^postgres(ql)?://` pattern. `helm install` with default values fails before
anything is created. `values.yaml` deliberately leaves the key commented out
rather than defaulting it to an empty string.

Two further guards, because "no default credentials, ever" (ADR-0006) is
cheaper to enforce at render time than to debug at pod start: the chart calls
`fail` if `secrets.jwtSecret` or `secrets.encryptionKey` is empty and no
`secrets.existingSecret` is set.

Secrets precedence is `configmap → chart secret → externalDatabase.existingSecret
→ externalRedis.existingSecret → secrets.existingSecret`. Later `envFrom`
entries win, so pointing at External Secrets / Vault / SOPS needs no template
changes. `NOTES.txt` warns when secrets came from values and are therefore
sitting in the Helm release history.

The migration Job is **not** a Helm hook and is `enabled: false` by default. A
`pre-upgrade` hook would let a log-level tweak change the schema.

### `.github/workflows/ci.yml`

Existing `data-plane`, `control-plane`, `schema-drift` and `security` jobs are
untouched in substance; toolchain versions moved into workflow-level
`GO_VERSION` / `NODE_VERSION` / `PNPM_VERSION` so there is one place to change
them. Three jobs added:

- **`images`** — buildx builds all three images plus the `migrate` target, with
  GHA layer caching. Build only, no push: a job holding registry write
  credentials on every `pull_request` is a supply-chain hole. Publishing is a
  release concern and is **not implemented** — see below.
- **`dockerfile-lint`** — hadolint over all three Dockerfiles,
  `failure-threshold: warning`.
- **`manifests`** — `helm lint`, `helm template`, `kubeconform -strict` over both
  the rendered chart and the raw manifests, plus three guardrail steps: the
  chart must *fail* to lint with default values, no database may appear in the
  manifests, and the default-deny NetworkPolicies must survive a render with
  the private ranges still excluded from the worker's egress.
- **`supply-chain`** — `pnpm audit` (gate: production tree, `critical`; full
  tree reported non-blocking) and `gitleaks` over both git history and the
  working tree, configured by `.github/gitleaks.toml`.

The workflow carries a top-level `permissions: { contents: read }`.

---

## How to deploy

### Helm (recommended)

```bash
# 1. Provision PostgreSQL (RDS/Aurora/Cloud SQL/Neon/Supabase/self-managed).
#    Production topology: app -> PgBouncer -> PostgreSQL.
# 2 + 3. DATABASE_URL, and optionally Redis.
# 4. Secrets - there are no defaults.
kubectl create namespace webhook-platform
kubectl -n webhook-platform create secret generic webhook-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)"

helm upgrade --install webhooks deployments/helm/webhook-platform \
  -n webhook-platform \
  --set externalDatabase.url='postgresql://u:p@pgbouncer:6432/webhook_platform?schema=public&sslmode=require' \
  --set externalDatabase.directUrl='postgresql://u:p@db:5432/webhook_platform?schema=public&sslmode=require' \
  --set externalRedis.url='rediss://redis:6379/0' \
  --set secrets.existingSecret=webhook-secrets \
  --set ingress.enabled=true \
  --set ingress.appHost=webhooks.example.com \
  --set ingress.ingestHost=ingest.example.com

# 5. Migrations - explicit, separate, never on app start.
helm upgrade webhooks deployments/helm/webhook-platform -n webhook-platform \
  --reuse-values --set migrations.enabled=true
kubectl -n webhook-platform wait --for=condition=complete --timeout=10m \
  job -l app.kubernetes.io/component=migrate
helm upgrade webhooks deployments/helm/webhook-platform -n webhook-platform \
  --reuse-values --set migrations.enabled=false

# 6. Verify, then create the first owner explicitly (ADR-0006).
kubectl -n webhook-platform rollout status deploy/webhooks-webhook-platform-control-api
# bootstrap.js reads BOOTSTRAP_EMAIL / BOOTSTRAP_PASSWORD / BOOTSTRAP_ORG from
# its environment and exits without them, so `kubectl exec` alone cannot work -
# and passing them as `exec -- env VAR=...` puts the owner password in shell
# history and in the API server audit log. Use a Secret plus a one-shot Job;
# NOTES.txt prints the exact manifest for your release.
```

### Plain manifests

Same six steps: create the two Secrets out of band (see
`02-secret.template.yaml`), edit hostnames in `41-ingress.yaml` and image tags
in `kustomization.yaml`, then

```bash
kubectl apply -k deployments/kubernetes
kubectl -n webhook-platform create -f deployments/kubernetes/10-migration-job.yaml
```

### Scaling

Workers are the throughput dial; the control plane is not
(ARCHITECTURE.md 53/54). Before raising `maxReplicas`, check that
`maxReplicas × DATABASE_MAX_CONNECTIONS` is under what PgBouncer will accept —
otherwise autoscaling converts a traffic spike into a connection storm.

---

---

## Adversarial review fixes (this pass)

Thirteen confirmed defects. Two were reproduced against the real lockfile before
being fixed; the rest are template/CI-level and were verified by rendering.

### Critical

**1. The control-api image shipped an UNGENERATED Prisma client.**
`pnpm deploy --prod` does not copy `node_modules` — it re-links from the
content-addressable store. The Prisma client is *generated* code living in the
virtual store (`node_modules/.pnpm/@prisma+client@<v>_prisma@<v>/node_modules/.prisma/client`),
so it is not store content and was not carried across; `--prod` then stripped the
`prisma` CLI so nothing in the deploy tree could regenerate it. Reproduced
locally: the deployed tree's `require('@prisma/client')` threw
`Cannot find module '.prisma/client/default'`. `PrismaService extends
PrismaClient` and is constructed during Nest module init, so `node dist/main.js`
died before `app.listen`, every pod CrashLoopBackOffed, and `maxUnavailable: 0`
meant the rollout never completed.

`deployments/docker/control-api.Dockerfile` now runs a second
`prisma generate --schema=/app/deploy/prisma/schema.prisma` from the builder
(which still has the CLI) — Prisma resolves its default output through the
`@prisma/client` it finds from the schema directory, so the client lands in the
*deploy* tree's virtual store, which is what the runtime stage copies. A
`node --eval` assertion in the same `RUN` fails the build if the client is ever
missing again.

> **The permanent fix belongs to the control-api owner, not here:** move
> `prisma` from `devDependencies` to `dependencies` in
> `apps/control-api/package.json`. That removes the second generate, the whole
> `migrate` Dockerfile target, its CI matrix entry, `migrations.image` in the
> chart, and the separate migrate image in compose — the Job could then just use
> the runtime image.

**2. `REDIS_URL: ""` broke the documented no-Redis install.** `envFrom` projects
every key in a Secret as a *set* environment variable, and the control API's env
schema (`z.string().url().optional()`) accepts `undefined` but rejects `""`, so
the chart, the raw Secret template and compose prod all produced a control plane
that threw in `validateEnv` before listening — on the path `values.yaml`,
`NOTES.txt` and the chart all call supported.

Fixed on the template side, so "unset means unset" is true for every consumer:
the chart wraps `REDIS_URL` (and the S3 credentials) in `{{- if }}`, the raw
template comments the key out with an explanation, and compose uses the
pass-through form (`REDIS_URL:` with no value) instead of `${REDIS_URL:-}`.
A separate agent is relaxing the schema; both changes stand independently.

### High

**3. `schema-drift` could never pass, and the obvious repair deleted a
data-integrity index.** `20260906010000_review_fixes` contains a partial unique
index and two `NULLS NOT DISTINCT` indexes that Prisma's datamodel cannot
express, so `migrate diff --exit-code` returned 2 by construction on every
commit. The natural response — `prisma migrate dev` — generates a migration that
DROPS `deliveries_event_endpoint_original_key`, the `ON CONFLICT` arbiter that
stops a re-run router from fanning every event out to every subscriber twice.

The job now diffs to a `--script` and fails only on identifiers **not** in
`deployments/ci/expected-schema-drift.txt`, a committed fixture whose header
explains at length why `migrate dev` must never be used here. A second step
applies the migrations for real and asserts all three indexes exist in
`pg_indexes`, so the fixture cannot be quietly widened to hide a genuine loss.

**4. compose prod's `migrate` ran `npx prisma migrate deploy` on the pruned
runtime image**, which has no Prisma CLI and no `package.json` at the working
directory. `npx` in a non-TTY silently downloads, so this fetched `prisma@latest`
(6.x) and applied a history authored by 5.22 — or failed confusingly with no
egress. It now uses the dedicated `migrate` target
(`IMAGE_CONTROL_API_MIGRATE`, default `:latest-migrate`) with the right
`working_dir`, as the k8s Job and chart already did. Every `npx prisma` in the
repo gained `--no-install`.

**5. The Helm migration Job put `DATABASE_URL` in as a literal `value:`**,
defeating `existingSecret` entirely — an `env:` entry *overrides* `envFrom` for
that key, inverting the documented precedence — and writing the credential into
the Job PodSpec, `helm get manifest` and etcd release history. The override is
also unnecessary: `schema.prisma` declares
`directUrl = env("DIRECT_DATABASE_URL")`, and `DIRECT_DATABASE_URL` already
arrives through `envFrom` with correct precedence. Removed.

### Medium

**6. `egress.allowPrivateNetworks: true` was offered but is fatal.**
`internal/config/config.go` hard-fails when it is set with `APP_ENV=production`,
and `app.env` defaults to production, so the documented knob CrashLoopBackOffed
all four Go roles. The chart now `fail`s at render time pointing at
`privateAllowlist`, and the misleading comments in `values.yaml` and
`deployments/kubernetes/01-configmap.yaml` say what actually happens.

**7. compose prod gave `stop_grace_period` only to `worker`.** Everything else
inherited Docker's 10s default, under a 25s shared drain and a 15s ingest drain —
so in-flight publishes that had already COMMITted were SIGKILLed before their
202 was written and the publisher correctly republished them. Duplicate events
from a routine `compose down`. Now 40s on ingest/router/scheduler, 30s on
control-api, 60s on worker (its drain plus one full 30s outbound attempt).

**8. Two CI guards passed for the wrong reason.**
(a) "Chart refuses to install without `externalDatabase.url`" asserted only that
`helm lint` failed on defaults — but it failed on the empty `jwtSecret` guard
first, so deleting `"required": ["url"]` would have kept it green. It now
supplies every secret, withholds only the DB, and greps the message for
`externalDatabase`.
(b) "No bundled database" grepped *source* files for `StatefulSet` and postgres
images. A `Chart.yaml` `dependencies:` on `bitnami/postgresql` matched neither
and only becomes a StatefulSet after render; `PersistentVolumeClaim` and
`volumeClaimTemplates` matched nothing at all; compose was not scanned. It now
greps the rendered chart (already written by the previous step), the sources,
`docker-compose.prod.yml`, and fails on any `dependencies:` in `Chart.yaml`.

**9. `directUrl` silently defaulted to the pooled `url`,** so migrations ran DDL
and session-scoped advisory locks through PgBouncer. The chart now `fail`s when
`migrations.enabled` is true and `directUrl` is empty (unless
`externalDatabase.existingSecret` supplies `DIRECT_DATABASE_URL`).

**10. Worker HPA `maxReplicas: 20` was a connection storm, not throughput.**
20 × `maxConnections` 20, plus the other roles and Prisma's pool, is ~500 backend
connections — past a stock `max_connections` and a default PgBouncer pool. A
worker pod that cannot `pool.Ping` in `db.Open` exits 1, so a spike produced
CrashLoopBackOff. Defaults are now `maxReplicas: 8` and `maxConnections: 10`
(~130 at ceiling), in both the chart and `33-worker.yaml`, with the arithmetic
written down. The unmeasured memory metric is gone from both, and from
`values.schema.json` so it cannot be set and silently ignored.

### Low

**11. `SESSION_SECRET` defaulted to `jwtSecret`,** so one key signed both JWTs
and cookies and rotating either rotated both — and the validate guard did not
check it. It is now required, never defaulted.

**12. The documented final install step could not work.**
`kubectl exec ... node dist/cli/bootstrap.js` fails for every operator:
`bootstrap.ts` requires `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD` /
`BOOTSTRAP_ORG` from the environment. The obvious workaround puts the owner
password in shell history and in API-server audit logs. `NOTES.txt` and this
document now describe a one-shot Job sourcing them from a Secret, with both
deleted afterwards.

**13. Every Go role received the app Secret, including `JWT_SECRET` and
`SESSION_SECRET`,** which `internal/config/config.go` never reads. The worker
makes arbitrary outbound HTTP to customer-controlled URLs and is the worst place
in the system to hold the session-forgery key. The data plane now has its own
`secretRef` (`webhook-platform.dataPlaneEnvFrom`, chart value
`dataPlane.separateSecret: true`; `webhook-platform-data-plane` in the raw
manifests) carrying only `DATABASE_URL`, `REDIS_URL` and the S3 credentials.

> If the data plane ever gains payload encryption or endpoint-secret decryption,
> `ENCRYPTION_KEY` must be added to that Secret. It is deliberately absent today
> because nothing under `services/data-plane` reads it.


## Verified

No cluster and no Docker daemon were used. `helm` v3.16.3 and `kubeconform`
v0.6.7 were downloaded to a scratch directory and really ran; so did `pnpm`,
`node` and `docker compose config` (the compose CLI parses without a daemon).

Actually executed:

- **The Prisma defect was reproduced and the fix proven at the pnpm level.**
  `pnpm deploy --filter @webhook/control-api --prod <tmp>` built a real deploy
  tree; `require('@prisma/client')` in it threw
  `Cannot find module '.prisma/client/default'`, and there was no `prisma` CLI
  anywhere in the tree to regenerate with. Running
  `pnpm --filter @webhook/control-api exec prisma generate --schema=<tmp>/prisma/schema.prisma`
  wrote the client into that tree's virtual store, after which
  `new PrismaClient()` constructed successfully — including under `env -i`, with
  no `DATABASE_URL` and no cwd, which is what the Dockerfile's build-time
  assertion does.
- `helm lint` **fails** with every secret supplied and only the DB withheld, and
  the message names `externalDatabase` — the new CI guard's exact assertion.
- The three new `fail` guards trip with their intended messages
  (`sessionSecret`, `allowPrivateNetworks` + production, `migrations.enabled`
  without `directUrl`), and the `allowPrivateNetworks` case renders fine under
  `app.env=staging`.
- `helm template` renders 22 resources; `kubeconform -strict
  -kubernetes-version 1.29.0` reports **22/22 valid** for the rendered chart and
  **23 valid / 1 skipped** (`kustomization.yaml`) for the raw manifests.
- The rendered migration Job contains **no** `DATABASE_URL` literal, and the
  four data-plane Deployments reference `…-data-plane-secrets`, not the app
  Secret.
- All four "no bundled database" greps and the "optional keys are omitted" grep
  were run against the real tree and pass — with a **negative control** each way:
  the empty-value pattern catches a synthetic `REDIS_URL: ""`, and the database
  pattern finds the (intentional) postgres image in `docker-compose.dev.yml`,
  which is excluded from the scan.
- `docker compose config` on the prod file: `REDIS_URL` resolves to `null`
  (Compose's "absent from the container" marker) when the host does not set it
  and to the real value when it does; the `migrate` service resolves to
  `…:latest-migrate` with `working_dir: /app/apps/control-api` and
  `npx --no-install`; `stop_grace_period` is set on every long-lived service.
- `helm template` **does** execute `NOTES.txt` (proved by deliberately breaking
  it), so the rewritten install notes are known to render.
- Every changed YAML file parses (`pyyaml` in a scratch venv), and `ci.yml`
  parses into the expected job and step list.

## Not verified — needs a cluster or a Docker daemon

- **No image was built.** Docker was not running. The Dockerfile change is
  verified at the pnpm layer, not at the image layer: the `RUN` that proves the
  client exists has never executed inside `node:22-alpine`. The `images` CI job
  is its first real test — and if the second `prisma generate` ever fails there,
  that assertion is what will say so.
- **Nothing was applied to a cluster.** kubeconform checks shape, not that pods
  start, probes answer, the HPA finds metrics-server, or that
  `readOnlyRootFilesystem` holds at runtime.
- **The compose null-value pass-through is verified only through
  `docker compose config`**, which reports `REDIS_URL: null`. That is Compose's
  documented "not set in the container" representation, but no container was
  started to observe the environment directly.
- **`maxReplicas: 8` / `maxConnections: 10` are arithmetic, not a measurement.**
  They are sized to fit a stock `max_connections`; the right number comes from
  load testing against the real pooler.
- **The schema-drift fixture was not run against Postgres.** No local database,
  so `prisma migrate diff --script` output was never generated here. The three
  index names come from the committed migration. If Prisma's drift script ever
  mentions an identifier outside those three, CI will say so — which is the
  intent, but the first run on this branch is the first real execution.

---

## Follow-up pass (this one)

Four things were cleared. `helm` v3.16.3, `kubeconform` v0.6.7 and `gitleaks`
v8.30.1 really ran; **Docker's daemon was not running, so no image was built**
and nothing was applied to a cluster.

### 1. `services/data-plane/go.mod` now says `go 1.23`

Was follow-up 1. CI, both Dockerfiles and go.mod now name the same version, and
the stale comment in `ci.yml`'s `env:` block explaining the mismatch is gone.

Verified by running `go build ./...`, `go vet ./...` and `go test -count=1 ./...`
under a real go1.23.4 toolchain — all pass. `go mod tidy` leaves the file
unchanged apart from that one line, which is what the `data-plane` job's
`git diff --exit-code go.mod go.sum` step asserts.

### 2. Dashboard transport

`deployments/docker/dashboard.Dockerfile` now takes
`ARG VITE_API_TRANSPORT`, **defaulting to `mock`**.

The default is deliberate and is written down in the Dockerfile as well as
here. The control API today exposes auth, health, organizations, members,
projects, api-keys, endpoints and endpoint-secrets — and nothing else. An image
built with `http` right now would 404 on events, deliveries, attempts,
subscriptions and replay, which reads as an outage rather than as an unfinished
feature. The mock build is not silent: `apps/dashboard/src/components/DemoDataBanner.tsx`
renders a non-dismissible "Demo data — not connected to an API" bar on every
page including the auth pages.

> **═══ FLIP IT WHEN THE CONTROL API IS FEATURE-COMPLETE ═══**
>
> One line in `deployments/docker/dashboard.Dockerfile`:
>
> ```dockerfile
> ARG VITE_API_TRANSPORT=http
> ```
>
> Or, without editing the file:
> `docker build --build-arg VITE_API_TRANSPORT=http -f deployments/docker/dashboard.Dockerfile .`
>
> Nothing else changes. When it is flipped, `src/lib/mock/` can be deleted and
> the banner goes with it.

The value is passed on the `RUN` line rather than through
`ENV VITE_API_TRANSPORT=${VITE_API_TRANSPORT}` — a self-referential ENV is
hadolint DL3044, and the `dockerfile-lint` job fails at `warning`.

Verified without Docker, at the layer that actually matters: the dashboard was
built twice on this machine. With no environment variable, the string
`Demo data` is present in `dist/assets/*.js`. With `VITE_API_TRANSPORT=http`
exported into the build, it is **absent** — Vite reads `VITE_`-prefixed vars
from `process.env` and tree-shakes the mock away. So the ARG reaches the bundle;
the untested part is only the `docker build --build-arg` plumbing around it.

### 3. Prisma-in-the-deploy-tree: **the Dockerfile fix still works**

Re-verified against the current control API (six new modules, a new authz
layer), by reproducing the deploy tree with pnpm exactly as the earlier review
did:

- `pnpm deploy --filter @webhook/control-api --prod <tmp>` — the tree contains
  **no `prisma` CLI** (`node_modules/.bin` has none), confirming `--prod` still
  strips it.
- `require('@prisma/client')` in that tree still throws
  `Cannot find module '.prisma/client/default'`. **The defect is unchanged and
  the Dockerfile's second `prisma generate` is still load-bearing.**
- Running the Dockerfile's exact repair —
  `pnpm --filter @webhook/control-api exec prisma generate --schema=<tmp>/prisma/schema.prisma`
  — then `new PrismaClient()` under `env -i` with cwd `/` (no `DATABASE_URL`,
  no cwd, which is what the build-time `node --eval` assertion does):
  **constructs, with 24 model delegates.**

So the image is fine. Follow-up 2 below stands unchanged: the durable one-line
fix is still the control-api owner's, and it is now worth more than it was —
`prisma` in `dependencies` deletes the second generate, the whole `migrate`
Dockerfile target, its CI matrix entry, `migrations.image` in the chart and the
separate migrate image in compose.

### 4. NetworkPolicies — default-deny, on by default

Was follow-up 5. `deployments/kubernetes/50-networkpolicy.yaml` (in the
kustomization) and `deployments/helm/webhook-platform/templates/networkpolicy.yaml`
(`networkPolicy.enabled: true`).

**Why on by default.** `internal/egress/ssrf.go` is good code and it is one
process making one decision about URLs a customer typed into a form. A
DNS-rebinding race it does not win, a redirect path that skips the check, or a
future `http.Client` built somewhere else all end with a worker pod opening a
socket to 10.x or to 169.254.169.254. A security control that is opt-in is a
security control nobody has.

Six policies:

| Policy | Effect |
|---|---|
| `default-deny` | Empty podSelector, `[Ingress, Egress]`. A workload added later is denied by omission, not allowed by it |
| `allow-dns` | :53 to `kube-system` only |
| `allow-datastore-egress` | Control API + four Go roles + migrate Job → RFC1918/RFC6598, **ports 5432/6432/6379 only** |
| `allow-worker-public-egress` | **Worker only** → `0.0.0.0/0` minus eleven private/reserved ranges, all ports |
| `allow-http-ingress` | :3000 (control API) and :8080 (dashboard, ingest) |
| `allow-metrics-scrape` | :9090 on the four Go roles |

The datastore rule is the one that demotes the SSRF guard from load-bearing to
redundant: those pods *can* reach `10.0.0.0/8`, but only on datastore ports, so
a forged request to an internal HTTP service, to the API server on 443, or to
the metadata endpoint on 80 is dropped by the kernel whatever the process
intended. All ports on the public rule, deliberately: `ssrf.go` constrains the
*scheme* to http/https, not the port, so `https://hooks.example.com:8443` is a
legal endpoint and a 80/443-only rule would drop those deliveries into a retry
loop with no diagnosable cause. Only the worker gets it — the router, scheduler
and ingest never dial a customer.

**Two ways this breaks an install. Check both before applying.**

1. **Your CNI must enforce NetworkPolicy.** Calico, Cilium, Antrea and Weave do.
   Stock EKS (amazon-vpc-cni with no policy agent), flannel, and a default
   kind/minikube **accept these objects and ignore them** — which is worse than
   nothing, because you will believe you are covered. Verify with a test pod.
2. **A database on a public address is not covered.** `datastoreCidrs` is
   private space; Neon, Upstash, Supabase and a public RDS endpoint are not in
   it, and the control plane will fail readiness with a connection timeout. Add
   the provider's range to `networkPolicy.datastoreCidrs` (or the raw
   `allow-datastore-egress` rule), or set `networkPolicy.enabled: false` and put
   that in your runbook.

Tighten `networkPolicy.ingressControllerNamespace` and `.monitoringNamespace`
once you know them — empty means "from anywhere in the cluster, on the service
ports only". IPv6 egress is **not** granted (a dual-stack cluster cannot reach
an IPv6-only customer endpoint); adding it means an `ipBlock` on `::/0` with
`fc00::/7`, `::1/128`, `fe80::/10` and `64:ff9b::/96` excepted — never a bare
`::/0`, which re-opens the NAT64 spelling of the metadata address `ssrf.go`
closes. `networkPolicy.extraEgress` is the hatch for that and for OTLP
collectors, SMTP relays and the like.

A new `manifests` step, **Default-deny NetworkPolicies survive a render**,
fails if the rendered chart has no NetworkPolicy, no `default-deny`, if
`50-networkpolicy.yaml` leaves the kustomization, or if any of
`169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or
`127.0.0.0/8` stops being excluded from the worker's egress in either the chart
or the raw manifests. The point is that the metadata block cannot be quietly
trimmed out of `blockedEgressCidrs`.

### 5. CI: a `permissions:` block, dependency audit, secret scanning

**Least privilege.** `ci.yml` had no top-level `permissions:`, so the repository
default applied to `GITHUB_TOKEN` — read-write `contents` on an older repo or
org, which a compromised action or a malicious transitive dependency in a build
step can push with. It is now `permissions: { contents: read }` at workflow
level. Nothing here publishes anything; a job that ever needs more should raise
it in its own block.

**New `supply-chain` job.** `pnpm audit` plus `gitleaks` v8.30.1 (pinned
tarball, not `gitleaks-action`, which demands a `GITLEAKS_LICENSE` for
organisation-owned repositories and fails closed without one).

Both gates were measured before being written, because a check that merges red
is a check nobody reads:

- **The audit gate is `--prod --audit-level=critical`.** On the day it was
  written the full tree had 34 advisories (1 critical, 11 high) and the
  production tree had 21 (0 critical, 7 high). Gating on `high` would have
  merged permanently red. The single critical is vitest's dev-server file read
  (GHSA-5xrq-8626-4rwp) — dev-only, in no image, hence `--prod`. A second,
  non-blocking step prints the **full** audit to the job summary on every run,
  so the highs stay visible rather than silently excluded.
- **Secret scanning runs twice** — `detect` over history at `fetch-depth: 0` (a
  credential committed and later deleted is still in the objects) and
  `detect --no-git` over the working tree.

**`.github/gitleaks.toml`** keeps every default rule on and allowlists only the
*shape* of this repo's synthetic fixtures: the literal run `0123456789abcdef`,
one base64 test token, and bare `VAR=` env names in docs. It deliberately does
**not** exempt `*_test.go` or `*.spec.ts` by path — test files are one of the
most common places a real credential actually gets committed, and a path
allowlist would turn the job into a check that passes because it stopped
looking. The only path entries are `dist/`, `node_modules/`, `.pnpm-store/` and
`coverage/`.

> **Dependency audit — for the control-api and dashboard owners.** Seven `high`
> advisories in the **production** tree today: four in `multer` (all DoS, via
> `@nestjs/platform-express`), two in `js-yaml` (quadratic CPU, via
> `@nestjs/swagger`) and one in `lodash` (code injection via `_.template`).
> They are dependency bumps in `apps/control-api` and `apps/dashboard`, not a
> CI change. **Once they are cleared, tighten the gate to
> `pnpm audit --prod --audit-level=high`** — it is one word in
> `.github/workflows/ci.yml`.

### What this pass verified, and what it did not

**Actually executed on this machine:**

- `go build` / `go vet` / `go test -count=1 ./...` in `services/data-plane`
  under go1.23.4: all pass. `go mod tidy` produces no further diff.
- The pnpm deploy-tree reproduction, both directions: the client is missing
  before the second `prisma generate` and constructs after it, under `env -i`
  with cwd `/`.
- Two real dashboard builds proving `VITE_API_TRANSPORT` reaches the bundle
  (`Demo data` present with the default, absent with `http`).
- `helm lint` clean; `helm template` renders **28** resources (was 22 — the six
  new policies); `kubeconform -strict -kubernetes-version 1.29.0` reports
  **28/28 valid** for the chart and **29 valid / 1 skipped** for the raw
  manifests (the skip is `kustomization.yaml`).
- `networkPolicy.enabled=false` renders **zero** NetworkPolicies;
  `extraEgress`, `ingressControllerNamespace` and `monitoringNamespace` all
  render correctly and kubeconform-validate; `values.schema.json` rejects a
  malformed CIDR with the pattern error.
- The new "Default-deny NetworkPolicies survive a render" guard script, run
  by hand: passes, and **fails correctly under two negative controls** — a
  render with `networkPolicy.enabled=false`, and a render with
  `169.254.0.0/16` removed from `blockedEgressCidrs`.
- The existing "no bundled database" greps still pass against the new files.
- `gitleaks` v8.30.1: 8 findings before the config (all synthetic — inspected
  unredacted, every one is `0123456789abcdef` filler, a base64 of
  "forged-token-that-unlocks-the-account", or a bare `ENCRYPTION_KEY=`),
  **0 findings after it**, over both history and working tree. **Negative
  control:** a realistic `sk_live_…` key planted in a `_test.go` — the file kind
  a path allowlist would have exempted — still trips the scan.
- `pnpm audit`, four ways, for the numbers quoted above.
- `ci.yml` and every changed YAML file parse; the job and step lists are as
  intended.

**Not verified:**

- **No image was built. Docker's daemon was not running.** The dashboard ARG is
  proven at the Vite layer, not the image layer; `docker build --build-arg` has
  never run here. Same for the control-api Dockerfile's second
  `prisma generate` — proven at the pnpm layer, as before.
- **Nothing was applied to a cluster.** kubeconform checks shape. It does not
  check that a CNI enforces these policies, that the worker can still reach a
  real customer endpoint through them, or that the control API can still reach
  its database. **The NetworkPolicies are the change in this pass with the
  largest blast radius and they have never run.** Apply them to staging and
  watch readiness before production.
- **`hadolint` was not run.** Its macOS binary segfaults on this machine. The
  `ENV`-avoidance in the dashboard Dockerfile is reasoning about DL3044, not a
  lint result — the `dockerfile-lint` job is its first real test.
- **The `supply-chain` job has never run on a GitHub runner.** The gitleaks
  release URL was confirmed to resolve (HTTP 200) and the binary works locally,
  but on `linux_x64` rather than `darwin_x64`.

---

## Known issues and follow-ups, in priority order

1. ~~**`services/data-plane/go.mod` still says `go 1.21`.**~~ **REVERTED, and
   correctly so.** The file says `go 1.21` again and its header explains why:
   the directive is a minimum language version, not a pin, and raising it broke
   local builds on a 1.21.4 toolchain. CI and the Dockerfiles now build with
   **1.27** and the module minimum stays 1.21 — the two numbers are allowed to
   differ. See "CI first-run fixes" at the end of this document. The one thing
   that would force the minimum up is the pgx advisory, item 16.
2. **`prisma` is still a devDependency of `apps/control-api`, and that is the
   root cause of two of the fixes above.** It forces the second
   `prisma generate` in the Dockerfile, the whole `migrate` target, its CI
   matrix entry, `migrations.image` in the chart and the separate migrate image
   in compose. **The one-line fix, which is the control-api owner's to make:**

   ```jsonc
   // apps/control-api/package.json
   "dependencies": { ..., "prisma": "^5.22.0" }   // moved out of devDependencies
   ```

   With that done, `pnpm deploy --prod` keeps the CLI, the postinstall can
   regenerate, and all five of the above can be deleted — the migration Job
   would just run the runtime image. Until then the Dockerfile's build-time
   `node --eval` assertion is what keeps the defect from coming back silently.
3. **The `migrate` image tag is `<appVersion>-migrate` by convention only.**
   Nothing publishes it yet (see 4), so compose's
   `IMAGE_CONTROL_API_MIGRATE` default `:latest-migrate` and the chart's
   `0.1.0-migrate` both point at tags that do not exist. Whoever wires
   publishing must push that target too, not just `runtime`.
4. **No image publishing.** CI builds but never pushes. Someone has to decide
   the registry, the tagging scheme and the release trigger. The manifests
   currently reference `ghcr.io/shaq/webhook-*:0.1.0`, which does not exist yet.
5. ~~**No NetworkPolicies.**~~ **DONE, but never applied to a cluster** — see
   "NetworkPolicies" above. Six policies in both the raw manifests and the
   chart, on by default, with a CI guard that stops the metadata range being
   trimmed out of the worker's egress exclusions. **The two ways it can break
   an install (a CNI that does not enforce policy; a database on a public
   address) are documented there and you must check both.** Remaining work:
   set `ingressControllerNamespace` / `monitoringNamespace` to your real
   namespaces, and decide whether you need the IPv6 egress rule.
6. **No `preStop` hook on ingest or the control API.** Endpoint removal and
   SIGTERM race, so a small number of in-flight requests can hit a pod already
   shutting down. The Go readiness flag flips to draining on SIGTERM, which
   covers most of it; a `preStop: sleep 5` would close the gap, but distroless
   has no shell, so it needs `terminationGracePeriodSeconds` plus a sleep
   built into the binary's shutdown path. Data-plane change, not a manifest one.
7. **HPA on CPU is a proxy, and `maxReplicas: 8` is a database ceiling.**
   Workers are I/O bound; queue depth (deliveries ready to claim, already
   destined for `/metrics`) via prometheus-adapter or KEDA is the correct
   trigger. Raising `maxReplicas` requires raising the pooler's capacity in the
   same change — a worker that cannot get its pool exits 1.
8. **No ServiceMonitor / PodMonitor.** Data-plane pods carry
   `prometheus.io/scrape` annotations, which suits a scrape-annotation
   Prometheus but not the Prometheus Operator. Add a `ServiceMonitor` template
   behind a values flag when the monitoring stack is chosen.
9. **No PgBouncer manifest.** ARCHITECTURE.md 36 recommends it and the chart
   assumes you have one (`externalDatabase.url` → pooler,
   `directUrl` → direct). Deploying it is currently the operator's job.

10. **The data plane's Secret is scoped to what it reads today.** If
    `services/data-plane` ever gains payload encryption or endpoint-secret
    decryption, `ENCRYPTION_KEY` must be added to `webhook-platform-data-plane`
    and to the chart's `-data-plane-secrets`. `JWT_SECRET` and `SESSION_SECRET`
    should never go back in.
11. **`deployments/ci/expected-schema-drift.txt` is a fixture with teeth but no
    generator.** Adding a hand-written index Prisma cannot express means adding
    its name there by hand. That is deliberate — it forces the person adding it
    to write down why — but it is a step that is easy to forget.

12. **Tighten the dependency-audit gate to `--audit-level=high`** once the seven
    production `high` advisories are cleared (multer x4, js-yaml x2, lodash x1
    — all transitive, all dependency bumps in `apps/control-api` and
    `apps/dashboard`). One word in `.github/workflows/ci.yml`.

13. **Flip `ARG VITE_API_TRANSPORT` to `http`** in
    `deployments/docker/dashboard.Dockerfile` when the control API serves the
    events, deliveries, attempts, subscriptions and replay endpoints. One line.
    The dashboard's demo banner and `src/lib/mock/` can be deleted in the same
    change.

14. **`dependency-review-action` was considered and not added.** It is the
    better tool for a pull request — it diffs the manifests and only flags what
    the PR *introduces*, rather than the whole tree — but it needs the
    Dependency Graph enabled, and on a private repository it needs GitHub
    Advanced Security. Neither could be confirmed from here, and an action that
    hard-fails on every PR because a feature is not licensed is worse than the
    `pnpm audit` gate that is there now. Add it (with `permissions:
    contents: read, pull-requests: write`) once the repo's plan is known.

15. **The NetworkPolicies have never been enforced by a real CNI.** Highest
    remaining risk in this pass. Apply to staging, confirm with a test pod that
    egress to `169.254.169.254` and to an internal HTTP service is actually
    dropped from a worker pod, and that the control API still reaches its
    database — then promote.


---

## CI first-run fixes (this pass)

The first real run of `ci.yml` on `main` failed five jobs with four distinct
causes. Three are fixed in files this pass owns; the fourth needs a change in
`services/data-plane/go.mod`, which it does not.

### pnpm version: one file, not two

`pnpm/action-setup@v4` now **refuses** to run when a `version:` is passed AND
the root `package.json` sets `packageManager` — "Multiple versions of pnpm
specified" — which killed `control-plane`, `schema-drift` and `supply-chain`
before they installed anything. The `version:` input is gone from all three
steps and the workflow-level `PNPM_VERSION` is deleted. `packageManager`
(`pnpm@9.12.3`) is now the only place the pnpm version appears; corepack in the
Dockerfiles already read it. `package.json` itself was **not** modified.

### Go toolchain: 1.23 → 1.27 (build only)

`GO_VERSION` in `ci.yml` and the builder image in `data-plane.Dockerfile` are
now **1.27**. `services/data-plane/go.mod` is untouched and still says
`go 1.21`.

Go 1.23 is out of support, so `1.23` resolved to go1.23.12 and govulncheck found
ten standard-library advisories reachable from this code — `GO-2026-6218`,
`-6090`, `-6089`, `-6088`, `-5972`, `-5856`, `-5039`, `-5037`, `-5026`, `-4971`
(quadratic `net/url` parsing, post-handshake `crypto/tls` flooding, `net/http`
h2c `ReadHeaderTimeout`, `encoding/xml` and `encoding/asn1` recursion, ECH
privacy leak, and so on), all reached through `egress.Client.Do`,
`ingest.Serve` and pgx. Every one of them is fixed at **1.27.0-rc.3 or
earlier**, checked against the fixed-version ranges in `vuln.go.dev` rather
than taken from the scanner's suggested patch. 1.26.6+ would also have cleared
them; 1.27 was chosen because it is the current stable branch and has the
longer support runway — being stuck on an EOL branch is what produced the list.

### The `data-plane` job now has a database

Not one of the three diagnosed causes, and worth reading before it is "fixed"
again. The `Test` step failed on ten connection-refused errors, not on
govulncheck. The Go integration tests in `internal/db`, `internal/ingest`,
`internal/queue`, `internal/router` and `internal/worker` `t.Skip` when
`DATABASE_URL` is unset — but the workflow-level `env:` sets it for **every**
job, so in a job with no `postgres` service they did not skip, they dialled
nothing.

Unsetting `DATABASE_URL` for that job would also be green, and would be wrong:
those tests are the only place drift between the hand-written pgx SQL and
Prisma's schema is caught, because the Go side never runs migrations
(ADR-0002). The job now starts `postgres:16-alpine`, installs dependencies,
runs `prisma migrate deploy`, and then runs the suite with `-p 1`.

It carries **two spellings of the same URL**, deliberately: pgx forwards unknown
URL query parameters to the server as runtime parameters, so Prisma's
`?schema=public` makes every `pgxpool.New` in the suite fail with
`FATAL: unrecognized configuration parameter "schema"`. Verified locally against
PostgreSQL. The migration step gets Prisma's spelling; the job env gives the
tests `?sslmode=disable`. The same split already exists in the root
`package.json` (`test:db:migrate` vs `go:test:db`).

### Prisma engine binary targets — `control-api` image

The `control-api` image build failed with
`Unable to require(.../.prisma/client/libquery_engine-linux-musl.so.node)`.
The engine was not missing; it was the **wrong** engine. The build log shows
`prisma:warn Prisma failed to detect the libssl/openssl version to use ...
Defaulting to "openssl-1.1.x"` three times — at `@prisma/engines` postinstall,
at `@prisma/client` postinstall, and at `prisma generate`. `node:22-alpine`
ships no openssl, so Prisma 5.22 fell back to the OpenSSL 1.1 build,
`linux-musl`, and Alpine has only OpenSSL 3, so that `.so` cannot be
`dlopen`'d.

The fix in `control-api.Dockerfile` is `apk add --no-cache openssl` in **both**
the builder and the runtime stage (builder before `pnpm install`, so the right
engine is downloaded rather than only requested). Both stages must agree, or
the mismatch reappears at pod start instead of at build time. It costs roughly
5 MB and keeps the Alpine base — moving to `node:22-slim` would also fix
detection, but it swaps a musl base for a Debian one with a larger package
surface to patch, which is not a trade worth making for a variable that
installing openssl removes outright.

**Belt-and-braces, and it needs a file this pass does not own.** Make the target
explicit rather than detected, in `apps/control-api/prisma/schema.prisma`:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}
```

With that in place the engine the image needs is generated whatever the probe
decides, and the `node --eval` guard in the Dockerfile keeps proving it. This is
the same category as item 2 (`prisma` as a devDependency): a one-line change in
the control-api owner's tree that removes a workaround from `deployments/`.

### Outstanding: Go module advisories — `security` job stays red

Item 16 below. The 1.27 bump clears ten of twelve findings. **The remaining two
are in modules, not the standard library, and no toolchain can reach them.**

---

## Known issues and follow-ups — added this pass

16. **`govulncheck` still fails on two module advisories, and fixing them forces
    the data plane's `go` directive from 1.21 to 1.25.**

    ```
    GO-2026-5004  github.com/jackc/pgx/v5  v5.7.1 -> v5.9.2
                  SQL injection via placeholder confusion with dollar-quoted
                  string literals. Reachable: queue.PostgresQueue.Renew ->
                  pgxpool.Pool.Query -> sanitize.SanitizeSQL.
    GO-2026-5970  golang.org/x/text        v0.18.0 -> v0.39.0
                  Infinite loop on invalid input. Reachable:
                  db.Open -> pgxpool.NewWithConfig -> norm.Form.
    ```

    Both fixed versions declare `go 1.25.0` in their own `go.mod`, so taking
    them raises this module's minimum to 1.25 — the exact change go.mod's
    header argues against, because it breaks anyone building on an older
    toolchain and, with `GOTOOLCHAIN=auto`, triggers a toolchain download that
    fails on a restricted network. There is no earlier fixed version of either
    advisory to take instead; this was checked, not assumed.

    **This is the module owner's call, not CI's**, which is why the
    `Vulnerability scan` step was left blocking and red rather than given an
    ignore list. The SQL-injection advisory is the one that matters — it is
    reachable from the worker's lease-renewal path. If the decision is to take
    it:

    ```bash
    cd services/data-plane
    # This will also rewrite the `go 1.21` directive to `go 1.25.0`.
    go get github.com/jackc/pgx/v5@v5.9.2 golang.org/x/text@v0.39.0
    go mod tidy && go build ./... && go vet ./... && go test ./...
    ```

    and then say so in go.mod's header, because the header currently argues the
    opposite and every contributor on an older toolchain will hit it.
