# Bare metal on Ubuntu

One Ubuntu box, no Docker, systemd for everything. This is the shape a home
server or a single VPS actually wants: three services, an existing PostgreSQL
somewhere on the network, and a reverse proxy in front.

It assumes Ubuntu 22.04 or 24.04 and a PostgreSQL 15+ server you already run.
If you want containers instead, read [Docker Compose](/self-hosting/04-docker-compose).

## What you will end up running

| systemd unit | What it is | Listens on |
|---|---|---|
| `hookubit-api` | The control API — the dashboard's backend. Never in the delivery path. | `127.0.0.1:3000` |
| `hookubit-data-plane` | `webhookd all`: ingest, router, scheduler and worker in one process | `0.0.0.0:8080` ingest, `127.0.0.1:9090` probes |
| `caddy` | TLS, and serving the dashboard's static bundle | `:80`, `:443` |
| `redis-server` | Rate-limiter buckets. Not a queue — the queue is PostgreSQL. | `127.0.0.1:6379` |
| `mailpit` | A local inbox, until you point mail at a real relay | `127.0.0.1:1025` SMTP, `127.0.0.1:8025` web |

**`webhookd all` runs the four data-plane roles in one process.** On a single
box that is the right call: one unit, one log, one set of probes. The roles are
separable for a reason — the worker is the throughput dial and scales
independently — but splitting them on one machine buys you nothing except four
processes contending for the same CPU.

You can split later. If you do, read the metrics-port trap at the bottom first.

---

## 1. Check the database before anything else

The migration job refuses to run on PostgreSQL 14 or older — the schema uses
`NULLS NOT DISTINCT` unique indexes, which earlier versions cannot express. It
refuses rather than half-applying, but find out now:

```bash
psql "postgresql://USER:PASS@db.lan:5432/hookubit" -tAc "show server_version;"
```

Create the database and a role that owns it:

```sql
CREATE ROLE hookubit LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE hookubit OWNER hookubit;
```

Then confirm the app box can actually reach it — `listen_addresses` and
`pg_hba.conf` on the database server both have to allow it:

```bash
pg_isready -h db.lan -p 5432 -U hookubit -d hookubit
```

### Two URLs, and why

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | The database, through a pooler if you have one | Both planes, at runtime |
| `DIRECT_DATABASE_URL` | The server directly, never a pooler | The migration command only |

With no PgBouncer in the picture, set both to the same string. Keep them as two
variables anyway: the day you add a pooler, migrations through it in
transaction-pooling mode can leave a migration half applied with its history row
stuck in `failed`, because Prisma takes a session-scoped advisory lock.

---

## 2. Packages

```bash
sudo apt update
sudo apt install -y build-essential git curl ca-certificates redis-server
```

Node 22 and pnpm — the repo pins pnpm through `packageManager`, so let corepack
read it rather than installing a version by hand:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
```

Go — check the version the repo builds against and match it:

```bash
grep GO_VERSION .github/workflows/ci.yml
# then, for that version:
curl -fsSL https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
```

`go.mod` states a *minimum* language version, not a pin. The CI version is the
one that has actually been tested.

Redis is worth the one package. Without it a production worker **refuses to
start**, because endpoint delivery rate limits would be enforced per process —
a customer's limit of N silently becoming N × replicas. On one box with one
worker that refusal is arguably pedantic, and there is an escape hatch
(`DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true`), but installing Redis also gives
the control API a shared throttle store and costs you nothing.

---

## 3. A user and a place to live

Run it as a system user with no shell and no home of its own:

```bash
sudo useradd --system --create-home --home-dir /opt/hookubit --shell /usr/sbin/nologin hookubit
sudo mkdir -p /opt/hookubit/{src,bin,web} /etc/hookubit
sudo chown -R hookubit:hookubit /opt/hookubit
```

---

## 4. Build

Build as the service user, in its own directory, so nothing in the tree is owned
by root:

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

**Two values are compiled into the bundle and cannot be changed afterwards.**
Get them right or rebuild:

```bash
cd /opt/hookubit/src
VITE_API_TRANSPORT=http \
VITE_INGEST_BASE_URL=https://hooks.example.com \
  pnpm --filter @hookubit/dashboard build

