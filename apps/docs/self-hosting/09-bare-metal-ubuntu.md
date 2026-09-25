# Bare metal on Ubuntu

No Docker. systemd for the platform, nginx in front of everything public,
Cloudflare serving the dashboard, and PostgreSQL and Redis on their own
machines. Mail goes to Amazon SES; Prometheus and Grafana watch the lot.

Ubuntu 22.04 or 24.04 throughout, PostgreSQL 15 or newer. If you would rather
run containers, read [Docker Compose](/self-hosting/04-docker-compose) — and see
[Where Docker still earns its place](#where-docker-still-earns-its-place) at the
end, because the honest answer is "for two of these, yes".

## The shape

```
                    ┌─────────────────────────────────────────┐
  browser  ────────▶│ Cloudflare   webhooks.example.com       │
                    │  · serves /assets/* from cache          │
                    │  · passes /v1/* and /health/* to origin │
                    └────────────────────┬────────────────────┘
                                         │
  publisher ──────────────────────────┐  │
  (server-to-server)                  ▼  ▼
                            ┌────────────────────────┐
                            │ app host — nginx :443  │
                            │  hookubit-api    :3000 │
                            │  hookubit-data-plane   │
                            │    ingest        :8080 │
                            │    probes        :9090 │
                            └────┬──────────────┬────┘
                                 │              │
                   ┌─────────────▼──┐      ┌────▼───────────┐
                   │ db.lan:5432    │      │ cache.lan:6379 │
                   │ PostgreSQL     │      │ Redis          │
                   │ system of      │      │ rate-limiter   │
                   │ record + queue │      │ buckets only   │
                   └────────────────┘      └────────────────┘
```

| Host | Runs | Loses what, if it dies |
|---|---|---|
| **app** | nginx, `hookubit-api`, `hookubit-data-plane` | Time. Queued deliveries resume from PostgreSQL. |
| **db** | PostgreSQL 15+ | **Everything.** System of record *and* the delivery queue. |
| **cache** | Redis | Rate-limiter accuracy. Not deliveries. |
| **monitoring** | Prometheus, Grafana | Visibility. Nothing operational. |

**`webhookd all` runs all four data-plane roles in one process.** One unit, one
log, one set of probes. The roles split into separate deployments the day the
worker needs to scale on its own; until then four processes on one box only
contend for the same CPU. If you do split, read the metrics-port trap at the
bottom first.

::: tip Redis is not the queue
The queue is PostgreSQL. Redis holds rate-limiter buckets and throttle counters.
Lose it and limits degrade to per-process for as long as it is gone; you lose no
deliveries. That is why it gets no backup and no replication here.
:::

---

## Two constraints that decide the whole design

Read these before you buy a domain. Both are properties of the code, not
preferences, and both are cheap to satisfy and expensive to retrofit.

### 1. The dashboard must be same-origin with the control API

The dashboard calls the API with **relative paths** — `fetch('/v1/projects')`,
in `apps/dashboard/src/lib/api.ts`. There is no API base-URL setting and nothing
to configure. Whatever origin serves `index.html` must also answer `/v1/*`.

So the working shape is **one hostname**, with Cloudflare deciding per path
whether to serve a cached asset or pass the request to your origin. What does
*not* work is a dashboard on `dash.example.com` (or `*.pages.dev`) talking to an
API on `api.example.com`: every call 404s at the CDN.

There is a second reason the same hostname is the right answer. The session
cookie is issued `HttpOnly; SameSite=Lax`, hardcoded in
`apps/control-api/src/auth/session.service.ts`. A `Lax` cookie is not sent on
cross-**site** requests, so a dashboard on `hookubit.pages.dev` calling
`api.example.com` would sign in successfully and then be anonymous on every
subsequent request — a failure that looks like a broken session, not a broken
deployment. Subdomains of one registrable domain *are* same-site, so
`app.example.com` → `api.example.com` would keep working; a different
registrable domain would not. One hostname sidesteps the question entirely.

### 2. Ingest gets its own hostname

Publishing is server-to-server with a bearer token. It has a completely
different traffic shape from the dashboard, no cookies and no CORS, and you will
eventually want to rate-limit, cache and scale it separately. Give it
`hooks.example.com`.

That hostname is **compiled into the dashboard bundle** as
`VITE_INGEST_BASE_URL`, so decide it before you build.

---

## 1. The database host

The migration refuses to run on PostgreSQL 14 or older — the schema uses
`NULLS NOT DISTINCT` unique indexes, which earlier versions cannot express. It
refuses rather than half-applying, but find out now:

```bash
psql "postgresql://postgres@db.lan:5432/postgres" -tAc "show server_version;"
```

```sql
CREATE ROLE hookubit LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE hookubit OWNER hookubit;
```

On a dedicated box PostgreSQL still listens on localhost only by default. In
`postgresql.conf`:

```ini
listen_addresses = 'localhost,10.0.0.10'   # its LAN address, not 0.0.0.0
```

and in `pg_hba.conf`, the app host and nothing wider:

```ini
# TYPE  DATABASE   USER      ADDRESS          METHOD
host    hookubit   hookubit  10.0.0.20/32     scram-sha-256
```

Reload and prove it from the **app** host, not from the database host:

```bash
pg_isready -h db.lan -p 5432 -U hookubit -d hookubit
```

::: warning Put a firewall in front of it anyway
`pg_hba.conf` is authentication, not network policy. `ufw allow from 10.0.0.20
to any port 5432` on the database host means a mistake in one file is not the
only thing between your ledger and the network.
:::

### Two URLs, and why

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | The database, through a pooler if you have one | Both planes, at runtime |
| `DIRECT_DATABASE_URL` | The server directly, never a pooler | The migration command only |

With no PgBouncer, set both to the same string. Keep them as two variables
anyway: the day you add a pooler, migrating through it in transaction-pooling
mode can leave a migration half applied with its history row stuck in `failed`,
because Prisma takes a session-scoped advisory lock that pooling breaks.

### Connection arithmetic

Every data-plane process opens `DATABASE_MAX_CONNECTIONS` at startup and
**exits if it cannot get them**. An over-committed pool is not slow throughput,
it is a crash-looping worker at the moment traffic spikes.

```
(webhookd processes × DATABASE_MAX_CONNECTIONS)
  + control API pool
  + your psql sessions
  < max_connections
```

`webhookd all` is one process, so this only bites once you split or scale.

---

## 2. The Redis host

```bash
sudo apt install -y redis-server
```

In `/etc/redis/redis.conf`:

```ini
bind 127.0.0.1 10.0.0.11
requirepass a-long-random-password
# Rate-limiter buckets only. Nothing here is worth persisting, and an AOF
# fsync on the delivery path is latency you are buying for no benefit.
save ""
appendonly no
maxmemory 256mb
maxmemory-policy allkeys-lru
```

`allkeys-lru` rather than `noeviction` is deliberate: every key is a bucket with
a TTL, and evicting the oldest under pressure costs a little limiter accuracy,
where refusing writes would make every limited request fail.

Firewall it to the app host, as with PostgreSQL.

**Redis is not optional in production.** A production worker refuses to start
without it, because endpoint rate limits would otherwise be enforced per
process — a customer's limit of N silently becoming N × replicas. There is an
escape hatch (`DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true`) for a single-worker
box, but Redis also gives the control API a shared throttle store.

That refusal gates **configuration, not the runtime**, and the difference
matters when you are putting Redis on a machine of its own. A Redis that was
never configured is refused at startup; a Redis that was configured and then
dies costs you the fleet-wide limiter scope and nothing else. Delivery cannot
depend on it — the limiter fails open to an in-process bucket, and there is an
import guard asserting the delivery path cannot even reach a Redis client. So
this host is not a single point of failure for deliveries, only for the
accuracy of rate limits while it is down.

---

## 3. The app host

```bash
sudo apt update
sudo apt install -y build-essential git curl ca-certificates nginx
```

Node 22 and pnpm — the repo pins pnpm through `packageManager`, so let corepack
read it rather than installing a version by hand:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
```

Go — match the version CI builds against, not whatever `apt` has:

```bash
grep GO_VERSION .github/workflows/ci.yml
curl -fsSL https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
```

`go.mod` states a *minimum* language version, not a pin. The CI version is the
one that has actually been tested.

A system user with no shell:

```bash
sudo useradd --system --create-home --home-dir /opt/hookubit --shell /usr/sbin/nologin hookubit
sudo mkdir -p /opt/hookubit/{src,bin,web} /etc/hookubit
sudo chown -R hookubit:hookubit /opt/hookubit
```

---

## 4. Build

Build as the service user so nothing in the tree ends up owned by root:

```bash
sudo -u hookubit -H bash
cd /opt/hookubit/src
git clone https://github.com/YOU/hookubit.git .    # or rsync the tree across
pnpm install --frozen-lockfile
```

### The control API

```bash
pnpm generate            # the Prisma client — `pnpm install` alone does not produce it
pnpm --filter @hookubit/control-api build
```

Output is `apps/control-api/dist/main.js`, and it needs `node_modules` at
runtime. Do **not** prune to production dependencies: `prisma` is a
devDependency and you need the CLI on the box for migrations and upgrades.

### The data plane

```bash
cd /opt/hookubit/src/services/data-plane
go build -o /opt/hookubit/bin/webhookd ./cmd/webhookd
```

One static binary. Nothing else to install.

### The dashboard

**Two values are compiled in and cannot be changed afterwards.**

```bash
cd /opt/hookubit/src
VITE_API_TRANSPORT=http \
VITE_INGEST_BASE_URL=https://hooks.example.com \
  pnpm --filter @hookubit/dashboard build
```

- `VITE_API_TRANSPORT=http` — **without it the dashboard runs against its
  in-memory mock.** Every screen works, backed by data that does not exist. If
  nothing you create ever reaches the database, this is why.
- `VITE_INGEST_BASE_URL` — the public ingest origin, printed in the get-started
  page's `curl`. Leave it unset and that example says `http://localhost:8080`,
  which is right on a laptop and wrong in every message you paste to anyone.

`apps/dashboard/dist/` is what Cloudflare will serve. Keep a copy on the app
host too — nginx serves it as the origin, and as a fallback if you ever take
Cloudflare out of the path:

```bash
sudo rsync -a --delete apps/dashboard/dist/ /opt/hookubit/web/
```

---

## 5. Configuration

```bash
sudo install -o hookubit -g hookubit -m 0600 /dev/null /etc/hookubit/hookubit.env
sudo -u hookubit tee /etc/hookubit/hookubit.env >/dev/null <<'EOF'
APP_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public
DIRECT_DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public
DATABASE_MAX_CONNECTIONS=20
REDIS_URL=redis://:PASSWORD@cache.lan:6379/0

ENCRYPTION_KEY=REPLACE
JWT_SECRET=REPLACE
SESSION_SECRET=REPLACE

# Amazon SES, over SMTP. The credentials are SES *SMTP* credentials, which are
# derived from an IAM user and are NOT the IAM access key itself.
SMTP_URL=smtp://SES_SMTP_USER:SES_SMTP_PASSWORD@email-smtp.eu-west-1.amazonaws.com:587
MAIL_FROM=HookuBit <no-reply@example.com>

# The origin every link in every email is built from. Wrong here means mail
# full of dead links. Same hostname the dashboard is served from.
DASHBOARD_URL=https://webhooks.example.com
CORS_ORIGINS=https://webhooks.example.com

CONTROL_API_PORT=3000
INGEST_PORT=8080
DATA_PLANE_METRICS_PORT=9090

# EXACTLY the number of reverse proxies in front of each process.
# Cloudflare + nginx = 2. See "Proxy hops" below before changing these.
TRUST_PROXY_HOPS=2
INGEST_TRUSTED_PROXY_HOPS=2

WORKER_CONCURRENCY=32
EOF
```

Generate the three secrets separately so they never appear in your shell
history as part of a heredoc:

```bash
for k in ENCRYPTION_KEY:32 JWT_SECRET:48 SESSION_SECRET:48; do
  sudo -u hookubit sed -i "s|^${k%%:*}=REPLACE|${k%%:*}=$(openssl rand -base64 ${k##*:})|" \
    /etc/hookubit/hookubit.env
done
```

::: danger Back up ENCRYPTION_KEY somewhere that is not the database
Endpoint signing secrets are AES-256-GCM ciphertext bound to their row, and the
key lives only in this file. A database backup restored without it gives you a
platform that starts, accepts events, and fails every single delivery at
signing time.
:::

### Proxy hops

`TRUST_PROXY_HOPS` is an exact count, not a boolean, and it is how the
per-IP rate limiter finds the client. Set it too low and every request in the
world shares one bucket, because they all appear to come from your proxy. Set it
too high and a client can spoof its own address by sending an
`X-Forwarded-For` header.

With Cloudflare proxying to nginx proxying to the process, that is **2**. If you
later take Cloudflare out of the path, it is 1. If you put a load balancer in
front of Cloudflare, it is 3. Count the hops; do not guess.

Make nginx honest about the chain by trusting Cloudflare's ranges (see the nginx
section), or the count is meaningless.

