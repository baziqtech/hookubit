# Kubernetes manifests

Plain manifests for teams that own their YAML: the same workloads, probes,
policies and security posture as the Helm chart, with nothing templated. They
live in `deployments/kubernetes/` in the release and apply with Kustomize.

```bash
kubectl apply -k deployments/kubernetes
```

That one command deploys the application. It deliberately does **not** create
Secrets or run migrations; both are separate steps below.

## Apply order

| File | Contents | In the kustomization? |
|---|---|---|
| `00-namespace.yaml` | Namespace `webhook-platform`, labelled for Pod Security Admission `restricted` | yes |
| `01-configmap.yaml` | Every non-secret setting for both planes | yes |
| `02-secret.template.yaml` | **Template only.** Placeholders for the three Secrets. Never commit a filled copy | no: create the Secrets out of band |
| `10-migration-job.yaml` | The migration Job. Uses `generateName`, so `kubectl create`, not `apply` | no: run it explicitly |
| `20-control-api.yaml` | Control API Deployment and Service, 2 replicas | yes |
| `21-dashboard.yaml` | Dashboard Deployment and Service, 2 replicas | yes |
| `30-ingest.yaml` | `webhookd ingest` Deployment and Service, 2 replicas | yes |
| `31-router.yaml` | `webhookd router` Deployment, 2 replicas | yes |
| `32-scheduler.yaml` | `webhookd scheduler` Deployment, 1 replica, `Recreate` | yes |
| `33-worker.yaml` | `webhookd worker` Deployment and HPA (2 to 8) | yes |
| `40-pdb.yaml` | PodDisruptionBudgets for everything except the scheduler | yes |
| `41-ingress.yaml` | Two Ingresses: app host and ingest host | yes |
| `50-networkpolicy.yaml` | Default-deny plus five allow policies | yes, on purpose |

The sequence for a first install:

1. Create the three Secrets (below).
2. `kubectl -n webhook-platform create -f deployments/kubernetes/10-migration-job.yaml`
   and wait for it: `kubectl -n webhook-platform wait --for=condition=complete --timeout=10m job -l app.kubernetes.io/component=migrate`.
3. `kubectl apply -k deployments/kubernetes`.
4. Create the first owner with a bootstrap Job (the Helm page shows the shape;
   substitute `webhook-platform-config` and `webhook-platform-app` for the
   `envFrom` names).

## The Secrets

`02-secret.template.yaml` describes three Secrets. Populate them from your
secret manager (External Secrets Operator, `kubectl create secret`, SOPS); the
template's header carries the exact `kubectl create secret` lines.

| Secret | Keys | Mounted by |
|---|---|---|
| `webhook-platform-database` | `DATABASE_URL` (pooled), `DIRECT_DATABASE_URL` (direct, for migrations), optionally `REDIS_URL` | Control API, migration Job |
| `webhook-platform-app` | `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `SMTP_URL`, optionally `S3_*` | Control API |
| `webhook-platform-data-plane` | `DATABASE_URL`, optionally `REDIS_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | The four Go roles |

The split is least privilege: the worker dials customer-controlled URLs and is
the worst process in the system to hold the key that forges a session cookie,
so `JWT_SECRET` and `SESSION_SECRET` never reach it.

> **`ENCRYPTION_KEY` must be the same value in both `webhook-platform-app` and
> `webhook-platform-data-plane`.** The control plane encrypts endpoint signing
> secrets with it; the worker decrypts them with it and exits at startup
> without it (`build decryption keyring: ENCRYPTION_KEY is required`). The
> template lists it in both. When you rotate, `ENCRYPTION_KEY_ID` and
> `ENCRYPTION_KEYS_RETIRED` go in both as well.

> **Optional keys are omitted, never empty.** `envFrom` projects every key in a
> Secret as a set variable, and the control API accepts a missing `REDIS_URL`
> but rejects an empty one. If you do not run Redis or object storage, leave
> the lines out.

## What to edit