sudo rsync -a --delete apps/dashboard/dist/ /opt/hookubit/web/
```

- `VITE_API_TRANSPORT=http` — **without this the dashboard runs against its
  in-memory mock.** It will look completely functional and touch nothing real.
- `VITE_INGEST_BASE_URL` — the public origin of the ingest API. It is what the
  setup checklist's `curl` example prints. Leave it unset and that example says
  `http://localhost:8080`, which is correct on your laptop and wrong in every
  message you ever paste to someone else.

---

## 5. Secrets and configuration

```bash
sudo install -o hookubit -g hookubit -m 0600 /dev/null /etc/hookubit/hookubit.env
sudo -u hookubit tee /etc/hookubit/hookubit.env >/dev/null <<EOF
APP_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public
DIRECT_DATABASE_URL=postgresql://hookubit:PASSWORD@db.lan:5432/hookubit?schema=public
REDIS_URL=redis://127.0.0.1:6379/0

ENCRYPTION_KEY=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 48)
SESSION_SECRET=$(openssl rand -base64 48)

# Mail. Mailpit for now; see step 9 to swap in a relay.
SMTP_URL=smtp://127.0.0.1:1025
MAIL_FROM=HookuBit <no-reply@example.com>

# The origin the dashboard is served from. Every link in every email is built
# from this — wrong here means mail full of dead links.
DASHBOARD_URL=https://webhooks.example.com
CORS_ORIGINS=https://webhooks.example.com

CONTROL_API_PORT=3000
INGEST_PORT=8080

# EXACTLY the number of reverse proxies in front of each process. One Caddy
# in front of both means 1. At 0 behind a proxy, every request in the world
# shares one per-IP rate-limit bucket, because every request appears to come
# from the proxy.
TRUST_PROXY_HOPS=1
INGEST_TRUSTED_PROXY_HOPS=1

WORKER_CONCURRENCY=32
EOF
```

**Back up `ENCRYPTION_KEY` somewhere that is not the database.** Endpoint
signing secrets are AES-256-GCM ciphertext bound to their row; the key lives
only here. A database backup restored without it produces a platform that
starts, accepts events, and fails every single delivery at signing time.

### If your consumers are on the LAN

This is the one that catches home servers. The SSRF guard refuses to deliver to
private addresses, and in `APP_ENV=production` the blanket override is **refused
outright** — `EGRESS_ALLOW_PRIVATE_NETWORKS=true` will not start.

Name the subnets instead:

```bash
EGRESS_PRIVATE_ALLOWLIST=192.168.1.0/24,10.0.0.0/8
```

A default route (`0.0.0.0/0`) is rejected too — that is the absence of an
allowlist written to look like one. List the subnets you actually deliver to.

### Object storage

There is none configured, and that is fine. The effect is that the maximum
event size becomes the inline limit (64 KiB), and a larger payload is refused
with exactly that reason rather than being silently truncated. Add
`S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` later if
you need bigger events.

---

## 6. Migrate

Migrations are a separate command, never something an app does on start. Run it
by hand now, and on every upgrade:

```bash
cd /opt/hookubit/src/apps/control-api
sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate deploy
```

Check it landed:

```bash
sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate status
```

---

## 7. systemd

### `/etc/systemd/system/hookubit-api.service`

```ini
[Unit]
Description=HookuBit control API
After=network-online.target redis-server.service
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
After=network-online.target redis-server.service
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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hookubit-api hookubit-data-plane
```

### Prove they are up

```bash
curl -s localhost:3000/health/live      # control API
curl -s localhost:9090/health/ready     # data plane, including its database ping
curl -s localhost:9090/metrics | head   # Prometheus, if you want it later
```