### Consumers on the LAN

The SSRF guard refuses to deliver to private addresses, and in
`APP_ENV=production` the blanket override is **refused outright** —
`EGRESS_ALLOW_PRIVATE_NETWORKS=true` will not start. Name the subnets instead:

```bash
EGRESS_PRIVATE_ALLOWLIST=10.0.0.0/24,192.168.1.0/24
```

A default route (`0.0.0.0/0`) is rejected too: that is the absence of an
allowlist written to look like one.

### Object storage

There is none configured, and that is fine. The effect is that the maximum event
size is the inline limit (64 KiB), and a larger payload is refused with exactly
that reason rather than silently truncated. Add `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` when you need bigger events.

---

## 6. Migrate

Migrations are a separate command, never something an app does on start. Run it
by hand now, and on every upgrade:

```bash
cd /opt/hookubit/src/apps/control-api
sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate deploy

sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate status
```

Two migrations in the history invert the usual "apply ahead of the code" rule
and must be run with the data plane stopped. Both say so in capitals in their
own header — see
[Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades).

---

## 7. systemd

### `/etc/systemd/system/hookubit-api.service`

```ini
[Unit]
Description=HookuBit control API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hookubit
Group=hookubit
WorkingDirectory=/opt/hookubit/src/apps/control-api
EnvironmentFile=/etc/hookubit/hookubit.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
# Above the Nest shutdown path, so in-flight requests finish instead of being
# killed mid-response.
TimeoutStopSec=30

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/hookubit

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/hookubit-data-plane.service`

