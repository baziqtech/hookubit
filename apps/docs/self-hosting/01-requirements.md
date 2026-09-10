# Requirements

What you must provision before the first install, and the properties each
dependency has to have. Read the PostgreSQL section even if you skip the rest.

## PostgreSQL 15 or newer

The schema uses `NULLS NOT DISTINCT` unique indexes, which PostgreSQL 14 and
earlier cannot express. The migration job checks the server version and
**refuses to run on an older server** rather than half-applying. Check before
anything else:

```bash
psql "$DATABASE_URL" -tAc "show server_version;"
```

Any provider works: RDS/Aurora, Cloud SQL, Azure Database, Neon, Supabase, or
self-managed. No extensions are required beyond what the migrations create.

### Two connection URLs

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | A pooler (PgBouncer) in production, or the server directly | Both planes, at runtime |
| `DIRECT_DATABASE_URL` | The server directly, never the pooler | The migration job only |

Migrations run DDL and take a session-scoped advisory lock. Through PgBouncer in
transaction-pooling mode that can leave a migration half applied with its
history row stuck in `failed`. The Helm chart refuses to render the migration
job when `DIRECT_DATABASE_URL` would fall back to the pooled URL; the other
deployment shapes rely on you setting it.

### Connection arithmetic

Every data-plane pod opens `DATABASE_MAX_CONNECTIONS` connections at startup and
**exits if it cannot get them**, so an over-committed pool does not give you
throughput; it gives you crash-looping workers at the moment traffic spiked.
Before raising worker replicas or the pool size, check:

```
(worker maxReplicas + ingest + router + scheduler replicas) x DATABASE_MAX_CONNECTIONS
  + the control API's pool
  < max_connections  (or PgBouncer default_pool_size)
```

At the Helm chart defaults that is `(8 + 2 + 2 + 1) x 10 = 130` backend
connections plus the control API. The raw manifests default the pool to 20, so
the same arithmetic gives 260.

### Backups

Point-in-time recovery matters more than snapshot frequency. The delivery
ledger is the product's answer to "what happened to this event", and a nightly
snapshot discards up to a day of that answer. Details, and the encryption-key
trap that makes a database backup useless on its own, are in
[Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades).

## Sizing

The numbers below come from the load suite run against a single data-plane
process with `WORKER_CONCURRENCY=64` on a 16-core developer machine. They tell
you what one worker process does, not what your production will do; use them
to reason, then measure.

| Scenario | Measured |
|---|---|
| Fan-out: 300 events to 25 endpoints each | 7,500 deliveries, 100% delivered, end-to-end p95 812 ms |
| Large payloads: 96 KiB events (above the 64 KiB inline limit) | 150/150 offloaded to object storage, delivery p95 611 ms |
| Ingest | Threshold p95 < 300 ms, held in every passing scenario |
| Per-source ingest ceiling | 300 requests/s per source address before authentication, burst 600 (`INGEST_SOURCE_RATE_LIMIT`) |

Ingest is the easy half. A `202` means durably stored, not delivered; the
delivery side is what needs capacity.

### Start here

| Workload | Chart default | Notes |
|---|---|---|
| Control API | 2 replicas, 200m/256Mi requests, 1 CPU/768Mi limits | Never in the delivery path. Scale for operator traffic only. |
| Ingest | 2 replicas, 100m/64Mi | The public write path; keep at least two. |
| Router | 2 replicas, 100m/64Mi | Safe above one; fan-out inserts are keyed on `(event, endpoint)`. |
| Scheduler | 1 replica, 50m/64Mi | Singleton by design. A second one only duplicates polling. |
| Worker | 2 to 8 replicas (HPA), 250m/128Mi requests, 1 CPU/512Mi limits, 64 in-flight deliveries each | The throughput dial. Total in-flight is roughly replicas x 64, bounded by the concurrency ceilings and the database. |

Workers are I/O bound: most of a worker's life is waiting on a customer's
endpoint. CPU autoscaling is the proxy that works with nothing extra installed;
queue depth (exported on `/metrics`) is the right signal once you have a
metrics adapter.

### Per-endpoint isolation is a ceiling, not a reservation

