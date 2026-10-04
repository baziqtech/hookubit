# Bare metal on Ubuntu

No Docker. systemd for the control API and the data plane, nginx in front of
them as a plain reverse proxy, and PostgreSQL and Redis on their own machines.
Mail goes to Amazon SES; Prometheus and Grafana watch the lot.

**This host serves everything.** The dashboard is built into the release and
nginx serves it off that release, on the same hostname that proxies the control
API. One box, one deploy, two hostnames. Nothing is hosted anywhere else.

Hostnames below are the ones `hookubit.com` itself uses. Substitute your own
domain — but keep the dashboard and the API on **one hostname**, which is what
the first constraint below is about.

::: tip This page builds ONE box. Run it once per environment.
Everything below describes a single machine. If you want a staging or dev
environment as well as production, **run this whole page again on a second
box** — do not try to put two installs on one machine. The second copy differs
in exactly five values, and in nothing else:

| | the dev box | the prod box |
|---|---|---|
| its address | its own hostname / IP | its own hostname / IP |
| the git ref it deploys | `dev` | `main` |
| the deploy SSH user | its own | its own |
| the dashboard + API hostname | `dev.hookubit.com` | `hookubit.com` |
| the ingest hostname | `hooks.dev.hookubit.com` | `hooks.hookubit.com` |

The ports (`3000`, `8080`, `9090`), the unit names (`hookubit-api`,
`hookubit-data-plane`), the service user, the install path and every command on
this page are **the same on both**, because each box is alone on its machine.
Resist adding `-dev` suffixes or port offsets: that complexity only buys you two
installs on one host, which this page does not do.

What each box must *not* share with the other: its PostgreSQL database, its
Redis, its three env files, and above all its **`ENCRYPTION_KEY`** — a dev box
that can decrypt production's endpoint signing secrets is a production secret
with a dev box's security.