```ini
[Unit]
Description=HookuBit data plane (ingest, router, scheduler, worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hookubit
Group=hookubit
WorkingDirectory=/opt/hookubit
EnvironmentFile=/etc/hookubit/hookubit.env
ExecStart=/opt/hookubit/bin/webhookd all
Restart=on-failure
RestartSec=5
# webhookd drains for 25s in process, and one outbound attempt can take a full
# EGRESS_TOTAL_TIMEOUT_MS (30s) on top. systemd's 90s default is fine; this is
# explicit so nobody "tidies" it down to 10.
TimeoutStopSec=90

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Neither unit lists `After=postgresql` or `After=redis`, because neither runs
here. Both retry the database on a backoff instead of exiting, which is what you
want when the database host reboots.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hookubit-api hookubit-data-plane
```

### Prove they are up

```bash
curl -s localhost:3000/health/live      # control API
curl -s localhost:9090/health/ready     # data plane, including its database ping
curl -s localhost:9090/metrics | head   # Prometheus exposition
```

`/health/ready` distinguishes `connecting` from `down` for PostgreSQL, which are
different operator stories: one has never opened a pool, the other opened one
and lost it.

---

## 8. nginx

nginx terminates TLS at the origin and routes by path and hostname. Cloudflare
sits in front of it; the origin certificate can be a Cloudflare Origin CA
certificate, which is free and lasts fifteen years, or Let's Encrypt.