`MAX_CONCURRENCY_PER_ENDPOINT` (default 16) bounds how many in-flight attempts
one endpoint may hold. Nothing reserves capacity for the others. The load suite
measured it: six slow endpoints at the default cap (6 x 16 = 96) against a pool
of 64 are entitled to the whole pool, and fast endpoints queue behind them.

| Slow endpoints x cap | Share of a 64-slot pool | Fast endpoints p50 | Fast p95 |
|---|---|---|---|
| 6 x 16 = 96 | all of it | 6,703 ms | 16,565 ms |
| 6 x 4 = 24 | 38% | 650 ms | 8,117 ms |
| none slow (control) | - | 456 ms | 1,044 ms |

Provision so that:

```
sum(max_concurrency of endpoints that can be slow) < WORKER_CONCURRENCY
```

Nothing enforces this. The worker logs an advisory at startup when fewer than
eight endpoints at the per-endpoint cap would fill the pool; read it.

### One more ceiling: connections per destination host

`EGRESS_MAX_CONNS_PER_HOST` caps concurrent connections to one destination
`host:port`, shared by every endpoint and every tenant resolving there. A value
below the pool silently overrides every concurrency gate for any customer whose
endpoints share a hostname, which is the normal shape. Leave it unset and it
follows `WORKER_CONCURRENCY`. It used to be hard-coded at 16:

| Per-host ceiling | Fast p50 | Fast p95 |
|---|---|---|
| 16 (old hard-coded value) | 63,218 ms | 118,734 ms |
| 64 (= pool, current default) | 6,460 ms | 12,660 ms |

Set it below the pool only as a deliberate kindness to a fragile consumer.

## Redis (optional)

Redis holds one thing: token buckets for rate limits, so that an endpoint's
configured limit is enforced across every worker replica rather than inside
each one. It is not a queue and not a cache of anything durable.

| Question | Answer |
|---|---|
| Does delivery depend on it? | No. The delivery path does not import a Redis client; a test fails if it ever does. |
| What happens if it goes down mid-flight? | The limiter fails open and falls back to an in-process bucket per replica. Nothing errors, nothing is lost. The `rate_limiter_degraded_total` metric and the `WebhookRateLimiterDegraded` alert are the only signs. |
| What does "degrades to per-replica" mean? | An endpoint limited to N requests/s is effectively allowed N x (worker replicas) requests/s, and the effective limit changes every time the Deployment scales. |
| Can I run without it at all? | Yes. In `development` and `staging` the worker logs a warning. In **`production` the worker refuses to start** unless `DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true` says you accept the downgrade. The refusal reads: `REDIS_URL is not set, so endpoint delivery rate limits would be enforced PER WORKER REPLICA ... Set REDIS_URL, or set DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true to take per-replica limits deliberately`. |
| Persistence? | None needed. Buckets refill. |
| Back it up? | No. |

> **Unset is not empty.** The control plane accepts a missing `REDIS_URL` and
> rejects an empty one. Kubernetes `envFrom` and Compose `${REDIS_URL:-}` both
> inject an empty string. If you do not run Redis, leave the key out of the
> Secret entirely. The chart and the Compose file already do this; the raw
> Secret template tells you where the line is.

## Object storage (optional)

Events whose payload is at or above `PAYLOAD_INLINE_MAX_BYTES` (64 KiB) are
written to an S3-compatible bucket and the event row keeps a reference.
`PAYLOAD_MAX_BYTES` (1 MiB) is the largest event accepted at all.

| Without a bucket | With a bucket |
|---|---|
| The effective maximum event size is the inline limit. A publish at or above it is rejected. The data plane says so at startup: `object storage is not configured; payloads at or above the inline limit will be rejected`. | Payloads between the two limits go to the bucket. A failed upload is a `500` to the publisher, never a `202`: dropped ingest, not degraded ingest. |

Bucket layout, so you can set lifecycle rules on exactly the right prefix:

```
<S3_PREFIX>/<project_id>/<event_id>        S3_PREFIX defaults to "events"
```

The event id is a time-ordered identifier, so the age of an object is readable
from its key. MinIO and other non-AWS stores usually need
`S3_FORCE_PATH_STYLE=true`.

