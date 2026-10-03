# Bare metal on Ubuntu

No Docker. systemd for the control API and the data plane, nginx in front of
them as a plain reverse proxy, and PostgreSQL and Redis on their own machines.
Mail goes to Amazon SES; Prometheus and Grafana watch the lot.

**This host does not serve the dashboard.** Cloudflare builds and publishes it
from the same repository on every push, and nothing on this page builds, copies
or serves a front-end bundle. This box answers two hostnames and no files: the
control API and ingest, each proxied to a local port.

Hostnames below are the ones `hookubit.com` itself uses. Substitute your own
domain — but keep the dashboard and the API **under one registrable domain**,
which is what the first constraint below is about.

Ubuntu 22.04 or 24.04 throughout, PostgreSQL 15 or newer. If you would rather
run containers, read [Docker Compose](/self-hosting/04-docker-compose) — and see
[Where Docker still earns its place](#where-docker-still-earns-its-place) at the
end, because the honest answer is "for two of these, yes".

## The shape

```
                    ┌──────────────────────────────────────────┐
  browser  ────────▶│ Cloudflare          hookubit.com         │
                    │  the dashboard's static assets, built    │
                    │  and published by Cloudflare on push     │
                    └───────────────────┬──────────────────────┘
                                        │ fetch https://api.hookubit.com/v1/*
                                        │ credentials: include — same-site
  publisher ─────────────────────────┐  │
  (hooks.hookubit.com)               ▼  ▼
                            ┌──────────────────────────┐
                            │ app host — nginx :443    │
                            │   proxies only; serves   │
                            │   no files at all        │
                            │  api.    → :3000  api    │
                            │  hooks.  → :8080  ingest │
                            │  probes :9090  localhost │
                            └────┬──────────────┬──────┘
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
| **Cloudflare** | the dashboard, and the proxy in front of this box | Operator access to the UI. The API and ingest keep working for anything that calls them directly. |

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

### 1. The dashboard and the API must share one registrable domain

The dashboard is served from `hookubit.com` and the control API from
`api.hookubit.com`. Different origins, so every call is cross-origin — and the
same **site**, which is the part that matters.

The session cookie is issued `HttpOnly; SameSite=Lax` with no `Domain`
(`apps/control-api/src/auth/session.service.ts`, asserted by a spec in every
environment). A `Lax` cookie is withheld from cross-**site** requests, not from
cross-origin ones, and "site" means the registrable domain: `hookubit.com` and
`api.hookubit.com` are one site, so the browser sends it. The dashboard asks it
to, with `credentials: 'include'`, against the base URL it is built with
(`VITE_API_BASE_URL`; `apps/dashboard/src/lib/api-base-url.ts`).

What does **not** work is a dashboard on a different registrable domain — a
`*.pages.dev` preview URL, or a separate brand domain. Sign-in succeeds, the
cookie is set and then never sent again, and every request after it is
anonymous. It looks like a broken session, not a broken deployment.

Two things the API side has to hold up, or none of this works. Both are one line
in `/etc/hookubit/hookubit.env` and both are covered in §9:

- the dashboard's origin is listed **exactly** in `CORS_ORIGINS`, which is
  configured with `credentials: true` and **fails closed** when unset;
- nginx passes `OPTIONS` through to the API, because a cross-origin dashboard
  preflights every write.

### 2. Ingest gets its own hostname

Publishing is server-to-server with a bearer token. It has a completely
different traffic shape from the dashboard, no cookies and no CORS, and you will
eventually want to rate-limit, cache and scale it separately. Give it
`hooks.hookubit.com`.

That hostname is **compiled into the dashboard bundle** as
`VITE_INGEST_BASE_URL`, so decide it before the dashboard is first built — and
set it where that build happens, which is Cloudflare's build environment, not
this host. The build settings are in `apps/dashboard/README.md` in the
repository.

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

`pg_isready` comes with `postgresql-client`, which the app host does not have
until step 3 installs it. If you are working through this in order, run the
`apt install` at the top of step 3 first, then come back for this one line.

::: warning Put a firewall in front of it anyway
`pg_hba.conf` is authentication, not network policy. `ufw allow from 10.0.0.20
to any port 5432` on the database host means a mistake in one file is not the
only thing between your ledger and the network.
:::

### Two URLs, and why

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | The database, through a pooler if you have one | Both planes, at runtime |
| `DIRECT_DATABASE_URL` | The server directly, never a pooler | The migration command, and `pg_dump` (step 13) |

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
sudo apt install -y build-essential git curl ca-certificates nginx \
  postgresql-client nftables jq
```

`postgresql-client` is not optional here even though PostgreSQL runs elsewhere:
the `pg_isready` check in step 1, the `pg_dump` in step 13 and the Deployer
recipe's migration guard all run on *this* host, against `db.lan` over the
network. `nftables` is the firewall in step 8 and `jq` reads the request log in
step 5; both are usually present already.

Node 22 and pnpm — the repo pins pnpm through `packageManager`, so let corepack
read it rather than installing a version by hand:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
```

Go — match the version CI builds against, not whatever `apt` has. The version
to use is `GO_VERSION` in `.github/workflows/ci.yml`; the repo is not cloned on
this host until step 4, so read it on GitHub (or in a checkout you already have
elsewhere) and substitute it into the URL below:

```bash
curl -fsSL https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
```

`go.mod` states a *minimum* language version, not a pin. The CI version is the
one that has actually been tested.

**Three lines because there are three different callers, and you need all
three.** The tarball puts `go` in `/usr/local/go/bin`, which is on nobody's
`PATH` by default.

- The symlink into `/usr/local/bin` is the one `sudo` can find. Ubuntu's
  sudoers sets `secure_path`, which **replaces** `PATH` for the target command;
  it lists `/usr/local/bin` and not `/usr/local/go/bin`, so `sudo -u hookubit go
  build …` fails with `go: command not found` no matter what your own shell can
  do.
- `/etc/profile.d/go.sh` is what gives *you* `go` interactively — next time you
  log in, since `/etc/profile.d/*` is read by login shells only.
- The builds in steps 4 and 14 call `/usr/local/go/bin/go` by absolute path
  anyway. `sudo -u hookubit -H bash` is a non-login shell: it reads
  `/etc/bash.bashrc` and `~/.bashrc` and never `/etc/profile` or
  `/etc/profile.d/*`, so nothing there has put Go on its `PATH`.

A system user with no shell:

```bash
sudo useradd --system --create-home --home-dir /opt/hookubit --shell /usr/sbin/nologin hookubit
sudo mkdir -p /opt/hookubit/{src,bin} /etc/hookubit
sudo chown -R hookubit:hookubit /opt/hookubit
```

Two directories, not three. There is no `web/`: nothing on this host serves
static files any more.

---

## 4. Build

Build as the service user so nothing in the tree ends up owned by root:

```bash
sudo -u hookubit -H bash
cd /opt/hookubit/src
git clone https://github.com/YOU/hookubit.git .    # or copy the tree across
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
/usr/local/go/bin/go build -o /opt/hookubit/bin/webhookd ./cmd/webhookd
```

One static binary. Nothing else to install. The absolute path to `go` is
deliberate: this is a non-login shell, so `/etc/profile.d/go.sh` from step 3 has
not run in it and bare `go` is `command not found` here.

### The dashboard

**Not here.** Cloudflare's git integration builds and publishes the dashboard
from this same repository on every push to the deployment branch. Nothing on
this host builds it, copies it or serves it, and the three values compiled into
the bundle — the transport, the control API's base URL and the ingest base URL —
are set in **Cloudflare's build environment**, documented in
`apps/dashboard/README.md` in the repository.

What that means for this page: the front end and the back end deploy on
different triggers. A push updates the dashboard. Step 14 updates this host.
Neither waits for the other, and §9 is where the two are wired together.

That is the last step that runs inside the `hookubit` shell. Leave it before
you go on: `hookubit` has `/usr/sbin/nologin` for a shell and is not in sudoers,
so every `sudo` from here on fails from in there, and the `systemd-run`
migration in step 6 cannot be run as `hookubit` at all.

```bash
exit
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

# The dashboard's origin, twice, for two different jobs. DASHBOARD_URL is the
# base of every link in every email; wrong here means mail full of dead links.
# CORS_ORIGINS is an exact-match list and FAILS CLOSED: unset, and sign-in
# itself fails. Both are the hostname Cloudflare serves the dashboard on, NOT
# this box's. See §9.
DASHBOARD_URL=https://hookubit.com
CORS_ORIGINS=https://hookubit.com

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

`TRUST_PROXY_HOPS` is an exact count, not a boolean, and it is how the per-IP
rate limiter finds the client. Set it too low and every request in the world
shares one bucket, because they all appear to come from your proxy. Set it too
high and a client picks its own address with an `X-Forwarded-For` header, which
is worse than no rate limiting, because it looks like there is some.

**For the topology on this page it is 2, for both planes.** Here is the
arithmetic, because this is a number to derive once rather than tune.

Express (and the Go ingest handler, identically) builds one list: the socket
address first, then the `X-Forwarded-For` entries read right to left. A count of
`n` trusts the `n` nearest entries and takes the client from the next one along.
On this box:

| # | Entry | Who wrote it |
|---|---|---|
| 0 | `127.0.0.1` | the kernel. nginx is the peer. |
| 1 | right-most `X-Forwarded-For` | nginx, from `$remote_addr` |
| 2 | next `X-Forwarded-For` | **Cloudflare**, from the connection it accepted |
| 3+ | anything further left | **the client**. Forgeable. |

So `2` lands on the entry Cloudflare wrote, which is the first one no client can
reach — Cloudflare *appends* to whatever `X-Forwarded-For` the client sent, it
does not replace it. Take Cloudflare out of the path later and the count is 1;
put a load balancer in front of Cloudflare and it is 3. Change the
`X-Forwarded-For` line in §8's nginx and recount, because that table is a
property of that line.

**Then confirm the derivation, from the request log.** Call the API from your
own machine and read the headers back:

```bash
curl -s https://api.hookubit.com/v1/auth/session -o /dev/null
sudo journalctl -u hookubit-api -n 20 -o cat \
  | jq -c 'select(.req) | {xff: .req.headers["x-forwarded-for"],
                           cf: .req.headers["cf-connecting-ip"],
                           socket: .req.remoteAddress}'
```

`cf` must be your own public address, and `xff` must end in it — twice, in fact,
once from Cloudflare and once from nginx, which is what a count of 2 is reading.
Repeat it with `-H 'X-Forwarded-For: 9.9.9.9'` and watch `9.9.9.9` appear on the
**left** of that list, where the count never reaches it.

::: warning What this check cannot tell you
`socket` is always `127.0.0.1`: `pino-std-serializers` fills `remoteAddress`
from the socket, never from `req.ip`, so the resolved client address — the one
the rate limiter actually buckets on — **does not appear in this log at all**.
The check above proves the *headers* are what the table says. It cannot detect
over-counting: set `TRUST_PROXY_HOPS=5` and every line of that output is
identical while every request quietly gets its own rate-limit bucket.

So do not tune this number until the output looks right. Derive it from the
topology, as above, and use the log only to confirm that the topology is the one
you think it is.
:::

And none of it means anything unless nginx is honest about the chain and only
Cloudflare can reach the port. Both are §8, and both are mandatory.

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
sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/etc/hookubit/hookubit.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate deploy

sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/etc/hookubit/hookubit.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate status
```

Do not simplify that to `env $(grep -v '^#' /etc/hookubit/hookubit.env)`: `$(…)`
word-splits on spaces, so `MAIL_FROM=HookuBit <no-reply@example.com>` arrives as
two arguments and `env` runs `<no-reply@example.com>` as the command, whereas
`systemd-run` reads the file with the very parser `EnvironmentFile=` uses in the
units in step 7 — so migration and services agree on every key, and the
migration connects with the `DIRECT_DATABASE_URL` from that same file.

Two migrations in the history invert the usual "apply ahead of the code" rule
and must be run with the data plane stopped. Both say so in capitals in their
own header — see
[Backup, restore and upgrades](/self-hosting/08-backup-restore-and-upgrades).

### Prove the exit status comes back

`--pipe --wait --collect` runs the unit in the foreground and returns *its* exit
status to your shell. Every `&&` in step 14 is built on that. Check it once per
host, now, while nothing depends on the answer:

```bash
sudo systemd-run --pipe --wait --collect /bin/false; echo $?   # must print 1
```

`1` means the status propagates and step 14's chains are real control flow. `0`
means this systemd is reporting on the *launch* rather than the command, every
`&&` on this page is decoration, and you must instead run each command on its
own and read its status — or put the sequence in a script beginning with
`set -euo pipefail`.

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

## 8. nginx, behind a firewall

**nginx on this box serves no files, and it has one job: two hostnames, two
local ports.**

| Hostname | Proxied to | What answers |
|---|---|---|
| `api.hookubit.com` | `127.0.0.1:3000` | the control API, `/v1/*` only |
| `hooks.hookubit.com` | `127.0.0.1:8080` | ingest |

No `root`, no `try_files`, no `/assets/` block and no SPA fallback. The
dashboard and its assets are Cloudflare's (§9), and a copy of the bundle here
would be a second thing to keep in step — a stale copy is indistinguishable
from a fresh one until a user finds it.

### Only Cloudflare may reach ports 80 and 443

Do this **before** the server blocks below, on every host, whether or not you
think anyone knows your address.

Proxying a DNS record hides your IP from `dig`. It does not close your ports.
`443` on this box is reachable from anywhere on the internet the moment nginx
starts, and the address is discoverable without your help. Historical DNS
archives keep whatever those names pointed at before you turned the orange cloud
on. Certificate transparency names every hostname you ever issue a
publicly-trusted certificate for, which tells an attacker what to look for. And
this platform's whole job is to make outbound connections: **every delivery to
every customer endpoint arrives from this box's address**, so anyone who
receives one of your webhooks already has it.

**That is not a theoretical exposure, because a direct connection switches the
per-IP rate limiter off.** With `TRUST_PROXY_HOPS=2` the control API takes the
client address from the third entry of the list `[socket address, X-Forwarded-For
right-to-left]` (`src/config/trust-proxy.ts`, and `proxy-addr` underneath it).
Through Cloudflare that entry is the one Cloudflare wrote, and a client cannot
reach it. Connecting **straight to this box**, the whole list is the attacker's:
`X-Forwarded-For: 1.2.3.4, 5.6.7.8` makes `req.ip` whatever they like, so
`ThrottleGuard`'s `name:ip:<ip>` bucket (`src/common/throttle.guard.ts`) is
fresh on every request and the limits on login and password reset — the two that
exist to make credential stuffing expensive — are simply gone.
`set_real_ip_from` cannot save you here: the connection really is from outside
Cloudflare, so there is nothing to rewrite.

One script, run now and on a timer, because Cloudflare's ranges change. It
writes the packet filter and the `set_real_ip_from` list from the same fetch, so
the two can never disagree:

```bash
sudo install -d /etc/nftables.d
sudo tee /usr/local/sbin/hookubit-cloudflare-ranges >/dev/null <<'EOF'
#!/bin/bash
# Ports 80 and 443: Cloudflare only. Plus the list nginx trusts to set
# CF-Connecting-IP. One fetch, two consumers, applied atomically.
set -euo pipefail
v4=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)
# `|| true` because grep -c exits 1 on a count of zero, and with `set -e` that
# would kill the script before the message below could say why.
n=$(printf '%s\n%s\n' "$v4" "$v6" | grep -cE '^[0-9a-fA-F.:]+/[0-9]{1,3}$' || true)
[ "$n" -ge 20 ] || { echo "got $n CIDRs, expected 20+; leaving everything as it is" >&2; exit 1; }

# One `nft -f` is one transaction: the old table is replaced, never absent.
{ echo 'table inet hookubit { }'
  echo 'delete table inet hookubit'
  echo 'table inet hookubit {'
  echo "  set cf4 { type ipv4_addr; flags interval; elements = { $(printf '%s\n' "$v4" | paste -sd, -) } }"
  echo "  set cf6 { type ipv6_addr; flags interval; elements = { $(printf '%s\n' "$v6" | paste -sd, -) } }"
  echo '  chain input {'
  echo '    type filter hook input priority -10; policy accept;'
  echo '    iif lo accept'
  echo '    tcp dport { 80, 443 } ip  saddr @cf4 accept'
  echo '    tcp dport { 80, 443 } ip6 saddr @cf6 accept'
  echo '    tcp dport { 80, 443 } drop'
  echo '  }'
  echo '}'
} > /etc/nftables.d/hookubit-cloudflare.nft
nft -f /etc/nftables.d/hookubit-cloudflare.nft

{ echo 'real_ip_header CF-Connecting-IP;'
  printf 'set_real_ip_from %s;\n' $v4 $v6
} > /etc/nginx/conf.d/cloudflare-real-ip.conf
nginx -t && systemctl reload nginx
EOF
sudo chmod 0755 /usr/local/sbin/hookubit-cloudflare-ranges
sudo hookubit-cloudflare-ranges
```

Make it survive a reboot, and re-run weekly:

```bash
grep -q nftables.d /etc/nftables.conf \
  || echo 'include "/etc/nftables.d/*.nft";' | sudo tee -a /etc/nftables.conf
sudo systemctl enable --now nftables

echo '17 4 * * 0 root /usr/local/sbin/hookubit-cloudflare-ranges' \
  | sudo tee /etc/cron.d/hookubit-cloudflare-ranges
```

A cron entry rather than `systemd-run --on-calendar`, which creates a
*transient* timer and loses it on the next reboot. Cron also mails root the
output, which is where you want the "got 0 CIDRs" line to end up.

Four details in that script, each of which is the difference between a firewall
and a lockout.

**It refuses to apply a list that does not look like one.** `curl -fsS` fails
loudly on a 5xx, but a captive portal or a proxy can return a cheerful HTML
page with a `200`. Counting CIDR-shaped lines first means a bad fetch leaves
yesterday's working rules in place instead of installing a table that matches
nothing and drops all your traffic.

**One `nft -f`, one transaction.** Create-if-absent, delete, redefine — all in
one file, so the ruleset is never momentarily empty. Run as three commands there
is a window in which the box is open, and that window is when you are looking
somewhere else.

**Its own table, at priority `-10`.** It does not fight ufw or anything else:
packets traverse every base chain for the hook, a `drop` here is final, and an
`accept` here does not bypass another table's rules. Leave `policy accept` —
this table is not your whole firewall, only the rule about these two ports. The
`iif lo accept` is there so `curl http://localhost` from the box itself still
works; without it your own debugging hangs along with the attacker's.

**Every public hostname must stay proxied after this.** Set `hooks` to DNS-only
and your publishers are dropped at the packet filter with no error anywhere in
nginx's logs. §9's DNS table says proxied for exactly this reason.

::: tip Checking it from off-box
`curl -sv --resolve api.hookubit.com:443:<your-ip> https://api.hookubit.com/v1/auth/session`
from anywhere that is not Cloudflare should now hang and time out. Through the
normal DNS name it should answer `401`. If the first one answers, the table did
not load — `sudo nft list table inet hookubit`.
:::

### TLS: a Cloudflare Origin CA certificate

Issue one in the Cloudflare dashboard (SSL/TLS → Origin Server → Create
Certificate), fifteen years, free, covering `hookubit.com` and `*.hookubit.com`.
Install the certificate and key as `/etc/ssl/cloudflare/origin.pem` and
`origin.key`, `0600`, root-owned.

::: danger Not Let's Encrypt, and not an HTTP-01 challenge
An `http-01` challenge — `certbot --nginx`, or any webroot — cannot work against
the configuration below. The challenge arrives as
`/.well-known/acme-challenge/<token>` on a hostname whose only `location` is
`/v1/`, so it lands on `return 404` and issuance fails. That is survivable the
first time, because you find out immediately. What is not survivable is the
**renewal** 60 days later: it fails the same way, silently, in a timer whose
output nobody reads, and when the certificate expires Cloudflare starts
answering **`526` on every API call** while the dashboard's assets keep loading
perfectly from Cloudflare's own edge. It looks exactly like an API outage.

If you want a publicly-trusted certificate anyway, use **DNS-01** (`certbot
--dns-cloudflare`), which never touches this nginx. Do not open a
`/.well-known/` hole in the API hostname just to make `http-01` work: the port
is Cloudflare-only now, so the challenge would have to come through the proxy
anyway, and you would be maintaining an unauthenticated path on the API
hostname for the benefit of one request every two months.
:::

### `/etc/nginx/sites-available/hookubit`

```nginx
# ── The control API. /v1/* and nothing else.
server {
    listen 443 ssl http2;
    server_name api.hookubit.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    location /v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long enough for a slow report, short enough to free the worker.
        proxy_read_timeout 60s;
    }

    # /health/live is NOT published: it is probed on localhost (§7, and the
    # Deployer recipe). Published, it is an unauthenticated oracle on your
    # database's state.
    location / {
        return 404;
    }
}

# ── Ingest: its own hostname, its own limits.
server {
    listen 443 ssl http2;
    server_name hooks.hookubit.com;

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
    listen 80;
    server_name api.hookubit.com hooks.hookubit.com;
    return 301 https://$host$request_uri;
}
```

```bash
# Ubuntu ships an enabled site that claims `default_server` on port 80. Leave it
# and `nginx -t` fails with "a duplicate default server for 0.0.0.0:80" the
# moment any other block claims the same thing — and while it is enabled it is
# the default server for every hostname you have not named, answering the Ubuntu
# welcome page to anything that reaches this box on a name you did not expect.
sudo rm -f /etc/nginx/sites-enabled/default

sudo ln -s /etc/nginx/sites-available/hookubit /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Four things about that file.

**`location /v1/` proxies every method, `OPTIONS` included, and it must.** The
dashboard is on a different origin now, so every `PATCH`, every `DELETE` and
every `Content-Type: application/json` request is preceded by a CORS preflight.
Nest answers `OPTIONS` correctly — but only if it sees it. An nginx block that
handles `OPTIONS` itself, or a `limit_except GET POST` that returns `405`,
breaks every mutation in the dashboard while reads keep working perfectly, which
is a miserable thing to debug. Do not add one.

**Nothing but `/v1/` is answered on the API hostname.** `/health/*` is excluded
from the API's global prefix precisely so it can be probed on localhost, and
publishing it hands the internet a readout of your database's reachability. The
`404` is deliberate, and there is no SPA fallback: nothing here serves HTML.

**`client_max_body_size 2m` must stay above `PAYLOAD_MAX_BYTES`** (1 MiB by
default). If nginx refuses first, the publisher gets an nginx HTML error page
instead of the platform's JSON naming the limit it hit. Raise this whenever you
raise that.

**`listen 443 ssl http2;` is the right spelling for Ubuntu 22.04 and 24.04**
(nginx 1.18 and 1.24). On nginx 1.25 or newer it warns, and the replacement is
`listen 443 ssl;` plus a separate `http2 on;`.

And what stays unexposed: `9090` is probes and metrics and never goes through
nginx. Prometheus reaches it over the private network or an SSH tunnel.

---

## 9. Cloudflare

Four names on one registrable domain. Only two of them are this box.

| Name | Who answers it | Where it is configured |
|---|---|---|
| `hookubit.com` | **Cloudflare.** The dashboard's static assets, built and published by Cloudflare's own git integration on every push to the deployment branch | Cloudflare, plus `apps/dashboard/` in the repository |
| `sysadmin.hookubit.com` | nothing yet — a planned internal admin dashboard | n/a. Do not create the record until something serves it |
| `api.hookubit.com` | nginx on the app host → `127.0.0.1:3000` | §8 |
| `hooks.hookubit.com` | nginx on the app host → `127.0.0.1:8080` | §8 |

**Nothing on this page deploys the dashboard, and `make deploy` does not either.**
Cloudflare is connected to the repository and builds it when you push; there is
no GitHub Actions workflow for it and no front-end step on this host. Its three
build variables — the transport, the API base URL and the ingest base URL — are
documented in `apps/dashboard/README.md` in the repository, which is the one
place they are written down. The API base URL is the only wiring between the two
halves: the dashboard fetches `https://api.hookubit.com/v1/...` with
`credentials: 'include'`, and a production build with that variable unset
refuses to boot rather than quietly fetching relative paths and parsing
`index.html` as JSON.

So the two halves deploy on different triggers. A push updates the dashboard.
§14 updates this host. Neither waits for the other.

### The API needs to be told about the dashboard

Two variables in `/etc/hookubit/hookubit.env`, both on the **app host**, and the
platform is unusable until they are right:

```bash
CORS_ORIGINS=https://hookubit.com
DASHBOARD_URL=https://hookubit.com
```

When `sysadmin.hookubit.com` exists it will be a third origin on that same
comma-separated list. Until something serves it, there is nothing to add.

::: danger CORS_ORIGINS unset is a dead platform, not a degraded one
It is an exact-string list, split on commas, and it **fails closed**: unset or
blank means `origin: false`, which blocks every cross-origin request at the
preflight. The cookie is never sent, so **sign-in itself fails** and every
screen is empty. The symptom is "nothing works at all", which sends people
looking at the dashboard; the cause is one missing line on this box.

Scheme and host, no path and no trailing slash. `https://hookubit.com` does
**not** cover `https://www.hookubit.com` — if the dashboard answers on both,
list both, comma-separated. `DASHBOARD_URL` is separate and is the base of every
link in outbound mail; wrong there means verification mail full of dead links.
:::

### DNS

Two records for this box, both **proxied** (orange cloud), both pointing at the
app host's public IP:

| Name | Type | Proxy |
|---|---|---|
| `api` | A (and AAAA if you have one) | **Proxied** |
| `hooks` | A (and AAAA if you have one) | **Proxied** |

`hookubit.com` itself is a Workers/Pages custom domain and Cloudflare manages
its record; you do not point it at this host.

**Proxied is not optional any more.** §8's packet filter accepts `80` and `443`
from Cloudflare's ranges and drops everything else, so a record set to DNS-only
is a record whose traffic never arrives — and nginx logs nothing, because
nothing reached it. Proxied also keeps `CF-Connecting-IP` in the path, which is
what makes `TRUST_PROXY_HOPS=2` and the per-IP limits mean anything.

### TLS

**SSL/TLS mode must be Full (strict).** "Flexible" makes Cloudflare talk plain
HTTP to your origin, so every session cookie and every signing secret you read
in the dashboard crosses the internet in clear text while the browser shows a
padlock. Full (strict) also means the origin certificate has to be real, which
is what the Origin CA certificate in §8 is for. A self-signed one is refused and
the symptom is a Cloudflare `526` on every API call — the same symptom as an
expired certificate, and the reason §8 does not offer `http-01`.

Turn on **Always Use HTTPS** while you are there. The `listen 80` block in §8 is
then a formality.

### Cache rules

| Path | Rule |
|---|---|
| `api.hookubit.com/*` | **Bypass cache** |
| `hooks.hookubit.com/*` | **Bypass cache** |
| `hookubit.com/*` | leave to the dashboard's own asset handling |

A cached `POST /v1/...` is not possible, but a cached `GET /v1/projects` served
to the wrong tenant absolutely is. Bypass both API hostnames explicitly rather
than relying on Cloudflare's default behaviour staying what it is today.

**Do not enable Rocket Loader, Auto Minify or Email Obfuscation** on
`hookubit.com`. They rewrite JavaScript and HTML; the bundle is already minified
and content-hashed, so the only thing they can do here is break it in ways that
reproduce on nobody's laptop.

**Leave `hooks.hookubit.com` alone** apart from proxying. No caching, no
transformations. It takes signed `POST` bodies and the signature covers the exact
bytes — anything that rewrites a request body makes every delivery fail
verification.

There is nothing to purge after a server deploy. The dashboard's assets are
content-hashed and published by Cloudflare when you pushed; `make deploy` does
not touch them.

### Checking it

From anywhere, including the app host:

```bash
# The API answers through Cloudflare, with its own JSON, not an HTML page.
curl -si https://api.hookubit.com/v1/auth/session | head -20

# The preflight the dashboard sends before every write.
curl -si -X OPTIONS https://api.hookubit.com/v1/projects \
  -H 'Origin: https://hookubit.com' \
  -H 'Access-Control-Request-Method: PATCH' | head -20
```

The first must be `401` with `"code":"unauthenticated"` in the body. HTML, or a
Cloudflare error page, means the record, the cache rule or the firewall is wrong
— and `526` specifically means the origin certificate.

The second must be `204` (or `200`) with
`access-control-allow-origin: https://hookubit.com` and
`access-control-allow-credentials: true`. Anything else — no header at all, or
`403`, or `405` — is `CORS_ORIGINS` on this box, or an nginx block that stopped
`OPTIONS` before it reached Nest. Every write in the dashboard fails while reads
keep working, so this is worth one `curl` on every install.

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

They include `WebhookOutboxLagHigh` (the oldest unrouted event is getting old —
the router is not draining), `WebhookQueueBacklogGrowing` (ready deliveries
piling up and still climbing, which is the pair to the lag alert and the one
step 14 watches after an upgrade), `WebhookQueueDepthNotExported` (the collector
itself stopped, which no throughput alert would catch — and with it firing the
backlog alert cannot fire at all, so read it as no signal rather than a clear
one), `WebhookRateLimiterDegraded` (Redis is gone and limits are per-process)
and `WebhookEgressBlockedMetadataAddress` — an endpoint URL resolving to a cloud
metadata address, which is someone probing for credentials, not a
misconfiguration.

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

Register at `https://hookubit.com`, follow the verification link SES delivers,
then:

```bash
sudo sed -i 's/^ALLOW_OPEN_REGISTRATION=true/ALLOW_OPEN_REGISTRATION=false/' /etc/hookubit/hookubit.env
sudo systemctl restart hookubit-api
```

Everyone after you joins by invitation from the Team page. Leaving open
registration on means anyone who can reach the API creates an account and an
organization they own.

If the registration form submits and nothing happens, read the browser console
before you read the API's log: a CORS failure at the preflight looks exactly
like a dead form, and `CORS_ORIGINS` (§9) is the usual cause on a first install.

---

## 13. Backups

Two things, and the second is the one people miss. Both run as root on the
**app host** — that is where `/etc/hookubit/hookubit.env` is. Nothing sets
`DIRECT_DATABASE_URL` in your shell, so read it out of that file; `pg_dump` then
connects over the network to the database host. Dumps land in
`/var/backups/hookubit`, root-owned and `0700`, so nothing depends on which
directory you happened to be standing in.

```bash
# 1. The database — the system of record AND the queue.
sudo install -d -m 0700 /var/backups/hookubit

URL=$(sudo sed -n 's/^DIRECT_DATABASE_URL=//p' /etc/hookubit/hookubit.env \
        | tail -n1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
OUT=/var/backups/hookubit/hookubit-$(date +%F).dump

sudo pg_dump --format=custom -f "$OUT" "${URL%%\?*}" \
  || { echo 'DUMP FAILED — no backup taken'; sudo rm -f "$OUT"; false; }

# 2. The encryption key. Separately, and not beside the dump.
sudo grep ENCRYPTION_KEY /etc/hookubit/hookubit.env
```

Four details in that one command, each of them the difference between a backup
and a file that looks like one.

**`${URL%%\?*}` cuts the query string off, and it has to.** The URLs in the env
file end in `?schema=public` because Prisma requires it; libpq rejects any URI
query parameter it does not recognise, so the unstripped URL gets you
`pg_dump: error: invalid URI query parameter: "schema"` and nothing else. Strip
it here rather than keeping a second, dumper-only copy of the URL in the env
file — and do not "fix" this by deleting `?schema=public` from the env file,
which breaks Prisma. With no query string the expansion is a no-op, so the form
is safe either way.

**`-f`, not `>`.** The shell creates a redirect's target *before* `pg_dump`
runs, so `> file` leaves a zero-byte file behind on every failure — and `-f`
does too when the connection is refused. That is what the `||` branch is for: it
says out loud that there is no backup, deletes the thing that would otherwise
look like one, and ends on `false` so that `$?` is non-zero for anything
wrapping this in a script or a cron job. Without it, an operator who checks `ls`
rather than `$?` — or a wrapper that checks neither — finds out during the
restore.

**`DIRECT_DATABASE_URL`, not `DATABASE_URL`.** `pg_dump` holds one session for
its whole repeatable-read snapshot, which a pooler in transaction mode will not
give it. With no pooler the two variables hold the same string (step 1), so
reading the direct one is right in both topologies and needs no decision at
backup time. Left to a bare `"$DIRECT_DATABASE_URL"` that nothing ever set,
`pg_dump` expands it to an empty string, falls back to a local socket and a
database named after `$USER` — and there is no PostgreSQL on the app host at
all.

**The `sed` pipeline is doing more than it looks.** `tail -n1` takes the last
definition of the key, which is what systemd's `EnvironmentFile=` parser does
too — and step 12 teaches you to `tee -a` this very file, so a duplicate key is
not hypothetical; without it you get both values joined by a newline in one
argument. `tr -d '\r'` drops the carriage return a file edited on Windows leaves
*inside* the URL. The last `sed` removes one layer of surrounding quotes,
because systemd strips those and `sed` does not: left in, they become part of
the dbname. Each of those failures is an error rather than a wrong dump, which
is only good news because the `||` branch now cleans up after it.

Redis needs no backup: it holds rate-limiter buckets, which is why a Redis
outage costs limiter accuracy and not deliveries.

Point-in-time recovery matters more than snapshot frequency here. The delivery
ledger is the product's answer to "what happened to this event", and a nightly
snapshot throws away up to a day of that answer. On a dedicated database host,
turn on WAL archiving.

---

## 14. Upgrades

Five blocks, in this order. The `&&` chains inside them are load-bearing —
they are what keeps a failed step from being followed by the next one, and step
6's self-test is what proves the status actually comes back. The blocks are
deliberately separate, so each one is a checkpoint you read before running the
next.

**Run one block at a time, and read its output before the next.** Do not paste
them in together. If the build chain stops anywhere, **do not run the migration
block** — see the danger note below for why that specific combination is the
worst outcome on this page. If you wrap this in a script, open the script with
`set -euo pipefail` so the boundaries between the blocks are enforced too.

Stop taking new work first:

```bash
sudo systemctl stop hookubit-data-plane
```

Then build. Every step needs the one above it to have succeeded, so the chain
stops at the first failure — and it stops before anything has touched the
schema. The data plane is down at that point: start it again and you are back
where you began, on the old release.

```bash
cd /opt/hookubit/src \
  && sudo -u hookubit git pull \
  && sudo -u hookubit pnpm install --frozen-lockfile \
  && sudo -u hookubit pnpm generate \
  && sudo -u hookubit pnpm --filter @hookubit/control-api build \
  && ( cd services/data-plane \
       && sudo -u hookubit /usr/local/go/bin/go build \
            -o /opt/hookubit/bin/webhookd ./cmd/webhookd ) \
  && ls -l /opt/hookubit/bin/webhookd
```

::: tip The dashboard is not in that chain, and it is not in this block
Nothing here builds, copies or publishes the front end. Cloudflare built and
published it the moment you pushed (§9, and `apps/dashboard/README.md` in the
repository), on its own trigger and its own timeline. **You have not
half-upgraded.** If a dashboard change is not live, the answer is in
Cloudflare's deployment log for that push; if an API change is not live, it is
in this block.
:::

Two details in that chain are easy to get wrong and silent when you do.

**`/usr/local/go/bin/go`, not `go`.** `sudo` applies `secure_path` to the
target command, replacing `PATH` with a list that has `/usr/local/bin` on it and
`/usr/local/go/bin` not — so `sudo -u hookubit go build` is `command not found`
even on a host where `go` works perfectly in your own shell. Step 3's symlink
covers the same ground; the absolute path here is immune to `secure_path`
differing between releases.

**`ls -l` is the last link on purpose.** Every command before it is silent on
success, `go build` included, so after a long noisy build "the chain stopped at
the Go build" and "the chain finished" would otherwise look identical — and the
next thing you would do is run the migration block over a `webhookd` from the
previous release, which is the exact failure the danger note below describes.
The `ls` is read-only, it cannot pass when `go build` did not produce the
binary, and the **mtime it prints is the fact the next block depends on**: look
at it and confirm it is seconds old, not weeks.

The `( cd services/data-plane && … )` subshell stays a subshell even though
nothing follows it now. It costs nothing and it means a link added after it
still runs from `/opt/hookubit/src`.

Then migrate, check, and only then restart — as one chain, so the restarts
cannot happen without the migration having succeeded:

```bash
sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/etc/hookubit/hookubit.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate deploy \
  && sudo systemd-run --pipe --wait --collect \
    --uid=hookubit --gid=hookubit \
    --property=EnvironmentFile=/etc/hookubit/hookubit.env \
    --working-directory=/opt/hookubit/src/apps/control-api \
    pnpm exec prisma migrate status \
  && sudo systemctl restart hookubit-api \
  && sudo systemctl start hookubit-data-plane
```

::: danger A new schema over old binaries is silent non-delivery, not a failed upgrade
Two routes into the same state. In both of them the platform looks alive, ingest
keeps answering `202`, and nothing comes out.

**The build chain stopped and the migration block ran anyway.** This is what
pasting the blocks in together does to you. `pnpm install` failing on
lockfile drift is an ordinary failure and the chain handles it correctly — but
`go build` never ran, and it does not overwrite `/opt/hookubit/bin/webhookd` on
failure, so the binary on disk is still the old release. Apply the new
migrations over it — `20260923000000_rename_fan_out_to_routing` among them — and
`systemctl start hookubit-data-plane` runs the pre-rename router against a
post-rename schema: it stops draining the outbox while ingest carries on
accepting events. **If the build chain stops anywhere, do not run the migration
block.** Nothing has touched the schema at that point: start the data plane
again and you are back on the old release, which is the entire reason these
blocks are separate.

**`migrate deploy` exited non-zero and you restarted anyway.** That is what the
`&&` is for, and it is the same rule the Deployer recipe follows. The live
release is old code, the schema may already have moved, and starting the data
plane there **would look like recovery and deliver nothing**. Fix the cause and
re-run the command; `prisma migrate deploy` is idempotent. It fails for ordinary
reasons: a `P3009` left behind by an earlier failed migration, an advisory-lock
timeout, or a `DIRECT_DATABASE_URL` pointed at a pooler — the thing the two-URL
table in step 1 warns about.
:::

The `migrate status` in the middle is step 6's command again, it is read-only,
and it is there so the applied list is in front of you before new code starts.
Read it for what it proves. It answers "did my migrations apply", not "has the
schema drifted": when the migrations on disk are a strict *prefix* of what the
database has applied, it still prints `Database schema is up to date!` and exits
0.

Then prove the release actually delivers. `systemctl start` returns 0 the moment
the unit is *running*, which is a long way from working, so the fourth block is
step 7's three checks again — all on localhost, because that is where the
probes live:

```bash
curl -s localhost:3000/health/live      # control API
curl -s localhost:9090/health/ready     # data plane, including its database ping
curl -s localhost:9090/metrics | head   # Prometheus exposition
```

Then leave the alerts from step 11 in front of you for a few minutes:
**`WebhookOutboxLagHigh`** (the oldest unrouted event is getting old — the
router is not draining) and **`WebhookQueueBacklogGrowing`** (ready deliveries
piling up and still climbing). A `webhookd` that binds its ports and reports
`ready` while the router never drains is precisely the failure this page exists
to prevent: a `DIRECT_DATABASE_URL` pointed somewhere wrong, or the strict-prefix
case above, leaves a healthy-looking process in front of a growing outbox. If
**`WebhookQueueDepthNotExported`** is firing, the backlog alert cannot fire at
all — read that as no signal rather than a clear one.

Finally, prove the public hostname still reaches what you just restarted, and
that the dashboard's preflight still gets through:

```bash
curl -si https://api.hookubit.com/v1/auth/session | head -20

curl -si -X OPTIONS https://api.hookubit.com/v1/projects \
  -H 'Origin: https://hookubit.com' \
  -H 'Access-Control-Request-Method: PATCH' | head -20
```

The first must be `401` with `"code":"unauthenticated"`: that is this API
answering through Cloudflare. HTML, or a Cloudflare error page, means the path
from the edge is broken rather than the services — `526` is the origin
certificate, `522`/`523` is the firewall or the DNS record.

The second must carry `access-control-allow-origin: https://hookubit.com`. It is
here because it fails *separately*: `CORS_ORIGINS` is read at API start, so a
restart onto an env file someone edited takes every write in the dashboard down
while reads keep working and all three localhost probes stay green.

There is **nothing to purge** at the edge. The dashboard's assets are
content-hashed and published by Cloudflare when you pushed, not by this block;
this block never touched them.

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

**`CORS_ORIGINS` unset or spelled differently from the dashboard's origin.** The
single most likely first-install failure. It fails closed, so the preflight
blocks everything, the cookie is never sent and **sign-in itself fails** — a
dashboard that looks completely dead while both services on this box are
healthy and every localhost probe is green. Exact string, scheme and host, no
trailing slash, and `www.` is a second origin. §9 has the `curl -X OPTIONS` that
catches it.

**nginx handling `OPTIONS` itself.** Add a `limit_except`, or an `if` that
returns early on `OPTIONS`, and every write in the dashboard fails while reads
keep working. Let the preflight reach Nest.

**Ports 80 and 443 open to the whole internet.** The orange cloud hides your
address; it does not close the port, and anyone who connects directly chooses
their own `X-Forwarded-For` — which makes `TRUST_PROXY_HOPS=2` hand them a
fresh per-IP bucket on every request. §8's packet filter is not optional.

**A DNS record set to DNS-only after that firewall is in place.** Its traffic is
dropped before nginx sees it, so there is nothing in any log. Proxied, always.

**Let's Encrypt with an `http-01` challenge.** It cannot work against an API
hostname whose only location is `/v1/`, and the renewal fails silently 60 days
later: Cloudflare then answers `526` on every API call while the dashboard's
assets keep loading perfectly. Origin CA, or DNS-01.

**The dashboard silently using its mock.** Built without
`VITE_API_TRANSPORT=http` and every screen works, with data that does not exist.
If nothing you create in the dashboard reaches the database, this is why — and
that variable lives in Cloudflare's build environment, so that is where to look.
See `apps/dashboard/README.md` in the repository.

**The dashboard on a different registrable domain from the API.** A `*.pages.dev`
URL or a second brand domain is cross-*site*, so the `SameSite=Lax` session
cookie stops being sent: sign-in succeeds and every request after it is
anonymous. Subdomains of one domain are fine; that is the design.

**nginx still serving files.** If this host was set up when the dashboard was
served from here, it has a `root` and a `try_files` fallback answering `/` out of
a stale bundle. Take them out: `/v1/*` proxied, everything else `404`.

**Cloudflare in "Flexible" SSL mode.** Padlock in the browser, plain HTTP
between Cloudflare and your origin, session cookies and signing secrets in
clear text. Full (strict), always.

**Cloudflare caching `/v1/*`.** Bypass it explicitly. Do not rely on the default
behaviour staying what it is today.

**Proxy hops set for the wrong topology.** Cloudflare + nginx is 2. At 0 behind
proxies, the whole internet shares one per-IP rate-limit bucket. Too high, and a
client can spoof its address with a header — and nothing in the request log
changes when you get it wrong in that direction. Derive it (§5), do not tune it.

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