### Trust Cloudflare's addresses first

Without this, `X-Forwarded-For` is whatever the client claimed and
`TRUST_PROXY_HOPS` is decoration.

`/etc/nginx/conf.d/cloudflare.conf`:

```nginx
# Refresh from https://www.cloudflare.com/ips/ — these change.
# A cron that curls the list and reloads nginx is worth the five lines.
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
# … the rest of https://www.cloudflare.com/ips-v4 and ips-v6 …
real_ip_header CF-Connecting-IP;
```

### `/etc/nginx/sites-available/hookubit`

```nginx
# ── Dashboard + control API: ONE origin, because the dashboard calls the API
# with relative paths. See "Two constraints" above.
server {
    listen 443 ssl http2;
    server_name webhooks.example.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    # The API. Everything under /v1 and /health goes to the control plane.
    location ~ ^/(v1|health)/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long enough for a slow report, short enough to free the worker.
        proxy_read_timeout 60s;
    }

    # The dashboard, as origin for Cloudflare's cache.
    root /opt/hookubit/web;

    location /assets/ {
        # Hashed filenames: safe to cache for ever.
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location / {
        # index.html must NEVER be cached, or a deploy leaves every browser on
        # a stale bundle pointing at assets that no longer exist.
        add_header Cache-Control "no-store";
        try_files $uri /index.html;
    }
}

# ── Ingest: its own hostname, its own limits.
server {
    listen 443 ssl http2;
    server_name hooks.example.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    # The platform enforces per-key and per-IP limits itself. This is a crude
    # outer bound so a publisher in a loop cannot reach the app at all.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}
```