The Deployer recipe automates both from one inventory: `dev` and `prod` in
`deployments/deployer/hosts.yml`, each pinned to its branch, each named
explicitly at deploy time. See
[deployments/deployer/README.md](https://github.com/baziqtech/hookubit/blob/main/deployments/deployer/README.md).
:::

Ubuntu 22.04 or 24.04 throughout, PostgreSQL 15 or newer. If you would rather
run containers, read [Docker Compose](/self-hosting/04-docker-compose) — and see
[Where Docker still earns its place](#where-docker-still-earns-its-place) at the
end, because the honest answer is "for two of these, yes".

## The shape

```
  browser ──────────┐          publisher ──────────┐
  hookubit.com      │          hooks.hookubit.com  │
                    ▼                              ▼
         ┌───────────────────────────────────────────────────┐
         │ Cloudflare — proxy only. TLS, caching, DDoS.      │
         │ It hosts nothing.                                 │
         └──────────┬────────────────────────────┬───────────┘
                    │                            │
                    ▼                            ▼
         ┌─────────────────────────────────────────────────────┐
         │ app host — nginx :443                               │
         │                                                     │
         │  hookubit.com        ONE ORIGIN, two handlers:      │
         │    /v1/*     ──────────────────▶ :3000  control API │
         │    everything else ───▶ current/apps/dashboard/dist │
         │                         (SPA, try_files fallback)   │
         │                                                     │
         │  hooks.hookubit.com  ─────────▶ :8080  ingest       │
         │                                                     │
         │  probes :9090  localhost only, never published      │
         └──────┬─────────────────────────────────┬────────────┘
                │                                 │
    ┌───────────▼────┐                     ┌──────▼─────────┐
    │ db.lan:5432    │                     │ cache.lan:6379 │
    │ PostgreSQL     │                     │ Redis          │
    │ system of      │                     │ rate-limiter   │
    │ record + queue │                     │ buckets only   │
    └────────────────┘                     └────────────────┘
```

| Host | Runs | Loses what, if it dies |
|---|---|---|
| **app** | nginx, `hookubit-api`, `hookubit-data-plane`, **and the dashboard's files** | Time, plus the operator UI. Queued deliveries resume from PostgreSQL. |
| **db** | PostgreSQL 15+ | **Everything.** System of record *and* the delivery queue. |
| **cache** | Redis | Rate-limiter accuracy. Not deliveries. |
| **monitoring** | Prometheus, Grafana | Visibility. Nothing operational. |
| **Cloudflare** | **the proxy in front of this box — nothing else.** TLS termination at the edge, caching, DDoS absorption | Public reachability of all three paths: §8's packet filter accepts `443` from Cloudflare's ranges only, so nothing gets in around it. |

The dashboard is `apps/dashboard/dist` inside the live release, served by nginx
as the document root for `hookubit.com`. It is built by the deploy, it swaps with
the `current` symlink, and it rolls back with it — the same lifecycle as
`dist/main.js` and `bin/webhookd`, not a separate one.

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

### 1. The dashboard and the API are one origin

`hookubit.com` serves the dashboard's files **and** proxies `/v1/*` to the
control API. Same scheme, same host, same port: one origin, and almost
everything that used to be a decision follows from that for free.

- **Relative paths are correct by construction.** `src/lib/api.ts` calls
  `fetch('/v1/projects')`, which resolves against whatever hostname served the
  page. There is nothing to configure, nothing to keep in sync, and nothing that
  can be set to a wrong value — see `apps/dashboard/README.md`, "Why there is no
  `VITE_API_BASE_URL`".
- **There is no CORS.** Not "CORS is configured correctly" — the browser runs no
  cross-origin check on a same-origin request at all. No preflight, no
  `Access-Control-Allow-Origin`, no `OPTIONS` to let through. `CORS_ORIGINS` can
  stay **empty**, and empty is now the *correct* value rather than a dangerous
  one: it fails closed, and what it closes is a door nothing needs to use.
- **The session cookie never crosses an origin.** It is issued `HttpOnly;
  SameSite=Lax` with no `Domain` (`apps/control-api/src/auth/session.service.ts`,
  asserted by a spec in every environment). Same-origin requests send it under
  every `SameSite` value there is, so the registrable-domain arithmetic that used
  to matter here has nothing left to decide.

This is the simplification the whole page turns on, so be clear about what
replaced the risk rather than removed it. Two origins failed **loudly and
early**: `CORS_ORIGINS` wrong and sign-in itself fails on the first request. One
origin moves that hazard into §8's server block, where it fails **late and
quietly** — a missing `location /v1/` answers API calls with `index.html` and a
`200`. That is the single most important thing on this page and it has its own
heading in §8.

### 2. Ingest gets its own hostname

Publishing is server-to-server with a bearer token. It has a completely
different traffic shape from the dashboard, no cookies and no CORS, and you will
eventually want to rate-limit, cache and scale it separately. Give it
`hooks.hookubit.com`.

That hostname is **compiled into the dashboard bundle** as
`VITE_INGEST_BASE_URL`, so decide it before the dashboard is first built. The
build happens **on this host** — §4 by hand, or the Deployer recipe on every
deploy, which reads it from `ingest_base_url` in
`deployments/deployer/hosts.yml` and then greps the built JS to prove the value
arrived. It is a **per-host** value there, which is why each environment needs
its own: the dev box's bundle carries the dev ingest hostname and prod's carries
prod's, and because it is compiled in, pointing a box at the other
environment's ingest is a rebuild, not a restart. `apps/dashboard/README.md` explains what the variable does and what an
unset one produces.

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
sudo mkdir -p /opt/hookubit/{src,bin,shared}
sudo chown -R hookubit:hookubit /opt/hookubit
```

Three directories, and still no `web/`: nginx serves the dashboard **out of the
build tree** (`src/apps/dashboard/dist` here, `current/apps/dashboard/dist`
under the Deployer recipe), never out of a copy. A copy would be a second thing
to keep in step, and a stale copy is indistinguishable from a fresh one until a
user finds it.

There is no `/etc/hookubit` either — configuration lives in
`/opt/hookubit/shared` (§5), which is also where the Deployer recipe keeps it,
so the two layouts agree on every path.

**`/opt/hookubit` must be traversable by `www-data`**, because nginx opens files
underneath it. The `chown -R hookubit:hookubit` above leaves it `0755`, which is
enough; §8 says what to do if you have tightened it, and the Deployer README
covers the same ground for the two-user layout.

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

Built here, into the tree nginx serves. Two variables, both compiled in by vite
and neither of them a secret:

```bash
cd /opt/hookubit/src
VITE_API_TRANSPORT=http \
VITE_INGEST_BASE_URL=https://hooks.hookubit.com \
  pnpm --filter @hookubit/dashboard build

# 12 files, and no .map among them.
find apps/dashboard/dist -type f | wc -l
find apps/dashboard/dist -name '*.map'
```

Output is `apps/dashboard/dist/`, which becomes nginx's `root` in §8. Prove the
variables landed before you move on, because neither failure is visible in the
build output:

```bash
# The ingest origin IS in the bundle, and the localhost fallback is NOT.
grep -rlF --include='*.js' -e 'https://hooks.hookubit.com' apps/dashboard/dist/assets
grep -rlF --include='*.js' -e 'http://localhost:8080'      apps/dashboard/dist/assets
```

The first must name a file. The second must name none and exit `1`. **Keep the
`--include` before the pattern and never put a `--` in front of it**: after a
`--` the filter becomes a filename, grep searches the directory unfiltered and
exits `2`, and on the second command `2` looks exactly like "not found".

::: danger `VAR=x sudo -u hookubit …` silently sets nothing
If you are not inside the `sudo -u hookubit -H bash` shell this step opens, the
obvious spelling does not work:

```bash
VITE_API_TRANSPORT=http sudo -u hookubit pnpm --filter @hookubit/dashboard build   # WRONG
```

That sets the variable on `sudo`, and sudoers' `env_reset` builds a fresh
environment for the target command, so nothing arrives. Put `env` **after**
`sudo`, inside the privilege change:

```bash
sudo -u hookubit env VITE_API_TRANSPORT=http \
     VITE_INGEST_BASE_URL=https://hooks.hookubit.com \
     pnpm --filter @hookubit/dashboard build                                       # RIGHT
```

The two variables fail differently when they are stripped, which is why the
greps above are not optional. `VITE_API_TRANSPORT` has a guard in
`apps/dashboard/vite.config.ts` and the build **refuses** — loud, immediate,
nothing shipped. `VITE_INGEST_BASE_URL` has none: the build succeeds and
compiles `http://localhost:8080` in, and the only symptom is a Get-started page
whose `curl` points at the operator's own laptop.

The Deployer recipe is unaffected by this: it runs as the deploy user over ssh
with no `sudo` in the command, so a plain prefix reaches the process. It runs the
same two greps anyway.
:::

That is the last step that runs inside the `hookubit` shell. Leave it before
you go on: `hookubit` has `/usr/sbin/nologin` for a shell and is not in sudoers,
so every `sudo` from here on fails from in there, and the `systemd-run`
migration in step 6 cannot be run as `hookubit` at all.

```bash
exit
```

---

## 5. Configuration

**Three files, not one.** Configuration is split by who reads it, and the split
is load-bearing rather than tidy:

| File | Holds | Read by |
|---|---|---|
| `/opt/hookubit/shared/.env` | the **nine** variables both planes read | both units |
| `/opt/hookubit/shared/apps/control-api/.env` | the control plane's own | `hookubit-api` only |
| `/opt/hookubit/shared/services/data-plane/.env` | the data plane's own | `hookubit-data-plane` only |

The nine shared ones — `APP_ENV`, `DATABASE_URL`, `LOG_LEVEL`, `REDIS_URL`,
`ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_RETIRED`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAMESPACE` — live in exactly one
file **so that they cannot drift**. Two copies of `ENCRYPTION_KEY` that disagree
means the control API encrypts endpoint signing secrets the worker cannot
decrypt: each process validates its own configuration happily, every delivery
fails at signing time, and nothing in either log points at the cause.
`DATABASE_URL` is the same class of fault — ingest writes events the router never
reads.

Everything else belongs to one plane and lives with it. The full catalogue of
each file, with every default in a comment, is the three `.env.example`
templates in the repository (`/opt/hookubit/src/.env.example` and the two beside
it); [Configuration](/self-hosting/05-configuration) is the reference table.

::: tip Why `shared/` and not the source tree
These are the same three paths the Deployer recipe uses
(`deployments/deployer/README.md`), where they live outside the release
directories and are symlinked into each one. Putting them in the same place here
means moving from this hand-built tree to the automated deploy later changes
nothing about your configuration, and §14's `git pull` cannot touch them.
:::

```bash
sudo mkdir -p /opt/hookubit/shared/apps/control-api \
             /opt/hookubit/shared/services/data-plane

# 1. The nine both planes read.
sudo tee /opt/hookubit/shared/.env >/dev/null <<'EOF'
APP_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public
REDIS_URL=redis://:PASSWORD@cache.lan:6379/0

ENCRYPTION_KEY=REPLACE
EOF

# 2. The control plane's own.
sudo tee /opt/hookubit/shared/apps/control-api/.env >/dev/null <<'EOF'
JWT_SECRET=REPLACE
SESSION_SECRET=REPLACE

# Migrations must bypass PgBouncer: transaction pooling breaks DDL and the
# session-scoped advisory lock Prisma takes. With no pooler it is the same URL
# as DATABASE_URL above — but it must be set HERE, because the Prisma CLI reads
# this directory's .env and does not read the common file.
DIRECT_DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public

# Amazon SES, over SMTP. The credentials are SES *SMTP* credentials, which are
# derived from an IAM user and are NOT the IAM access key itself.
SMTP_URL=smtp://SES_SMTP_USER:SES_SMTP_PASSWORD@email-smtp.eu-west-1.amazonaws.com:587
# Do NOT quote this. Angle brackets and spaces are ordinary characters to both
# dotenv and systemd, and a quote is parsed differently by each.
MAIL_FROM=HookuBit <no-reply@example.com>

# The public origin this box answers the dashboard AND /v1 on. It is the base of
# every link in every email; wrong here means mail full of dead links.
DASHBOARD_URL=https://hookubit.com

# CORS_ORIGINS IS DELIBERATELY EMPTY, AND THAT IS THE CORRECT VALUE.
# The dashboard and the API are one origin, so the browser runs no cross-origin
# check on these requests: there is no preflight to allow and no header to get
# right. The variable fails closed, and what it closes is a door nothing needs.
# Put an origin here ONLY when some OTHER site's JavaScript must call this API
# from a browser - and read §9 first, because that is a real decision, not a
# formality.
CORS_ORIGINS=

CONTROL_API_PORT=3000

# EXACTLY the number of reverse proxies in front of this process.
# Cloudflare + nginx = 2. See "Proxy hops" below before changing it.
TRUST_PROXY_HOPS=2
EOF

# 3. The data plane's own.
sudo tee /opt/hookubit/shared/services/data-plane/.env >/dev/null <<'EOF'
DATABASE_MAX_CONNECTIONS=20

INGEST_PORT=8080
DATA_PLANE_METRICS_PORT=9090

# EXACTLY the number of reverse proxies in front of the INGEST api. See
# "Proxy hops" below.
INGEST_TRUSTED_PROXY_HOPS=2

WORKER_CONCURRENCY=32
EOF
```

Generate the three secrets separately so they never appear in your shell
history as part of a heredoc:

```bash
sudo sed -i "s|^ENCRYPTION_KEY=REPLACE|ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
  /opt/hookubit/shared/.env
for k in JWT_SECRET SESSION_SECRET; do
  sudo sed -i "s|^$k=REPLACE|$k=$(openssl rand -base64 48)|" \
    /opt/hookubit/shared/apps/control-api/.env
done
```

### Ownership and mode

```bash
sudo chown -R root:hookubit /opt/hookubit/shared
sudo chmod 0750 /opt/hookubit/shared \
                /opt/hookubit/shared/apps /opt/hookubit/shared/apps/control-api \
                /opt/hookubit/shared/services /opt/hookubit/shared/services/data-plane
sudo chmod 0640 /opt/hookubit/shared/.env \
                /opt/hookubit/shared/apps/control-api/.env \
                /opt/hookubit/shared/services/data-plane/.env
```

`0640`, group `hookubit` — **not** the `0600 hookubit:hookubit` this page used to
prescribe, which is a mode that works right up until something other than the
service user has to read the file, and then fails in a way that looks like
anything but a permission. Taking it apart:

- **`root` owns them.** You edit configuration with `sudo`; nothing else on the
  box can change what the services are told. Under the Deployer recipe the owner
  is the deploy user instead, because `prisma migrate deploy` and the migration
  guard run as that user over ssh and need `DATABASE_URL` and
  `DIRECT_DATABASE_URL`. **That is the one difference between the two layouts**,
  and it is why the old `0600 hookubit:hookubit` broke an automated deploy: the
  deploy user could not read its own database URL.
- **Group `hookubit`, read.** It is tempting to leave this off, because systemd
  reads an `EnvironmentFile=` as **root**, in PID 1, before it drops privileges —
  so the service user genuinely does not need it *for that*. It needs it for
  something else. The control API loads `.env` and `../../.env` relative to its
  working directory through `@nestjs/config`, which does `existsSync()` and then
  `readFileSync()`; an `EACCES` there is not a skipped file, it is a control API
  that **does not boot**. Group-read is what keeps that from happening the first
  time somebody symlinks these files into the source tree or moves to the
  Deployer layout, where they *are* symlinked into every release.
- **Nothing for *other*.** These files hold `ENCRYPTION_KEY` and a database
  password. The directory modes above matter as much as the file modes: a
  world-traversable path to a `0640` file is one `chmod` away from being readable.

::: danger Back up ENCRYPTION_KEY somewhere that is not the database
Endpoint signing secrets are AES-256-GCM ciphertext bound to their row, and the
key lives only in `/opt/hookubit/shared/.env`. A database backup restored
without it gives you a platform that starts, accepts events, and fails every
single delivery at signing time.
:::

### Format rules — both parsers must agree, line for line

Every one of these files is read by systemd's `EnvironmentFile=` **and**, for the
common and control-api files, by dotenv inside the control API. They are not the
same language, and a line that means two different things in the two parsers
hands the two planes different configuration out of one file. Plain `KEY=value`
only:

- **No quotes.** Both strip them, but they disagree about escapes inside them.
- **No `$`.** dotenv-expand would substitute; systemd would not.
- **No `export`.** dotenv accepts it; systemd puts it in the key name.
- **No backslash line continuations.** systemd joins them; dotenv does not — and
  a connection string cut at the `\` usually still *parses*, so the symptom is
  two planes quietly using different databases.
- **No trailing comments.** `KEY=value  # note` gives dotenv `value` and systemd
  `value  # note`.
- **No leading `;` on a comment.** Use `#`.

`MAIL_FROM=HookuBit <no-reply@example.com>` is safe in both and must stay
**unquoted** — that is why the rule is "no quotes" rather than "quote values with
spaces".

### Proxy hops

`TRUST_PROXY_HOPS` is an exact count, not a boolean, and it is how the per-IP
rate limiter finds the client. Set it too low and every request in the world
shares one bucket, because they all appear to come from your proxy. Set it too
high and a client picks its own address with an `X-Forwarded-For` header, which
is worse than no rate limiting, because it looks like there is some.

**For the topology on this page it is 2, for both planes** — `TRUST_PROXY_HOPS`
in `shared/apps/control-api/.env` and `INGEST_TRUSTED_PROXY_HOPS` in
`shared/services/data-plane/.env`.

::: tip It is still 2, and nothing about the dashboard move changed it
Worth saying out loud rather than leaving to inference, because the hostname
layout did change. This number counts **proxies in front of the process**, not
hostnames and not `location` blocks. The chain into the control API is
`client → Cloudflare → nginx → :3000`, which is two proxies, and it was two
proxies when the API answered on its own hostname. nginx serving static files
out of a second `location` in the same server block adds no hop: it is the same
nginx, the same TLS termination, the same `proxy_pass`.

The derivation below is therefore unchanged, and so is the table. Re-derive it
if you take Cloudflare out (**1**) or put a load balancer in front of it
(**3**).
:::

They are per-process counts, which is exactly
why they are not in the common file: the two planes can legitimately sit behind
different numbers of proxies, and a single shared value would be a guess about
both. Here is the arithmetic, because this is a number to derive once rather
than tune.

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
curl -s https://hookubit.com/v1/auth/session -o /dev/null
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
`EGRESS_ALLOW_PRIVATE_NETWORKS=true` will not start. Name the subnets instead,
in the data plane's own file — the control plane reads neither key:

```bash
# /opt/hookubit/shared/services/data-plane/.env
EGRESS_PRIVATE_ALLOWLIST=10.0.0.0/24,192.168.1.0/24
```

A default route (`0.0.0.0/0`) is rejected too: that is the absence of an
allowlist written to look like one.

### Object storage

There is none configured, and that is fine. The effect is that the maximum event
size is the inline limit (64 KiB), and a larger payload is refused with exactly
that reason rather than silently truncated. Add `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` to
`/opt/hookubit/shared/services/data-plane/.env` when you need bigger events. The
control plane reads none of them, which is why they are not in the common file.

---

## 6. Migrate

Migrations are a separate command, never something an app does on start. Run it
by hand now, and on every upgrade:

```bash
sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/opt/hookubit/shared/.env \
  --property=EnvironmentFile=/opt/hookubit/shared/apps/control-api/.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate deploy

sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/opt/hookubit/shared/.env \
  --property=EnvironmentFile=/opt/hookubit/shared/apps/control-api/.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate status
```

**Two `EnvironmentFile=` properties, common first.** `DATABASE_URL` is in the
common file and `DIRECT_DATABASE_URL` is in the control plane's own, and the
migration needs both. The order matches the units in §7 for the same reason it
matters there: a **later** `EnvironmentFile=` wins in systemd, and the control
API resolves the same pair the other way round (`envFilePath` is
`['.env', '../../.env']`, where **earlier** entries win) — so both agree that
service-specific beats common. The data plane's file is not listed: nothing here
reads it.

Do not simplify that to `env $(grep -v '^#' …)`: `$(…)` word-splits on spaces, so
`MAIL_FROM=HookuBit <no-reply@example.com>` arrives as two arguments and `env`
runs `<no-reply@example.com>` as the command, whereas `systemd-run` reads the
files with the very parser `EnvironmentFile=` uses in the units in step 7 — so
migration and services agree on every key.

::: tip Running `pnpm` without `systemd-run`
`pnpm --filter @hookubit/control-api prisma:deploy` works too, from anywhere in
the tree: that script exports the common file before invoking the CLI, because
the Prisma CLI reads `.env` from its **working directory** only and would
otherwise never see `DATABASE_URL`. `systemd-run` is still the better habit here,
because it proves the files parse the same way the services will read them.
:::

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
# Common first, this service's own second: a LATER EnvironmentFile= wins.
EnvironmentFile=/opt/hookubit/shared/.env
EnvironmentFile=/opt/hookubit/shared/apps/control-api/.env
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
# Common first, this service's own second: a LATER EnvironmentFile= wins.
EnvironmentFile=/opt/hookubit/shared/.env
EnvironmentFile=/opt/hookubit/shared/services/data-plane/.env
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

**Two `EnvironmentFile=` lines each, and the order is the point.** systemd lets a
**later** file override an earlier one, so the common file goes first and the
service's own second. The control API resolves the same pair from the other end —
`envFilePath` is `['.env', '../../.env']` and **earlier** entries win there — so
both parsers agree that service-specific beats common. If they disagreed, one
file would mean different things to the process and to the unit that starts it.

Each unit loads only its own file plus the common one, which is also a small
privilege win: the control API is never handed `S3_SECRET_KEY`, and the data
plane is never handed `JWT_SECRET` or `SESSION_SECRET`.

**Neither line is `-`-prefixed.** `-EnvironmentFile=` tolerates a missing file,
and there is no state of this platform in which running without one of these is
correct — much of the configuration has a safe default, so a tolerated-missing
file does not fail cleanly, it starts something configured by accident. Without
the dash, a start before §5 has been done fails **before** `ExecStart` with
`Failed to load environment files: No such file or directory` and the path in the
message, which is the one error an operator can act on immediately.

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

**nginx has two hostnames and three jobs: serve the dashboard, proxy the control
API on the same hostname, and proxy ingest on its own.**

| Hostname | Path | Answered by |
|---|---|---|
| `hookubit.com` | `/v1/*` | `127.0.0.1:3000` — the control API |
| `hookubit.com` | everything else | files in `current/apps/dashboard/dist`, falling back to `index.html` |
| `hooks.hookubit.com` | everything | `127.0.0.1:8080` — ingest |

That first hostname doing two things is the whole design (constraint 1), and it
is also the one place on this page where a mistake is both easy and silent. Read
the next heading before you write the file.

### `/v1/` must win over the SPA fallback, and `^~` is what makes it

An SPA needs `try_files $uri /index.html`: React Router owns
`/orgs/:orgId/projects/:projectId/…`, those paths exist on no disk, and without
the fallback a refresh or a pasted link is a `404`. That fallback is also a
machine for turning a missing `location` into a `200`.

**If `/v1/` is not handled, `GET /v1/projects` returns `index.html` with a
`200`.** Not a 404, not a 502 — the dashboard's own HTML, with a success status
and `Content-Type: text/html`. The app then calls `response.json()` on it and
dies on `JSON.parse`, screen by screen, with a browser console full of
`Unexpected token '<'` and nothing anywhere naming the cause. Sign-in fails the
same way. The platform behind it is completely healthy; every probe in §7 is
green.

This hazard is **new**, and it is the price of the one-origin simplification.
Two origins put a build-time variable in the path, and a wrong one failed on the
first request with a CORS error that named itself. Deleting that variable moved
the failure here, into a file no test covers.

So get the precedence right, and understand what it does and does not depend on:

| What nginx does | Consequence here |
|---|---|
| `location = /path` — exact — wins immediately | `= /index.html` is reached even via the `try_files` internal redirect |
| otherwise nginx finds the **longest matching prefix** | `/v1/` (4 chars) beats `/` (1 char) for `/v1/projects` |
| if that longest prefix has `^~`, matching **stops there** | `^~ /v1/` is immune to every regex, present and future |
| otherwise **regex** locations are tried, in file order, and the first match wins — **outranking the prefix** | a bare `location /v1/` can be stolen by any regex in the block |
| if no regex matched, the longest prefix is used | the ordinary path |

Two things follow, and the second is the one people get wrong.

**The order of the `location` blocks in the file does not matter.** Prefix
selection is by length, not by line number. Writing `location /` first and
`location ^~ /v1/` last behaves identically to the reverse. You cannot fix this
hazard by moving blocks around, and you cannot break it that way either.

**A regex location can take `/v1/` away from a plain prefix, from anywhere in
the block.** That is the real "misordering" risk, and it is a type precedence
rather than a position one. `location ~ \.json$ { try_files $uri /index.html; }`
— an entirely reasonable-looking line — captures `/v1/openapi.json` even when it
is written *below* `location /v1/`. `^~` is the one-character answer: it ends
matching at the prefix, so no regex added later can reach inside it.

::: tip Verified by execution, not by reading the manual
The table above was checked by running nginx 1.27 over the server block below
with a stub upstream, which is worth reporting because four of the five rows
only matter when something is wrong:

| Config | `GET /v1/projects` | `GET /v1/openapi.json` |
|---|---|---|
| as written below | `401 application/json` | `401 application/json` |
| `location ^~ /v1/` **deleted** | **`200 text/html`** | **`200 text/html`** |
| `location /v1/` (no `^~`) + `location ~ \.json$` | `401 application/json` | **`200 text/html`** |
| `location ^~ /v1/` + the same regex | `401 application/json` | `401 application/json` |
| blocks in reverse file order | `401 application/json` | `401 application/json` |

And one more, which is why `/assets/` below is a plain prefix and **not** `^~`:
with `location ^~ /assets/`, `GET /assets/index-<hash>.js.map` answered `200`
with the sourcemap's contents, because `^~` had stopped the
`location ~ \.map$ { return 404; }` regex from ever being considered. `^~` is
the right modifier for a block that must beat regexes and the wrong one for a
block that needs a regex to reach inside it.
:::

**The one-line proof, after every install and after every edit to this file:**

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://hookubit.com/v1/auth/session
```

- `401 application/json; charset=utf-8` — correct. That is the control API
  answering, through nginx, through Cloudflare.
- `200 text/html` — **stop.** `/v1/` is not reaching the API; you are looking at
  `index.html`. The dashboard is broken and nothing else will tell you.
- `000` or `502` — nginx or the API unit, not the `location` blocks. §7's
  localhost probes separate those two.

The Deployer recipe runs this assertion on every deploy
(`hookubit:dashboard:check`), against nginx on loopback with the Host header
set, so an edge cache cannot make it pass or fail wrongly.

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
`curl -sv --resolve hookubit.com:443:<your-ip> https://hookubit.com/v1/auth/session`
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
the configuration below, and it fails in the SPA's characteristic way rather
than with an error. The challenge arrives as
`/.well-known/acme-challenge/<token>`, no such file exists, `try_files` falls
back, and the ACME server is handed **`index.html` with a `200`** where it
expected a key authorization. Issuance fails saying the response did not match.

That is survivable the first time, because you find out immediately. What is not
survivable is the **renewal** 60 days later: it fails the same way, silently, in
a timer whose output nobody reads, and when the certificate expires Cloudflare
answers **`526` on everything** — the dashboard included, since both come from
this origin now. One origin at least makes that failure total rather than
half-working, which is the kind of outage people notice in minutes.

If you want a publicly-trusted certificate anyway, use **DNS-01** (`certbot
--dns-cloudflare`), which never touches this nginx. Do not carve a
`/.well-known/` exception into the server block just to make `http-01` work: the
port is Cloudflare-only now, so the challenge would have to come through the
proxy anyway, and you would be maintaining an unauthenticated path on the
hostname that serves your operator UI for the benefit of one request every two
months.
:::

### `/etc/nginx/sites-available/hookubit`

```nginx
# ── hookubit.com — the dashboard AND the control API. ONE origin.
server {
    listen 443 ssl http2;
    server_name hookubit.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    # The LIVE RELEASE's bundle, through the `current` symlink. Under the
    # Deployer recipe that is what a deploy swaps and what a rollback swaps
    # back; nginx resolves the symlink per request, so neither needs a reload.
    # Building by hand (§4) instead? /opt/hookubit/src/apps/dashboard/dist.
    root /opt/hookubit/current/apps/dashboard/dist;
    index index.html;

    # ── The control API. `^~` IS LOAD-BEARING: it stops location matching at
    #    this prefix, so no regex block — here or added later — can take
    #    /v1/<anything> away from it. Without it, one plausible regex turns
    #    every API call into index.html with a 200. See the heading above.
    location ^~ /v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long enough for a slow report, short enough to free the worker.
        proxy_read_timeout 60s;
        # Do NOT add proxy_intercept_errors here. It is off by default, and on
        # it would hand the API's own 404 and 5xx JSON to error_page — i.e.
        # back to the SPA fallback — which is the same HTML-instead-of-JSON
        # failure arriving by a different route.
    }

    # ── /health/* is probed on LOCALHOST (§7) and is never published: it is an
    #    unauthenticated readout of this box's database reachability. Without
    #    this block the SPA fallback would answer it with index.html — not a
    #    leak, but not an answer either. The explicit 404 is what stops someone
    #    later "fixing" that by proxying it.
    location ^~ /health/ {
        return 404;
    }

    # ── NO SOURCEMAP IS EVER SERVED. apps/dashboard/vite.config.ts sets
    #    build.sourcemap: false, so there should be nothing to match. This is
    #    the second line of defence, not the first: one `pnpm build --sourcemap`
    #    on the box publishes ~2.9 MB of complete frontend source — every
    #    comment, every internal name, every route the UI knows about — at a
    #    guessable URL, and nothing in the app or the build would notice.
    #
    #    A REGEX on purpose: a regex outranks the plain /assets/ prefix below,
    #    which is where a map would actually land. That is also why /assets/ is
    #    NOT written `^~` — `^~` there would stop this rule being considered.
    location ~ \.map$ {
        return 404;
    }

    # ── Content-hashed assets: immutable, one year. Vite fingerprints every
    #    file here, so a changed file is a changed NAME and this can never
    #    serve a stale one.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        # NOT `always`: the default status list leaves this header off the 404
        # below, and a 404 cached for a year is its own outage.
        #
        # `=404`, NOT the SPA fallback. A missing hashed asset must be a 404.
        # Falling back to index.html would answer a `<script type="module">`
        # request with HTML — the same JSON.parse-of-HTML failure as a missing
        # /v1/, one layer down.
        try_files $uri =404;
    }

    # ── index.html must NEVER be cached for long. It names the hashed assets;
    #    a stale copy asks for filenames the new release no longer has, and the
    #    page fails to boot for that viewer only, until their cache expires.
    #    `no-cache` means "revalidate every time", not "do not store", so the
    #    ETag still makes it a cheap 304.
    #
    #    `= /index.html` is an EXACT match, which beats everything — and the
    #    `try_files` internal redirect below re-runs location matching, so a
    #    deep link lands here too and gets the same header. (Verified by
    #    execution: GET /orgs/1/projects/2 comes back `no-cache`.)
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # ── The SPA fallback. React Router owns every path that is not a file, so
    #    a refresh or a pasted deep link must get index.html rather than a 404.
    #    This block is the reason every block above it exists.
    location / {
        try_files $uri /index.html;
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
    server_name hookubit.com hooks.hookubit.com;
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

### `www-data` has to be able to read the release

nginx opens files under `/opt/hookubit`, which means the `www-data` worker needs
the **search** bit on every directory down to
`current/apps/dashboard/dist` and **read** on the files in it. §3's
`chown -R hookubit:hookubit /opt/hookubit` leaves `0755`, which is enough. If
you have tightened it — or if you are on the Deployer layout, where
`/opt/hookubit` is `2750` by default — widen the top of the tree back:

```bash
sudo chmod 2755 /opt/hookubit          # setgid stays; `other` gets r-x again
```

::: danger Do not put `www-data` in the `hookubit` group
It is the obvious-looking alternative and it is strictly worse now than it was
before. The three env files in `shared/` are `0640` with group `hookubit`
(§5), so group membership hands the **web server** `ENCRYPTION_KEY`, the
database password, `JWT_SECRET` and `SESSION_SECRET`. nginx has no business
being able to read any of them, and a web server is the single process on this
box most likely to be the one that gets exploited. The world-execute bit on one
directory is a far smaller grant than membership of the group that owns the
secrets.

Then keep the secrets independent of that directory mode, so widening the top of
the tree cannot widen anything that matters:

```bash
sudo chmod 0750 /opt/hookubit/shared
sudo chmod 0750 /opt/hookubit/shared/apps /opt/hookubit/shared/apps/control-api \
                /opt/hookubit/shared/services /opt/hookubit/shared/services/data-plane
```
:::

**The umask corollary changed, and it is not the one that was here before.** It
used to be enough for the build user's umask to leave *group* read on, because
only the service user read the tree. nginx reads it as **other** now, so:

| umask | Directories | nginx can serve the bundle |
|---|---|---|
| `022` | `0755` | **yes** |
| `027` | `0750` | **no** — `403 Forbidden` on every asset |
| `077` | `0700` | no, and the service user cannot read the code either |

`022` is Ubuntu's default and is what this page assumes. A hardened `027` — in
`/etc/login.defs`, in `/etc/profile`, in a `pam_umask` setting, or in the deploy
user's own `.profile` under the Deployer layout — now produces a dashboard that
`403`s while the API, both units and every localhost probe are perfectly
healthy. It also appears one *rebuild* after the umask was changed rather than
immediately, because the files already on disk keep the modes they were written
with.

::: tip The tighter alternative, if you want the release tree closed
An ACL grants exactly `www-data` exactly traversal, with no world bits at all,
and a **default** ACL carries it onto release directories created later:

```bash
sudo setfacl -m     u:www-data:rx /opt/hookubit /opt/hookubit/releases
sudo setfacl -d -m  u:www-data:rx /opt/hookubit/releases
sudo chmod 2750 /opt/hookubit
```

It is more precise and it is one more mechanism to remember; `getfacl` is then
part of debugging a `403`. Either is defensible. `2755` is what the rest of this
page and the Deployer README assume.
:::

### Five more things about that file

**There is no CORS block, and there must not be one.** The dashboard and the API
are one origin, so there is no preflight: nothing sends `OPTIONS`, nothing looks
for `Access-Control-Allow-Origin`. Adding CORS headers in nginx while the API
also sets them is how you get *two* `Access-Control-Allow-Origin` headers, which
browsers reject outright — a self-inflicted outage in service of a problem this
topology does not have.

**`client_max_body_size 2m` must stay above `PAYLOAD_MAX_BYTES`** (1 MiB by
default). If nginx refuses first, the publisher gets an nginx HTML error page
instead of the platform's JSON naming the limit it hit. Raise this whenever you
raise that.

**`listen 443 ssl http2;` is the right spelling for Ubuntu 22.04 and 24.04**
(nginx 1.18 and 1.24). On nginx 1.25 or newer it warns, and the replacement is
`listen 443 ssl;` plus a separate `http2 on;`.

**`open_file_cache` is off, and leaving it off is what makes a deploy instant.**
nginx resolves `/opt/hookubit/current` per request, so the symlink swap is picked
up with no reload. Turn the cache on and it holds the resolved path for
`open_file_cache_valid`, which means a window after every deploy in which the
hostname serves the previous release's files.

**What stays unexposed.** `9090` is probes and metrics and never goes through
nginx. Prometheus reaches it over the private network or an SSH tunnel.

---

## 9. Cloudflare — proxy and cache, nothing else

**Cloudflare hosts nothing.** There is no Pages project, no Worker, no build
settings and no deployment branch. What it provides is TLS at the edge, caching,
DDoS absorption, and the address-hiding that §8's packet filter depends on. All
three public paths terminate on the one box behind it.

| Name | Who answers it | Where it is configured |
|---|---|---|
| `hookubit.com` | nginx on the app host → the dashboard's files, **and** `/v1/*` → `127.0.0.1:3000` | §8 |
| `hooks.hookubit.com` | nginx on the app host → `127.0.0.1:8080` | §8 |
| `sysadmin.hookubit.com` | nothing yet — a planned internal admin dashboard | n/a. Do not create the record until something serves it |

**`make deploy-prod` ships everything.** One trigger, one artifact set: the
release carries `apps/dashboard/dist`, `apps/control-api/dist/main.js` and
`bin/webhookd`, and the `current` symlink swaps all three at once. The
environment is named in the command — `make deploy-dev` for the dev box — and a
bare `make deploy` refuses, because with two boxes neither is the default.
There is no second deploy path, no front end that updates on `git push` while
the server waits for a deploy, and no state in which the two halves are from
different commits. Nothing at the edge needs purging afterwards — see "Cache rules".

### What the API still needs to be told

One variable, in `/opt/hookubit/shared/apps/control-api/.env` on the app host:

```bash
DASHBOARD_URL=https://hookubit.com
```

It is the base of every link in outbound mail — verification, invitations,
password resets. Wrong here means mail full of dead links while the platform
itself works perfectly, which is why it is a variable at all rather than
something the API infers from the request it is answering.

::: tip `CORS_ORIGINS` stays empty, and that is the correct state
It used to be the first thing to check on this page, because the dashboard was a
different origin from the API and the variable fails closed. One origin removes
the question: the browser runs no cross-origin check on a same-origin request,
so there is no preflight to allow, no header to spell exactly, and nothing
`CORS_ORIGINS` can do to this deployment in either direction.

Leave it blank. Set it **only** when some other site's JavaScript must call this
API from a browser — a separate admin tool on `sysadmin.hookubit.com`, say — and
then list that origin exactly: scheme and host, no path, no trailing slash,
`www.` a separate entry. Until then, an empty value is one fewer string that has
to match something else to stay correct.

`apps/dashboard/src/lib/api.test.ts` asserts that the dashboard's
"could not reach the API" message does **not** mention this variable, so that
nobody spends an outage editing something uninvolved.
:::

### DNS

Two records, both **proxied** (orange cloud), both pointing at the app host's
public IP:

| Name | Type | Proxy |
|---|---|---|
| `@` (the apex, `hookubit.com`) | A (and AAAA if you have one) | **Proxied** |
| `hooks` | A (and AAAA if you have one) | **Proxied** |

The apex is an ordinary A record at this box now — not a Workers or Pages custom
domain, and not managed for you. If one is left over from a previous setup,
**delete it before you create the A record**: a custom-domain binding takes the
hostname, so the A record either cannot be created or is ignored, and the
hostname keeps serving an old bundle from the edge while every check in §8 and
§14 passes on the origin.

There is no `api` record. The control API answers on the apex under `/v1/`, which
is what makes it one origin.

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

One hostname now serves content with three different cache lifetimes, so the
rules are per-path rather than per-hostname:

| Path | Rule |
|---|---|
| `hookubit.com/v1/*` | **Bypass cache** |
| `hookubit.com/assets/*` | **Respect origin headers** (or Edge TTL "use origin", and Browser TTL "respect origin") |
| `hookubit.com/*` — everything else, which is `index.html` | **Respect origin headers.** Do not set an Edge TTL override |
| `hooks.hookubit.com/*` | **Bypass cache** |

**`/v1/*` must be bypassed, and it must be the first rule.** A cached
`POST /v1/...` is not possible, but a cached `GET /v1/projects` served to the
*wrong tenant* absolutely is. Do not rely on Cloudflare's default behaviour
staying what it is today, and do not rely on the ordering being obvious —
Cloudflare evaluates cache rules in order, so a broad `hookubit.com/*` rule
above this one can swallow it.

**Caching is enforced in nginx; Cloudflare is told to respect it.** §8 sets
`Cache-Control: public, max-age=31536000, immutable` on `/assets/*` and
`no-cache` on `index.html`, which is the only place the two values can be kept
next to each other and next to the `try_files` they have to agree with. The
edge's job is to honour them, not to restate them. Set a long Edge TTL on
`hookubit.com/*` instead and you have overridden `index.html` too — the one
thing that must never be cached for long, because it names the hashed assets and
a stale copy asks for filenames the new release no longer has. `apps/dashboard/
README.md` describes the same contract from the bundle's side.

**Do not enable Rocket Loader, Auto Minify or Email Obfuscation** on
`hookubit.com`. They rewrite JavaScript and HTML; the bundle is already minified
and content-hashed, so the only thing they can do here is break it in ways that
reproduce on nobody's laptop.

**Leave `hooks.hookubit.com` alone** apart from proxying. No caching, no
transformations. It takes signed `POST` bodies and the signature covers the exact
bytes — anything that rewrites a request body makes every delivery fail
verification.

**There is still nothing to purge after a deploy,** for a different reason than
before. Every asset filename contains a hash of its contents, so a new release
asks for names the edge has never seen and fetches them from the origin; and
`index.html`, the one unhashed file, is `no-cache` and revalidated on every hit.
If you find yourself purging the cache to make a deploy appear, the rule above
`hookubit.com/*` is wrong — fix that rather than purging again next time.

### Checking it

From anywhere, including the app host. These four are the install, in the order
that localises a failure fastest:

```bash
# 1. /v1 reaches the control API and NOT the SPA fallback. The important one.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://hookubit.com/v1/auth/session

# 2. The dashboard is served, and its index.html is not cached for long.
curl -sI https://hookubit.com/ | grep -iE 'HTTP/|cache-control|etag|cf-cache-status'

# 3. A hashed asset IS cached immutably. Take the filename from the page itself.
curl -s https://hookubit.com/ | grep -o '/assets/index-[^"]*\.js' | head -1
curl -sI "https://hookubit.com$(curl -s https://hookubit.com/ | grep -o '/assets/index-[^"]*\.js' | head -1)" \
  | grep -iE 'HTTP/|cache-control'

# 4. No sourcemap is reachable, whatever was built.
curl -s -o /dev/null -w '%{http_code}\n' "https://hookubit.com$(curl -s https://hookubit.com/ | grep -o '/assets/index-[^"]*\.js' | head -1).map"
```

1. must be `401 application/json; charset=utf-8`. **`200 text/html` means the
   `location ^~ /v1/` block is missing or has been out-ranked by a regex, and
   the dashboard is broken** — §8's first heading. A Cloudflare error page means
   the record, the cache rule or the firewall; `526` specifically means the
   origin certificate.
2. must be `200` with a short or zero `max-age` and an `ETag`.
3. must be `200` with `max-age=31536000, immutable`.
4. must be `404`, from `location ~ \.map$`. A `200` here is the complete
   frontend source on a public URL: find out why a map was built
   (`apps/dashboard/vite.config.ts` sets `build.sourcemap: false`) and treat the
   nginx rule as having done its job rather than as the fix.

There is no `OPTIONS` check any more. There used to be one here, because a
cross-origin dashboard preflighted every write and `CORS_ORIGINS` could take
every mutation down while reads kept working. One origin sends no preflight at
all, so there is nothing to check and nothing to get wrong.

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
echo 'ALLOW_OPEN_REGISTRATION=true' | sudo tee -a /opt/hookubit/shared/apps/control-api/.env
sudo systemctl restart hookubit-api
```

Register at `https://hookubit.com`, follow the verification link SES delivers,
then:

```bash
sudo sed -i 's/^ALLOW_OPEN_REGISTRATION=true/ALLOW_OPEN_REGISTRATION=false/' \
  /opt/hookubit/shared/apps/control-api/.env
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
**app host** — that is where the env files are. Nothing sets
`DIRECT_DATABASE_URL` in your shell, so read it out of the control plane's own
file (`DATABASE_URL` is in the common one; the dump wants the direct URL);
`pg_dump` then
connects over the network to the database host. Dumps land in
`/var/backups/hookubit`, root-owned and `0700`, so nothing depends on which
directory you happened to be standing in.

```bash
# 1. The database — the system of record AND the queue.
sudo install -d -m 0700 /var/backups/hookubit

URL=$(sudo sed -n 's/^DIRECT_DATABASE_URL=//p' /opt/hookubit/shared/apps/control-api/.env \
        | tail -n1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
OUT=/var/backups/hookubit/hookubit-$(date +%F).dump

sudo pg_dump --format=custom -f "$OUT" "${URL%%\?*}" \
  || { echo 'DUMP FAILED — no backup taken'; sudo rm -f "$OUT"; false; }

# 2. The encryption key. Separately, and not beside the dump.
sudo grep ENCRYPTION_KEY /opt/hookubit/shared/.env
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
  && sudo -u hookubit env VITE_API_TRANSPORT=http \
       VITE_INGEST_BASE_URL=https://hooks.hookubit.com \
       pnpm --filter @hookubit/dashboard build \
  && grep -rlF --include='*.js' -e 'https://hooks.hookubit.com' apps/dashboard/dist/assets \
  && ! grep -rqF --include='*.js' -e 'http://localhost:8080' apps/dashboard/dist/assets \
  && ( cd services/data-plane \
       && sudo -u hookubit /usr/local/go/bin/go build \
            -o /opt/hookubit/bin/webhookd ./cmd/webhookd ) \
  && ls -l /opt/hookubit/bin/webhookd
```

**The dashboard is in that chain now, and the chain is still what protects
you.** Every link needs the one above it, so a failed dashboard build stops
everything after it — including, and this is the point, the migration block
below, which you do not run at all if this one stopped. Nothing has touched the
schema yet; start the data plane again and you are back on the old release.

Four details in that chain are easy to get wrong and silent when you do.

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

**`sudo -u hookubit env VAR=…`, not `VAR=… sudo -u hookubit`.** The second form
sets the variable on `sudo`, which discards it: sudoers' `env_reset` builds a
fresh environment for the target command. `env` goes *after* `sudo`, inside the
privilege change. The two variables then fail differently, which is why the
greps are links in the chain rather than a note: `VITE_API_TRANSPORT` is guarded
in `apps/dashboard/vite.config.ts` and a stripped one **refuses the build**,
while a stripped `VITE_INGEST_BASE_URL` builds happily with
`http://localhost:8080` compiled in.

**The two greps keep their options before the pattern, and there is no `--`.**
After a `--`, `--include='*.js'` stops being a filter and becomes a filename:
grep warns about a file that does not exist, searches the directory unfiltered,
and exits `2`. The negative check is `! grep -rq …`, and `2` is non-zero, so
with a `--` in it that link passes while checking nothing. There is no
`--exclude='*.js.map'` for two reasons — the `*.js` glob does not match a
`.js.map` name anyway, and `vite.config.ts` emits no map — so if you find
yourself adding one, find out why a sourcemap exists instead.

The `( cd services/data-plane && … )` subshell matters more than it used to: the
dashboard build and both greps run from `/opt/hookubit/src`, and the subshell is
what keeps the `cd` from leaking into anything added after it.

Then migrate, check, and only then restart — as one chain, so the restarts
cannot happen without the migration having succeeded:

```bash
sudo systemd-run --pipe --wait --collect \
  --uid=hookubit --gid=hookubit \
  --property=EnvironmentFile=/opt/hookubit/shared/.env \
  --property=EnvironmentFile=/opt/hookubit/shared/apps/control-api/.env \
  --working-directory=/opt/hookubit/src/apps/control-api \
  pnpm exec prisma migrate deploy \
  && sudo systemd-run --pipe --wait --collect \
    --uid=hookubit --gid=hookubit \
    --property=EnvironmentFile=/opt/hookubit/shared/.env \
    --property=EnvironmentFile=/opt/hookubit/shared/apps/control-api/.env \
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

Finally, prove the public hostname still reaches what you just restarted — and
that it is serving the bundle you just built, not the previous one:

```bash
# 1. /v1 reaches the control API, not the SPA fallback.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://hookubit.com/v1/auth/session

# 2. The hostname serves THIS build's entry module.
diff <(grep -o '/assets/index-[^"]*\.js' /opt/hookubit/src/apps/dashboard/dist/index.html | head -1) \
     <(curl -s https://hookubit.com/ | grep -o '/assets/index-[^"]*\.js' | head -1) \
  && echo 'dashboard: the hostname is serving this build'
```

1. must be `401` with `application/json`. **`200 text/html` means `/v1` is
   falling through to the SPA and every screen in the dashboard is broken** —
   §8's first heading. A Cloudflare error page means the path from the edge
   rather than the services: `526` is the origin certificate, `522`/`523` is the
   firewall or the DNS record.

2. must print nothing from `diff` and then the success line. A difference is
   nginx serving a bundle that is not this one, and the cause is almost always
   nginx's `root`: it must point through the path you actually build in
   (`/opt/hookubit/src/apps/dashboard/dist` for this page's single-tree layout,
   `/opt/hookubit/current/...` under the Deployer recipe). The second-likeliest
   cause is an edge-cached `index.html`, which means a Cloudflare cache rule is
   overriding the origin's `no-cache` — §9. Re-run it with
   `-H 'Cache-Control: no-cache'` to tell the two apart.

This replaces the `OPTIONS` preflight check that used to be here. One origin
sends no preflight, so there is nothing left for `CORS_ORIGINS` to break and
nothing to confirm. What took its place is a harder question — *is the HTML on
the public hostname the HTML in this release* — which is the one thing that goes
wrong on every deploy rather than once per install.

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

**A missing or out-ranked `location ^~ /v1/`.** The single most likely
first-install failure, and the one that announces itself least. With the SPA's
`try_files $uri /index.html` fallback in place, an unhandled `/v1/projects`
returns **`index.html` with a `200`**, the dashboard dies on `JSON.parse` of
HTML screen by screen, and nothing — not a log, not a status code, not the
browser's network tab at a glance — names the cause. Two ways in: the block is
absent, or it is written without `^~` and a regex `location` in the same server
block matched first. Block order in the file is **not** one of the ways; prefix
selection is by length, not by line number. §8 has the one-line `curl`, and the
Deployer recipe runs it on every deploy.

**A sourcemap in `dist/`.** `apps/dashboard/vite.config.ts` sets
`build.sourcemap: false`, so a `.map` only exists if someone built with
`--sourcemap` on the box — and `dist/` is a document root now, so it is ~2.9 MB
of complete frontend source at a guessable URL. §8's
`location ~ \.map$ { return 404; }` is the backstop; `find dist -name '*.map'`
after a build is the check.

**`index.html` cached at the edge.** Vite fingerprints every asset, so a stale
`index.html` asks for filenames the new release no longer has and the page fails
to boot — for the viewers whose cache has it, which makes it hard to reproduce
and easy to dismiss. nginx sends `no-cache` for it; a broad Cloudflare Edge TTL
rule on `hookubit.com/*` overrides that. §9.

**`CORS_ORIGINS`, in either direction.** It is **not** on the list any more, and
it should not be put back. The dashboard and the API are one origin, so no CORS
check runs on these requests at all: an empty value is correct, and naming it in
a failure report sends an operator to spend an outage editing something
uninvolved. Adding an origin to it is a real decision about some *other* site's
JavaScript (§9), not a step in getting the dashboard working.

**`www-data` unable to traverse `/opt/hookubit`.** `403` on every asset while the
API, both units and every localhost probe are green. `2755` on the deploy path
and a `022` umask on the build user — and **not** `usermod -aG hookubit
www-data`, which would hand the web server `ENCRYPTION_KEY` and the database
password. §8.

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
`VITE_API_TRANSPORT=http`, every screen works against data that does not exist.
`vite.config.ts` now **refuses** such a build, so this can only reach a release
as a deliberate `=mock`, or on a bundle built before that guard existed. The
tell is the permanent red "Demo data" banner;
`src/components/DemoDataBanner.tsx` puts it on every page including the auth
ones. Grepping the bundle is not a check — see `apps/dashboard/README.md`.

**`VITE_INGEST_BASE_URL` stripped by `sudo`.** `VAR=x sudo -u hookubit …` sets
the variable on `sudo`, which discards it under `env_reset`. The transport guard
turns that into a refused build; this variable has no guard, so the build
succeeds with `http://localhost:8080` compiled in and every operator gets a
Get-started `curl` pointed at their own laptop. `sudo -u hookubit env VAR=x …`,
and grep the built JS — §4 and §14 both do.

**nginx's `root` not going through the live release.** A `root` naming a release
directory, or an `/opt/hookubit/src` left from a hand-built install, is correct
the day it is written and stale after the next deploy — and nothing else fails,
because the old bundle still talks to the new `/v1`. It must be
`/opt/hookubit/current/apps/dashboard/dist` under the Deployer recipe.
`hookubit:dashboard:check` compares the entry module's hash on every deploy for
exactly this.

**Cloudflare in "Flexible" SSL mode.** Padlock in the browser, plain HTTP
between Cloudflare and your origin, session cookies and signing secrets in
clear text. Full (strict), always.

**Cloudflare caching `/v1/*`.** Bypass it explicitly, in a rule **above** any
broad `hookubit.com/*` rule — one hostname now serves the API and the dashboard,
so a cache rule written for the front end can reach the API. A cached
`GET /v1/projects` served to the wrong tenant is the failure. Do not rely on the
default behaviour staying what it is today.

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

### Two faults in the data plane's own config reader

Both are in `services/data-plane/internal/config/`, both are present in the code
as shipped, and both are listed here rather than in a bug tracker because the
only thing that protects you from either one today is knowing about it. Neither
can be worked around from an env file; each needs a small change in Go.

**`APP_ENV=` empty makes the two planes disagree about where they are running.**
`config.go`'s `env(key, fallback)` returns the fallback when
`os.Getenv(key) == ""`, and Go cannot tell a variable that is set to the empty
string from one that is unset. The three `.env.example` templates ship every
required variable **present and empty** on purpose, so that a plane refuses to
boot by name rather than starting against somebody's laptop — and `APP_ENV=` is
in the common file, the one file both planes read.

The control API does exactly what the templates intend: `APP_ENV` is required
with no default, blank counts as unset, and it **refuses to boot** naming the
variable. The data plane, from the same line in the same file, comes up believing
it is `development` — and that is not a cosmetic difference, because it is the
switch on its two production-only refusals:

| Refusal | What it stops in `production` | What happens at `development` |
|---|---|---|
| `EGRESS_ALLOW_PRIVATE_NETWORKS=true` is rejected outright (`config.go`) | a blanket SSRF override reaching a server | it is **accepted**, and the worker will deliver to `169.254.169.254` and your LAN |
| rate limits with no Redis are rejected (`isolation.go`) | per-endpoint delivery limits silently degrading to per-replica, i.e. multiplied by the replica count | it **starts**, and a customer's configured limit is whatever you multiplied it by |

So one blank line in the file that exists specifically to stop the two planes
drifting makes them drift in the worst available direction: the control plane
stops, loudly, and the data plane starts with its guard rails off. **Set
`APP_ENV=production` explicitly, and check it is not blank before you blame
anything else.** `curl -s localhost:9090/health/ready` does not report it, so
read the unit's startup log.

**`envInt`, `envBool` and `envDuration` swallow parse errors.** All three return
the default when `strconv` fails, with nothing logged:
`INGEST_TRUSTED_PROXY_HOPS=two` runs at `0`, and `0` means the ingest handler
takes the client address from the socket — which, behind Cloudflare and nginx, is
`127.0.0.1` for every request on earth. Every publisher then shares one per-IP
bucket. `WORKER_CONCURRENCY=32x` is the same shape, and so is any
`*_TIMEOUT_MS` with a unit suffix on it (`30s` parses as nothing and reverts to
the default, which may be shorter or longer than you meant).

`internal/retention` is the exception and shows the fix: its `envInt`, `envBool`,
`envDays` and `envMillis` all return `(value, error)` and the loader refuses, on
the stated grounds that silently substituting a number for the one an operator
wrote is the failure mode worth removing. The rest of the data plane's config
does not do that yet. Until it does, **a typo in the data plane's env file is a
value you do not have**, and the only way to see it is to read back what the
process thinks it is using rather than what you wrote.