`/health/ready` distinguishes `connecting` from `down` for PostgreSQL, which are
different operator stories: one has never opened a pool, the other opened one
and lost it.

---

## 8. The reverse proxy

Caddy, because TLS is one line and there is no certbot cron to forget:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### Public hostname with TLS

`/etc/caddy/Caddyfile`:

```caddyfile
# The dashboard and its API share an origin, so the session cookie is
# first-party and CORS is a formality.
webhooks.example.com {
	handle /v1/* {
		reverse_proxy 127.0.0.1:3000
	}
	handle /health/* {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		root * /opt/hookubit/web
		# Hashed assets are immutable. index.html must never be cached, or a
		# deploy leaves every browser on a stale bundle.
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		header Cache-Control "no-store"
		try_files {path} /index.html
		file_server
	}
}

# Ingest on its own hostname: it is the public write path and has a completely
# different traffic shape from the dashboard.
hooks.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Point both names at your IP, forward 80 and 443, and reload:

```bash
sudo systemctl reload caddy
```

Dynamic residential IP? Use Caddy's DNS-challenge plugin with whatever DNS
provider you use, and a dynamic-DNS updater. The HTTP challenge needs port 80
reachable, which is often the thing your ISP has opinions about.

### LAN only

Caddy will issue an internal CA certificate — usable, but every device has to
trust it:

```caddyfile
webhooks.home.arpa {
	tls internal
	# ...same handle blocks as above
}
```

If you go plain `http://` instead, set `DASHBOARD_URL` and `CORS_ORIGINS` to the
`http://` origin. Sign-in still works — the session cookie is `SameSite` and
HTTP-only rather than `Secure`-only — but anything on the network path can read
it. Fine for a closed lab, not fine for anything else.

Either way, rebuild the dashboard whenever the origin changes:
`VITE_INGEST_BASE_URL` is compiled in.

---

## 9. Mail

Mailpit is a single Go binary and needs no Docker:

```bash
sudo curl -fsSL -o /usr/local/bin/mailpit \
  "https://github.com/axllent/mailpit/releases/latest/download/mailpit-linux-amd64"
sudo chmod +x /usr/local/bin/mailpit
```

`/etc/systemd/system/mailpit.service`:

```ini
[Unit]
Description=Mailpit
After=network.target

[Service]
ExecStart=/usr/local/bin/mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
Restart=on-failure
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now mailpit
```

Read the inbox over an SSH tunnel rather than exposing it:

```bash
ssh -L 8025:127.0.0.1:8025 you@yourserver     # then open http://localhost:8025
```

Verification links, password resets, team invitations and notification-address
confirmations all land there.

### Swapping in a real relay

The moment anyone outside your house needs an invitation or a password reset,
Mailpit stops being enough. A residential IP cannot send mail directly — port 25
is blocked and the address has no reputation — so this is a relay, not a mail
server:

```bash
SMTP_URL=smtp://apikey:SECRET@smtp.resend.com:587
MAIL_FROM=HookuBit <no-reply@yourdomain.com>
```

```bash
sudo systemctl restart hookubit-api
```

Set SPF and DKIM on the sending domain or your mail lands in spam, which for a
verification link is indistinguishable from the feature being broken.

---

## 10. Create the first account

Registration is closed by default. Open it, make your account, close it again:

```bash
sudo sed -i 's/^ALLOW_OPEN_REGISTRATION=.*//' /etc/hookubit/hookubit.env
echo 'ALLOW_OPEN_REGISTRATION=true' | sudo tee -a /etc/hookubit/hookubit.env
sudo systemctl restart hookubit-api
```

Open the dashboard, register, collect the verification link from Mailpit, then:

```bash
sudo sed -i 's/^ALLOW_OPEN_REGISTRATION=true/ALLOW_OPEN_REGISTRATION=false/' /etc/hookubit/hookubit.env
sudo systemctl restart hookubit-api
```

Everyone after you joins by invitation from the Team page.