`client_max_body_size 2m` must stay **above** the platform's own payload
ceiling, which is `PAYLOAD_MAX_BYTES` and defaults to 1 MiB. If nginx refuses
first, the publisher gets an nginx HTML error page instead of the platform's
JSON naming the limit it hit. Raise this whenever you raise that.

Note what is *not* exposed: `9090` is probes and metrics, and it stays on
localhost. Prometheus reaches it over the private network or an SSH tunnel —
never through nginx.

```bash
sudo ln -s /etc/nginx/sites-available/hookubit /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 9. Cloudflare

Two DNS records, both **proxied** (orange cloud):

| Name | Type | Value |
|---|---|---|
| `webhooks` | A | app host's public IP |
| `hooks` | A | app host's public IP |

Then, and this is the part that matters:

**SSL/TLS mode must be Full (strict).** "Flexible" makes Cloudflare talk plain
HTTP to your origin, so every session cookie and every signing secret you read
in the dashboard crosses the internet in clear text, while the browser shows a
padlock.

**Cache rules.** Cloudflare caches static assets by extension by default, which
is nearly right. Make it exactly right:

| Path | Rule |
|---|---|
| `/assets/*` | Cache everything, respect origin TTL (the files are content-hashed) |
| `/v1/*` | **Bypass cache** |
| `/health/*` | **Bypass cache** |
| `/` and `/index.html` | Bypass cache, or you will serve a stale bundle after a deploy |

A cached `POST /v1/...` is not possible, but a cached `GET /v1/projects` served
to the wrong tenant absolutely is. Bypass the API prefix explicitly rather than
relying on Cloudflare's defaults staying what they are today.

**Do not enable Rocket Loader, Auto Minify or Email Obfuscation** on
`webhooks.example.com`. They rewrite JavaScript and HTML, and the bundle is
already minified and content-hashed; the only thing they can do here is break it
in ways that reproduce on no one's laptop.

**Leave `hooks.example.com` alone** apart from proxying. No caching, no
transformations. It takes signed `POST` bodies, and the signature covers the
exact bytes — anything that rewrites a request body makes every delivery fail
verification.

### If you would rather use Cloudflare Pages

You can, but you must still answer `/v1/*` from the same hostname — either with
a Pages Function proxying to your origin, or a Worker route. The moment the
dashboard and the API are on different hostnames, you are relying on the session
cookie surviving a cross-site request, and it will not. See
[Two constraints](#two-constraints-that-decide-the-whole-design).

---

## 10. Mail: Amazon SES

Create SES **SMTP credentials** (not an IAM access key — SES derives a separate
username and password for SMTP), verify your sending domain, and move the
account out of the sandbox. Then:

```bash
SMTP_URL=smtp://SES_SMTP_USER:SES_SMTP_PASSWORD@email-smtp.eu-west-1.amazonaws.com:587
MAIL_FROM=HookuBit <no-reply@example.com>
```

```bash
sudo systemctl restart hookubit-api
```

Three things to get right, because each fails silently:

- **`MAIL_FROM` must be on a domain SES has verified**, or every send is
  rejected and the only symptom is that nobody receives an invitation.
- **SPF and DKIM on the sending domain.** Without them, verification links land
  in spam, which is indistinguishable from the feature being broken.
- **The sandbox.** A new SES account can only send to verified addresses. Your
  own test will work and your first real user's will not.

The control API refuses to start in production without a mail transport, on
purpose: registration, password reset, invitations and notification-address
confirmation all silently deliver nothing otherwise.

---

## 11. Prometheus and Grafana

### What actually exports metrics

| Component | Endpoint |
|---|---|
| data plane (`webhookd`, every role) | `:9090/metrics` |
| control API | **nothing** — there is no Prometheus endpoint today |
| dashboard | nothing; it is static files |

So you are scraping one target on one box. Set expectations accordingly: these
metrics describe delivery, not sign-ins.

### Prometheus

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin prometheus
sudo mkdir -p /etc/prometheus /var/lib/prometheus

# The release asset name carries the version, so resolve it rather than
# guessing — GitHub's /latest/download path does not accept a wildcard.
VER=$(curl -fsSL https://api.github.com/repos/prometheus/prometheus/releases/latest \
        | grep -oP '"tag_name": "v\K[^"]+')
curl -fsSL "https://github.com/prometheus/prometheus/releases/download/v${VER}/prometheus-${VER}.linux-amd64.tar.gz" \
  | sudo tar -xz --strip-components=1 -C /usr/local/bin \
      "prometheus-${VER}.linux-amd64/prometheus" \
      "prometheus-${VER}.linux-amd64/promtool"

sudo chown -R prometheus:prometheus /var/lib/prometheus
```

`/etc/prometheus/prometheus.yml` — the repo's
`deployments/observability/prometheus/scrape-config.yaml` is Kubernetes service
discovery; on bare metal it is a static target:

```yaml
global:
  # 30s, not 15s. Nothing here is a fast-moving signal: the delivery histograms
  # aggregate over minutes and queue_depth is refreshed on its own ticker.
  # Halving the interval doubles storage for no new information.
  scrape_interval: 30s
  scrape_timeout: 10s

rule_files:
  - /etc/prometheus/alerts.yaml

scrape_configs:
  - job_name: hookubit-data-plane
    static_configs:
      - targets: ['app.lan:9090']
        labels:
          component: all      # `webhookd all`; split roles get one target each
```

Copy the alert rules from the repo as they are — they encode failure modes that
are not obvious from the metric names:

```bash
sudo cp deployments/observability/prometheus/alerts.yaml /etc/prometheus/
sudo promtool check rules /etc/prometheus/alerts.yaml
```

They include `WebhookOutboxLagHigh` (the router is not draining),
`WebhookQueueDepthNotExported` (the collector itself stopped, which no
throughput alert would catch), `WebhookRateLimiterDegraded` (Redis is gone and
limits are per-process) and `WebhookEgressBlockedMetadataAddress` — an endpoint
URL resolving to a cloud metadata address, which is someone probing for
credentials, not a misconfiguration.

`/etc/systemd/system/prometheus.service`:

```ini
[Unit]
Description=Prometheus
After=network-online.target
Wants=network-online.target

[Service]
User=prometheus
Group=prometheus
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus \
  --storage.tsdb.retention.time=90d \
  --web.listen-address=127.0.0.1:9091
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

::: warning Prometheus defaults to port 9090, and so does the data plane
If you run Prometheus on the **app** host, one of them will fail to bind. The
unit above moves Prometheus to `9091`. On a separate monitoring host the default
is fine — but the collision is worth knowing before you debug it.
:::

### Grafana

```bash
sudo apt install -y apt-transport-https software-properties-common
curl -fsSL https://apt.grafana.com/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/grafana.gpg
echo "deb [signed-by=/usr/share/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt update && sudo apt install -y grafana
sudo systemctl enable --now grafana-server
```

Add Prometheus as a data source, then import the shipped dashboard:

```
deployments/helm/hookubit/dashboards/hookubit.json
```

It lives under `deployments/helm/` but it is a plain Grafana dashboard, not a
Helm template — the `{{outcome}}`, `{{reason}}` and `{{state}}` you will see in
it are Grafana legend placeholders. **Dashboards → Import → Upload JSON** takes
it as-is.

Grafana listens on `:3000` by default — the same port as the control API. On the
app host, change `http_port` in `/etc/grafana/grafana.ini`. Better: keep Grafana
on the monitoring host and reach it over the LAN or an SSH tunnel. It is an
operator tool; it does not belong on the public internet with a default admin
password.

---

## 12. Create the first account

There is no default account, by design. Registration is closed by default; open
it, make your account, close it again:

```bash
echo 'ALLOW_OPEN_REGISTRATION=true' | sudo tee -a /etc/hookubit/hookubit.env
sudo systemctl restart hookubit-api
```

Register in the dashboard, follow the verification link SES delivers, then:

```bash
sudo sed -i 's/^ALLOW_OPEN_REGISTRATION=true/ALLOW_OPEN_REGISTRATION=false/' /etc/hookubit/hookubit.env
sudo systemctl restart hookubit-api
```

Everyone after you joins by invitation from the Team page. Leaving open
registration on means anyone who can reach the API creates an account and an
organization they own.

---

## 13. Backups

Two things, and the second is the one people miss.

```bash
# 1. The database — the system of record AND the queue.
pg_dump --format=custom "$DATABASE_URL" > hookubit-$(date +%F).dump

# 2. The encryption key. Separately, and not beside the dump.
grep ENCRYPTION_KEY /etc/hookubit/hookubit.env
```

Redis needs no backup: it holds rate-limiter buckets, which is why a Redis
outage costs limiter accuracy and not deliveries.

Point-in-time recovery matters more than snapshot frequency here. The delivery
ledger is the product's answer to "what happened to this event", and a nightly
snapshot throws away up to a day of that answer. On a dedicated database host,
turn on WAL archiving.

---

## 14. Upgrades

```bash
sudo systemctl stop hookubit-data-plane          # stop taking new work first
cd /opt/hookubit/src && sudo -u hookubit git pull

sudo -u hookubit pnpm install --frozen-lockfile
sudo -u hookubit pnpm generate
sudo -u hookubit pnpm --filter @hookubit/control-api build
cd services/data-plane && sudo -u hookubit go build -o /opt/hookubit/bin/webhookd ./cmd/webhookd

cd /opt/hookubit/src
VITE_API_TRANSPORT=http VITE_INGEST_BASE_URL=https://hooks.example.com \
  sudo -u hookubit pnpm --filter @hookubit/dashboard build
sudo rsync -a --delete apps/dashboard/dist/ /opt/hookubit/web/

cd apps/control-api && sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate deploy

sudo systemctl restart hookubit-api
sudo systemctl start hookubit-data-plane
```

Then **purge the Cloudflare cache** for `index.html`, or browsers keep the old
bundle and request asset filenames that no longer exist. If you set the cache
rules above, only `index.html` needs purging; if you did not, purge everything.

Stopping the data plane first means in-flight deliveries drain against the old
schema rather than mid-migration. Nothing is lost either way — the queue is
PostgreSQL and an unclaimed delivery is a delivery still waiting — but it keeps
the logs readable.

---

## Where Docker still earns its place

You asked for bare metal and bare metal is right for most of this. Three honest
exceptions, in order of how much pain they save:

**Grafana and Prometheus: yes, use Docker if you like.** They are not in the
delivery path, they are stateful only in ways that map cleanly to a volume, and
their upgrade story in containers is genuinely better than apt pinning. Nothing
breaks if they restart. If you want one place to be pragmatic, make it here.

**PostgreSQL and Redis: no.** You already have them on their own machines, which
is the better answer. Containerised databases are fine in principle and a
liability in practice on a single box: the failure modes that matter are disk,
fsync and memory, and a container adds a layer to every one of them without
removing any.

**The platform itself: no, and it costs you nothing.** The data plane is one
static Go binary and the control API is `node dist/main.js`. There is no runtime
to isolate and no dependency hell to escape. systemd gives you restart policy,
log capture, resource limits and ordering — the things a container runtime would
be providing — and `journalctl -u hookubit-data-plane` is a better debugging
experience than `docker logs` on a box you own.

The one real argument for containerising the platform is reproducible builds
across machines. If you reach several app hosts, revisit it — and at that point
read [Kubernetes manifests](/self-hosting/03-kubernetes-manifests) rather than
hand-rolling Compose across servers.

---

## Things that will bite you

**The dashboard silently using its mock.** Build without
`VITE_API_TRANSPORT=http` and every screen works, with data that does not exist.
If nothing you create in the dashboard reaches the database, this is why.

**The dashboard on a different hostname from the API.** Relative-path `fetch`
means the calls go to the CDN and 404. Same hostname, routed by path.

**Cloudflare in "Flexible" SSL mode.** Padlock in the browser, plain HTTP
between Cloudflare and your origin, session cookies and signing secrets in
clear text. Full (strict), always.

**Cloudflare caching `/v1/*`.** Bypass it explicitly. Do not rely on the default
behaviour staying what it is today.

**Proxy hops set for the wrong topology.** Cloudflare + nginx is 2. At 0 behind
proxies, the whole internet shares one per-IP rate-limit bucket. Too high, and a
client can spoof its address with a header.

**`client_max_body_size` below the payload ceiling.** nginx refuses first, and
the publisher gets HTML instead of the platform's JSON naming the limit.

**Prometheus and the data plane both wanting 9090.** Move one.

**Grafana and the control API both wanting 3000.** Move one.

**LAN consumers and the SSRF guard.** `EGRESS_PRIVATE_ALLOWLIST` with named
subnets, never `EGRESS_ALLOW_PRIVATE_NETWORKS`, which production refuses.

**SES still in sandbox.** Your own address works; your first real user's does
not.

**Splitting the data plane later.** Every `webhookd` process binds
`DATA_PLANE_METRICS_PORT` for its probes. Four roles as four units on one box
means three fail to bind. Give each its own:

```ini
Environment=DATA_PLANE_METRICS_PORT=9091
```

**Per-endpoint isolation is a ceiling, not a reservation.**
`MAX_CONCURRENCY_PER_ENDPOINT` (16) bounds one endpoint's in-flight attempts;
nothing reserves capacity for the others. Six slow endpoints at the default cap
are entitled to the whole 64-slot pool, and your fast endpoints queue behind
them. Lower the cap before you raise the pool.
