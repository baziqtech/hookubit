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
`helm uninstall`), `values.yaml`, `values.schema.json`, eleven templates and
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
  the rendered chart and the raw manifests, plus two guardrail steps: the chart
  must *fail* to lint with default values, and no database may appear in the
  manifests.

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

## Known issues and follow-ups, in priority order

1. **`services/data-plane/go.mod` still says `go 1.21`.** Not mine to change —
   the data-plane owner should raise it to 1.23. It is not currently a
   conflict: `go 1.21` is the minimum *language* version, and CI and the
   Dockerfile both run the 1.23 toolchain against it. CI now carries a comment
   saying so, and the version lives in one `GO_VERSION` variable.
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
5. **No NetworkPolicies.** The namespace is labelled for PSA `restricted` but
   nothing restricts pod-to-pod or egress traffic. Egress policy is genuinely
   awkward here — workers must reach arbitrary customer URLs by design, so the
   policy has to be "deny RFC1918 and metadata, allow the internet", which
   duplicates the in-process SSRF guard at a second layer. Worth doing;
   deliberately out of scope for this pass.
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