**The orphan sweep.** The payload is uploaded before the event's database
transaction commits, so a process that dies in between leaves an object no row
references. The scheduler role sweeps the platform's prefix hourly, deleting
objects older than `PAYLOAD_SWEEP_MIN_AGE_MS` (24 h; floored at 1 h, because
anything shorter races a publish between its upload and its commit) that no
event row references, at most `PAYLOAD_SWEEP_MAX_DELETES` (1000) per pass. Do
not replace it with a bucket lifecycle rule: live payloads and orphans share a
prefix and are indistinguishable by age.

**Restore consistency.** The database and the bucket must be restored to
consistent points. Snapshot the bucket after the database, never before. The
reasoning is in [Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades).

## SMTP

Registration, email verification, password reset and team invitations all end
in an email carrying a single-use link, and login refuses an unverified
address. With no transport the control plane refuses to start in `staging`
and `production`, by name, rather than coming up healthy with signup silently
broken.

| Variable | Rule |
|---|---|
| `SMTP_URL` | `smtp://user:pass@host:587` or `smtps://...`. **The scheme is mandatory**: `host:587` parses as a URL whose scheme is the hostname and is refused. Query options such as `?pool=true` or `?ignoreTLS=true` pass through to the mailer. |
| `MAIL_FROM` | Required whenever `SMTP_URL` is set. `HookuBit <no-reply@example.com>` or a bare address. The display name is also the product name in subjects and bodies. |
| `DASHBOARD_URL` | The base of every link in every message. Wrong here means mail full of dead links. |

[Mail](/self-hosting/06-mail) covers what is sent and how to test it with a
local catcher.

## Network egress

The worker dials URLs your customers typed into a form. Two layers refuse the
dangerous ones.

**In the process.** Every endpoint URL is resolved and refused if it lands in
private or special address space: RFC1918 (`10/8`, `172.16/12`,
`192.168/16`), loopback, link-local including the cloud metadata address
`169.254.169.254` and its IPv4-mapped and NAT64 spellings, CGNAT
(`100.64/10`), multicast and reserved ranges. Redirects are not followed
(`EGRESS_MAX_REDIRECTS=0`); a redirect is a second SSRF decision. A refused
delivery fails permanently and is counted in `egress_blocked_total{reason}`.

| Need | Do |
|---|---|
| Deliver to consumers on your own private network | `EGRESS_PRIVATE_ALLOWLIST=10.20.0.0/16,...` with specific CIDRs. Works in every environment. |
| Turn the guard off | Don't. `EGRESS_ALLOW_PRIVATE_NETWORKS=true` is **refused when `APP_ENV=production`**; every Go role exits at startup. The Helm chart fails at render time so you do not discover this from four crash loops. |

**In the kernel.** Both Kubernetes shapes ship default-deny NetworkPolicies:
only the worker gets internet egress, on every port (a customer endpoint on
`:8443` is legitimate), with the same private ranges subtracted; the other
roles and the control plane reach private space only on the database and Redis
ports. These are only enforced if your CNI implements NetworkPolicy. Calico,
Cilium, Antrea and Weave do; stock EKS without the policy agent, flannel and a
default kind/minikube accept the objects and ignore them. IPv6 egress is not
granted by default; an IPv6-only customer endpoint is unreachable until you add
a rule.

**What must be reachable**

| From | To |
|---|---|
| Every role and the control API | PostgreSQL (or PgBouncer), Redis if used, DNS |
| Ingest and worker | Object storage, if used |
| Worker | The public internet, any port, for customer endpoints |
| Control API | Your SMTP relay, your OTLP collector if used |
| Data plane | Your OTLP collector if used |

---

**Where this comes from.** `.env.example`, `docs/LOCAL_SETUP.md` §0, `docs/LOAD_TESTING.md` §3 and §7, `deployments/helm/hookubit/values.yaml`, `services/data-plane/internal/config/{config,isolation}.go`, `services/data-plane/internal/payloadstore/{keys,reconcile}.go`, `services/data-plane/cmd/webhookd/roles.go` (`buildPayloadStore`, `buildDeliveryLimiter`), `apps/control-api/src/config/env.schema.ts`, `deployments/kubernetes/50-networkpolicy.yaml`.
