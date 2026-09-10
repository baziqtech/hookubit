# Self-hosting HookuBit

HookuBit runs as a hosted service or on your own infrastructure against your own
PostgreSQL. This section is for the operator who runs it: what the platform
ships, what you have to bring, which deployment shape to pick, and the traps
each one has.

**The rule every page here follows: containers are disposable, customer data is
not.** Nothing in the platform's own containers holds state. Delete every pod,
reinstall against the same database, and every event, delivery and attempt is
still there. That is only true because the database is yours, which is why no
deployment option bundles one.

## What you get

Four container images, published under `ghcr.io/shaq`:

| Image | What it is | Scale it for |
|---|---|---|
| `webhook-control-api` | The control plane: REST API, authentication, organizations, projects, endpoints, subscriptions, policies, the delivery log, outbound mail. Node.js. | Availability. It is never in the delivery hot path; two replicas is for uptime, not throughput. |
| `webhook-control-api:<version>-migrate` | The migration job. The same build with the migration tooling still present; it applies schema changes and exits. | Nothing. Run once per upgrade, explicitly. |
| `webhook-data-plane` | The data plane. One Go binary, four roles chosen by argument: `ingest` (accepts events), `router` (fans out to delivery rows), `scheduler` (retries, retention, sweeps), `worker` (signs and sends). | Throughput. Workers are the dial. |
| `webhook-dashboard` | The operator dashboard, a static bundle served by nginx. | Nothing meaningful; it is files. |

The two planes are separable on purpose. The control plane can be down and
queued deliveries still go out; the data plane can be down and the dashboard
still answers "what happened to this event" from the database.

> **The dashboard is configured when its image is built, not when it is
> deployed.** Its API address and the ingest URL it prints on the get-started
> page are baked into the JavaScript. No environment variable, ConfigMap or
> chart value changes them. If your get-started page tells publishers to send
> events to `http://localhost:8080`, or shows a "Demo data" banner, the image
> was built with the defaults and you need one built with
> `VITE_API_TRANSPORT=http` and your ingest host. Every deployment page below
> repeats this, because it is the first thing operators hit.

## What you bring

| Dependency | Required? | Holds | If it vanishes for an hour |
|---|---|---|---|
| **PostgreSQL 15 or newer**, external and yours | Yes | Everything durable: tenants, endpoints, encrypted secrets, the event ledger, the delivery queue, every attempt | You lose time. Ingest refuses, workers wait, nothing accepted is lost. |
| **Redis** | No | Rate-limiter token buckets only | Limits become per-replica until it returns. Delivery does not depend on it. |
| **S3-compatible object storage** | No, unless you need events above 64 KiB | Payload bodies above the inline limit | Large publishes fail with a 500; deliveries of offloaded events defer without spending retries. |
| **SMTP** | Yes, outside development | Nothing | Verification, reset and invitation mail is not sent. The control plane refuses to start without it in staging and production. |
| **Kubernetes 1.25+** or a Docker host | One of them | Nothing | It is compute. |

Details, sizing and the traps for each are in [Requirements](/self-hosting/01-requirements).

## Which deployment to pick

| Option | Pick it when | Read |
|---|---|---|
| **Helm chart** | You run Kubernetes and want guard rails: the chart refuses to install without a database URL, the three secrets and an SMTP URL, renders NetworkPolicies by default, and carries the migration job and HPA. Recommended. | [Helm](/self-hosting/02-helm) |
| **Raw manifests** | You run Kubernetes and your platform team owns the YAML (GitOps, Kustomize overlays, no Helm). Same workloads, same probes, same policies, nothing templated. | [Kubernetes manifests](/self-hosting/03-kubernetes-manifests) |
| **Docker Compose** | One host, a small installation or a staging environment. Every process, no orchestration. | [Docker Compose](/self-hosting/04-docker-compose) |

All three deploy the same images with the same environment variables. The
[Configuration](/self-hosting/05-configuration) reference is the one place
every key is listed.

## Reading order

| Order | Page | When you need it |
|---|---|---|
| 1 | [Requirements](/self-hosting/01-requirements) | Before provisioning anything. PostgreSQL version, sizing, what Redis and object storage do and do not do, egress rules. |
| 2 | One of [Helm](/self-hosting/02-helm), [Kubernetes manifests](/self-hosting/03-kubernetes-manifests), [Docker Compose](/self-hosting/04-docker-compose) | The install. |
| 3 | [Configuration](/self-hosting/05-configuration) | Every environment key, its default, which plane reads it, and the values that refuse to boot. |
| 4 | [Mail](/self-hosting/06-mail) | Before the first operator tries to sign in. |
| 5 | [Observability](/self-hosting/07-observability) | Before go-live: health endpoints, the alerts worth having, tracing, logs. |
| 6 | [Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades) | Before go-live, and before every upgrade. |
| - | [Glossary](/self-hosting/glossary) | Whenever a word here is unfamiliar. |

The first owner account is never created for you. There is no default login.
Each deployment page ends with the bootstrap step that creates it.

---

**Where this comes from.** `deployments/HANDOFF.md`, `deployments/helm/hookubit/Chart.yaml` and `values.yaml`, `deployments/docker/*.Dockerfile`, `docs/adr/0006-no-default-credentials.md`.