| Where | What | Why |
|---|---|---|
| `41-ingress.yaml` | Both hostnames, `ingressClassName`, the cert-manager annotation | They are `example.com` placeholders. Two hosts on purpose: publisher bursts and browser traffic are rate-limited and scaled separately. The ingest Ingress carries `proxy-body-size: 2m`, just above the 1 MiB payload cap, so an oversized publish gets an application error rather than a bare 413. |
| `20-control-api.yaml` | `CORS_ORIGINS` and `DASHBOARD_URL` in the container `env` | Both are `https://webhooks.example.com`. `DASHBOARD_URL` is the base of every link in outbound mail. |
| `01-configmap.yaml` | `MAIL_FROM` | Placeholder sender. Required whenever `SMTP_URL` is set. |
| `01-configmap.yaml` | `DATABASE_MAX_CONNECTIONS` (20 here; the chart defaults to 10) | Per-pod pool. `(8 + 2 + 2 + 1) x 20 = 260` connections plus the control API at the HPA ceiling. Check it against your `max_connections`. |
| `01-configmap.yaml` | `EGRESS_MAX_CONNS_PER_HOST: '64'` | Hard-set to match `WORKER_CONCURRENCY: '64'`. Raise both together, or delete the key and let it derive. Below the pool it silently overrides the concurrency gates. |
| `01-configmap.yaml` | `TRUST_PROXY_HOPS: '1'`, `INGEST_TRUSTED_PROXY_HOPS: '1'` | The exact number of proxies in front of the pods. `1` is the Ingress in `41-ingress.yaml`; a CDN or a load balancer that rewrites `X-Forwarded-For` in front of it makes `2`. At 0 behind a proxy, per-IP rate limiting collapses into one bucket for everyone. |
| `01-configmap.yaml` | `EGRESS_PRIVATE_ALLOWLIST` | Specific CIDRs if you deliver to internal consumers. `EGRESS_ALLOW_PRIVATE_NETWORKS` cannot be `true` here: `APP_ENV` is `production` and every Go role would refuse to start. |
| `kustomization.yaml` | `images[].newTag` | Pins all three images to one version. Change it here, not in each Deployment. |
| `10-migration-job.yaml` | The image tag | Not covered by the kustomization; keep it at `<version>-migrate` for the same version. |
| `21-dashboard.yaml` | The two `built-with-*` annotations | Documentation only. They record what the image was built with; editing them changes nothing. |

Everything else in the ConfigMap is a tuning knob with the same defaults as the
chart. [Configuration](/self-hosting/05-configuration) explains each.

## The migration Job

`10-migration-job.yaml` uses `generateName`, so every run creates a new Job and
`kubectl create` is the right verb. It is excluded from the kustomization so
that `kubectl apply -k` can never change the schema as a side effect. The Job
takes its `DATABASE_URL` from the Secret's `DIRECT_DATABASE_URL` key: migrations
must bypass PgBouncer.

The image is `webhook-control-api:<version>-migrate`, the build target that
still carries the migration tooling. The runtime image does not, and the
command uses `--no-install` so it can never silently download a different
version from the registry.

Read the ordering rule in
[Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades)
before running it on an upgrade. One migration must run after the new data
plane, not before.

## What the manifests already do

| Property | Detail |
|---|---|
| Security | `runAsNonRoot`, explicit UIDs (1000 Node, 101 nginx, 65532 distroless), read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp, no service account token. Writable paths are `emptyDir` mounts only: `/tmp` everywhere, plus `/var/cache/nginx` for the dashboard. |
| Probes | Startup and liveness on `/health/live`; readiness on `/health/ready`. Liveness never touches PostgreSQL. With the database down the Go pods stay up and report `starting`, not crash-looping. |
| Grace periods | 45 s control API, 60 s ingest/router/scheduler, 90 s worker (an attempt can run 30 s; SIGKILL mid-attempt means waiting out a 120 s lease). |
| Spread | `topologySpreadConstraints` across hostnames for control API, ingest and workers. |
| Worker replicas | Omitted from the Deployment on purpose: the HPA owns the field. Setting it makes every `kubectl apply` fight the autoscaler. |
| Scrape annotations | `prometheus.io/scrape`, `prometheus.io/port` and `prometheus.io/path` on every Go role, port 9090. |
| NetworkPolicies | Default-deny both directions; DNS to `kube-system` only; datastore ports only into private space; internet egress for the worker alone with private ranges subtracted; HTTP ingress on 3000/8080 from anywhere in the cluster. Tighten the last with a `namespaceSelector` for your ingress controller. |

The NetworkPolicy file's header has the two checks that matter: your CNI must
enforce NetworkPolicy (many accept and ignore it), and a database on a public
address is not covered by the datastore rule.

## Kustomize overlays

The directory is a valid base. A typical overlay pins images and patches the
hostnames:

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../deployments/kubernetes
images:
  - name: ghcr.io/shaq/webhook-control-api
    newTag: 0.2.0
  - name: ghcr.io/shaq/webhook-data-plane
    newTag: 0.2.0
  - name: ghcr.io/shaq/webhook-dashboard
    newTag: 0.2.0
patches:
  - target: { kind: Ingress, name: webhook-platform }
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: webhooks.example.org
```

Keep `50-networkpolicy.yaml` in the base. A security control that is opt-in is
a security control nobody has.

---

**Where this comes from.** `deployments/kubernetes/*.yaml`, `deployments/kubernetes/kustomization.yaml`, `deployments/HANDOFF.md`, `services/data-plane/cmd/webhookd/roles.go` (`runWorker`), `services/data-plane/internal/worker/crypto.go` (`decodeKey`).