---

## 11. Backups

Two things, and the second is the one people miss.

```bash
# 1. The database. This is the system of record.
pg_dump --format=custom "$DATABASE_URL" > hookubit-$(date +%F).dump

# 2. The encryption key. SEPARATELY, and not in the same place.
grep ENCRYPTION_KEY /etc/hookubit/hookubit.env
```

A restored database without the matching `ENCRYPTION_KEY` is a working platform
that cannot sign a single webhook. Redis needs no backup — it holds rate-limiter
buckets and nothing else, which is why a Redis outage costs limiter accuracy and
not deliveries.

Point-in-time recovery matters more than snapshot frequency here. The delivery
ledger is the product's answer to "what happened to this event", and a nightly
snapshot throws away up to a day of that answer.

---

## 12. Upgrades

```bash
sudo systemctl stop hookubit-data-plane          # stop taking new work first
cd /opt/hookubit/src && sudo -u hookubit git pull

sudo -u hookubit pnpm install --frozen-lockfile
sudo -u hookubit pnpm generate
sudo -u hookubit pnpm --filter @hookubit/control-api build
cd services/data-plane && sudo -u hookubit go build -o /opt/hookubit/bin/webhookd ./cmd/webhookd
cd /opt/hookubit/src && VITE_API_TRANSPORT=http VITE_INGEST_BASE_URL=https://hooks.example.com \
  sudo -u hookubit pnpm --filter @hookubit/dashboard build
sudo rsync -a --delete apps/dashboard/dist/ /opt/hookubit/web/

cd apps/control-api && sudo -u hookubit env $(grep -v '^#' /etc/hookubit/hookubit.env | xargs -d '\n') \
  pnpm exec prisma migrate deploy

sudo systemctl restart hookubit-api
sudo systemctl start hookubit-data-plane
```

Stopping the data plane first means in-flight deliveries drain against the old
schema rather than mid-migration. Nothing is lost either way — the queue is
PostgreSQL and a delivery not claimed is a delivery still waiting — but it keeps
the logs readable.

---

## Things that will bite you

**The dashboard silently using its mock.** Build without
`VITE_API_TRANSPORT=http` and every screen works, with data that does not exist.
If nothing you create in the dashboard appears in the database, this is why.

**The ingest URL in the setup checklist.** Compiled in at build time. If the
`curl` example says `localhost:8080`, the bundle was built without
`VITE_INGEST_BASE_URL`.

**Proxy hops set to 0 behind a proxy.** Every request appears to come from the
proxy, so the pre-auth rate limiter puts the entire internet in one bucket. Set
`TRUST_PROXY_HOPS` and `INGEST_TRUSTED_PROXY_HOPS` to the exact number of
proxies — 1 for a single Caddy.

**LAN consumers and the SSRF guard.** Covered above. `EGRESS_PRIVATE_ALLOWLIST`,
never `EGRESS_ALLOW_PRIVATE_NETWORKS`, which production refuses.

**Splitting the data plane later.** Every `webhookd` process binds
`DATA_PLANE_METRICS_PORT` (9090) for its probes. Four roles as four units on one
box means three of them fail to bind. Give each a different port:

```ini
Environment=DATA_PLANE_METRICS_PORT=9091
```

**Connection arithmetic.** Each data-plane process opens
`DATABASE_MAX_CONNECTIONS` at startup and **exits if it cannot get them**. An
over-committed pool does not give you slow throughput, it gives you a
crash-looping worker at exactly the moment traffic spiked. `webhookd all` is one
process, so this only matters once you split or scale.

**Per-endpoint isolation is a ceiling, not a reservation.**
`MAX_CONCURRENCY_PER_ENDPOINT` (16) bounds one endpoint's in-flight attempts;
nothing reserves capacity for the others. Six slow endpoints at the default cap
are entitled to a 64-slot pool in its entirety, and your fast endpoints queue
behind them. Lower the cap before you raise the pool.
