# Convoy webhooks gateway — dev install runbook

**Status:** running and verified end-to-end on the shared dev server.
**Installed:** 2026-09-06.
**Purpose:** route payment settlement events from `shaq_payment_gateway` to the ops API
and the finance API, with per-endpoint HMAC, automatic retries, and a replayable delivery log.
The provider's inbound callback stays direct to the gateway and does **not** go through Convoy.

> This document is both the record of what was done on dev and the template for doing it
> properly in production. Read [§9 Production](#9-what-must-be-different-in-production) before
> copying any of this to a production host — several dev choices are deliberately not
> production-safe.

---

## 1. Host and topology

Dev server: `ec2-54-226-22-32.compute-1.amazonaws.com` (Ubuntu 24.04, arm64, 2 vCPU, 3.8 GB RAM).

This is a **shared** box. Four other dev services deploy here
(`shaq_express_partner_dev`, `shaq-express`, `finance-api-dev`, `shaq_accounts_api_dev`), plus a
host PostgreSQL 16, a host Redis 7.4.2, MySQL, Meilisearch, nginx, and two pre-existing
containers (`local-pgbouncer-1`, `local-redis_server-1`). Nothing belonging to those services was
restarted, reconfigured or modified.

```
                    host: ec2-54-226-22-32
  ┌───────────────────────────────────────────────────────────────┐
  │                                                               │
  │  PostgreSQL 16 (host process)                                 │
  │    listen_addresses = localhost,172.17.0.1                    │
  │    db "convoy", role "convoy"       ◄──────┐                  │
  │                                            │                  │
  │  Redis 7.4.2 (host process, 0.0.0.0:6379)  │                  │
  │    db 0,1 = other apps                     │                  │
  │    db 9   = convoy only             ◄──────┤                  │
  │                                            │ 172.17.0.1       │
  │  docker0 bridge 172.17.0.0/16              │ (docker0 gw)     │
  │  ┌─────────────────────────────────────────┴───────────────┐  │
  │  │  convoy-server  (control plane: REST API + UI, :5005)   │  │
  │  │  convoy-agent   (data plane: workers + dispatch, :5008) │  │
  │  └─────────────────────────────────────────────────────────┘  │
  │        │ published on 127.0.0.1 ONLY                          │
  └────────┼──────────────────────────────────────────────────────┘
           │
      reachable only over an SSH tunnel
```

**Why containers reach Postgres at `172.17.0.1`.** The host Postgres already listens on the
docker0 gateway address in addition to loopback, and `pg_hba.conf` already carried
`host convoy convoy 172.17.0.1/16 md5`. Containers therefore reach it directly with no change to
any shared config. This is also why both containers run with `network_mode: bridge` (the default
docker0 network) rather than a compose-created network: a new compose network would have been
allocated `172.20.0.0/16`, which is **not** in `pg_hba.conf`, and adding it would have meant
editing shared Postgres config. Using docker0 avoided that entirely.

---

## 2. What is deployed

| Item | Value |
|---|---|
| Image | `getconvoy/convoy@sha256:0d269f05bb3816c0e73f6b3e396bdbfb6eb8d3c7ba61e8633ce9e360210042c4` |
| Version reported | `main-d2f6dfb` (upstream tag `release-cutoff-2026-04-18-gd2f6dfb6`) |
| Convoy API version | `2025-11-24` |
| Deploy dir | `/opt/convoy` (root-owned) |
| Compose file | `/opt/convoy/docker-compose.yml` |
| Config | `/opt/convoy/convoy.json` (0644, non-secret) |
| Secrets | `/opt/convoy/convoy.env` (0600 root:root) |
| Control plane | `convoy-server` → `127.0.0.1:5005` |
| Data plane | `convoy-agent` → `127.0.0.1:5008` |
| Database | host Postgres 16, database `convoy`, schema `convoy`, role `convoy` |
| Queue/cache | host Redis, **db index 9** |
| Restart | `unless-stopped`; `docker.service` is `enabled` → survives reboot |
| Limits | 512 MB memory, 0.75 CPU per container |
| Log rotation | json-file, 10 MB × 3 per container |

Actual footprint at idle: ~30 MB RAM and 4 Postgres connections for both containers combined.

**The image tag is `latest` resolved to a digest.** `getconvoy/convoy:latest` was already present
on the host. It is pinned **by digest** in the compose file so a redeploy cannot silently pull a
different build. It is a `main` branch build, not a tagged release — see §9.

---

## 3. Config surface that matters

Convoy loads config in this order (`config.LoadConfig`): built-in defaults → JSON config file if
it exists → environment variables (`envconfig`) → CLI flags. Later wins. The config file is
optional; env vars alone work. Here the split is deliberate:

* `/opt/convoy/convoy.json` — everything non-secret, world-readable, safe to copy into git.
* `/opt/convoy/convoy.env` — only secrets, `0600 root:root`, injected via `env_file`.

### `/opt/convoy/convoy.json`

| Key | Value | Why |
|---|---|---|
| `env` | `oss` | Convoy's own default (`OSSEnvironment`). Not "production" — that string is not a valid environment for this build. |
| `host` | `http://localhost:5005` | Base URL used to build links. Must become the real external URL in prod. |
| `logger.level` | `warn` | At `info` the agent logs an ingest-ticker line ~4×/second (~130 MB/day) onto a **shared** disk. `warn` keeps errors and warnings and drops the noise. Set back to `info` when debugging deliveries. |
| `analytics.enabled` | `false` | Do not phone telemetry home from an internal dev box. |
| `consumer_pool_size` | `10` | Default is 100 worker goroutines. On a 2-vCPU shared host that is far too aggressive; 10 is ample for dev volume. |
| `database.host` / `port` | `172.17.0.1` / `5432` | docker0 gateway — the host Postgres, reached without touching shared config. |
| `database.options` | `sslmode=disable&connect_timeout=30` | Loopback-only traffic on dev. **Must change in prod** (§9). |
| `database.max_open_conn` | `10` | Unbounded by default. Two components × 10 = hard ceiling of 20 of the host's 100 `max_connections`, so Convoy can never starve the other four services. |
| `database.max_idle_conn` | `2` | Keeps idle connection count low on a shared server. |
| `redis.host` / `port` | `172.17.0.1` / `6379` | Host Redis. |
| `redis.database` | `"9"` | **Isolation.** db 0 (848 keys) and db 1 (13 keys) belong to the other apps; db 9 was empty and is now Convoy-only. Redis has **no password** (`requirepass` unset, `protected-mode no`) — see §8. |
| `server.http.port` | `5005` | Control plane: REST API + Angular UI. |
| `server.http.agent_port` | `5008` | Data plane health/metrics. |
| `server.http.ssl` | `false` | TLS terminates elsewhere; dev is loopback-only. |
| `auth.native.enabled` | `true` | Enables project API keys (`CO.xxx`), which is how the gateway will authenticate. |
| `auth.jwt.enabled` | `true` | UI login. Secrets come from the env file. |
| `auth.is_signup_enabled` | `false` | No self-service registration on a shared box. |

### `/opt/convoy/convoy.env` (0600)

```
CONVOY_DB_PASSWORD=…
CONVOY_JWT_SECRET=…            # 96 hex chars
CONVOY_JWT_REFRESH_SECRET=…    # 96 hex chars
```

Env names map 1:1 to the JSON keys via `envconfig` tags in `config/config.go`. Anything in the
JSON file can be overridden with an env var; secrets should only ever be set this way.

> Beware two generically-named env vars this build honours: `PORT`, `SSL`, `HTTP_PROXY` and
> `NO_PROXY` are read straight from the environment. Do not set them for other reasons in a
> Convoy container.

---

## 4. Exact steps taken, in order

Everything below is reproducible from a clean host, in this order.

### 4.1 Inspect before touching anything

```bash
docker images | grep convoy
docker image inspect getconvoy/convoy:latest --format '{{json .RepoDigests}}'
docker run --rm --entrypoint /cmd getconvoy/convoy:latest version     # -> main-d2f6dfb
docker run --rm --entrypoint /cmd getconvoy/convoy:latest --help      # subcommands for THIS build

sudo ss -lntp                                  # what is already listening
sudo grep listen_addresses /etc/postgresql/16/main/postgresql.conf
sudo grep -v '^\s*#' /etc/postgresql/16/main/pg_hba.conf
redis-cli -h 127.0.0.1 -p 6379 info keyspace   # which redis DBs are in use
docker network ls                              # which container subnets already exist
```

This build exposes `server`, `agent`, `migrate`, `bootstrap`, `backup`, `retry`, `config`,
`utils`. It does **not** have the separate `worker` / `scheduler` / `ingest` commands that
Convoy's own `configs/docker-compose.templ.yml` still references — that template is stale for
this version. `server` = control plane (API + UI + scheduler), `agent` = data plane (consumer
pool + HTTP dispatch). You need both.

### 4.2 Back up everything you might touch

```bash
sudo mkdir -p /var/backups/convoy && sudo chmod 777 /var/backups/convoy
TS=$(date +%Y%m%d-%H%M%S)
sudo -u postgres pg_dump -Fc -d convoy -f /var/backups/convoy/convoy-pre-rebuild-$TS.dump
sudo cp -a /etc/convoy/convoy.json                  /var/backups/convoy/etc-convoy.json.$TS
sudo cp -a /etc/postgresql/16/main/pg_hba.conf      /var/backups/convoy/pg_hba.conf.$TS
sudo chmod 700 /var/backups/convoy
```

### 4.3 Database and role

A dedicated `convoy` database and `convoy` role already existed from an earlier abandoned
attempt (an apt-installed Convoy, since removed). The database was **empty of real data**
(0 orgs, 0 projects, 0 events) and dedicated to Convoy, so it was reused rather than dropped.
Its password had leaked into `~/.bash_history` in plaintext, so it was rotated:

```bash
# generate
DBPASS=$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)

# rotate + pin least privilege
sudo -u postgres psql -c "ALTER ROLE convoy WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE \
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30 PASSWORD '$DBPASS';"

# convoy's migrations use gen_random_uuid()
sudo -u postgres psql -d convoy -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

On a **fresh** host, create it instead:

```bash
sudo -u postgres psql -c "CREATE ROLE convoy WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE \
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30 PASSWORD '$DBPASS';"
sudo -u postgres psql -c "CREATE DATABASE convoy OWNER convoy ENCODING 'UTF8';"
sudo -u postgres psql -d convoy -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

`CONNECTION LIMIT 30` is a second, server-side backstop on top of `max_open_conn` so a Convoy
bug can never exhaust the shared connection pool.

Verify the container can actually authenticate **before** deploying anything:

```bash
docker run --rm --network bridge -e PGPASSWORD="$DBPASS" postgres:15.2-alpine \
  psql -h 172.17.0.1 -p 5432 -U convoy -d convoy -tAc "select current_user, inet_client_addr()"
docker run --rm --network bridge redis:7-alpine redis-cli -h 172.17.0.1 -p 6379 -n 9 ping
```

### 4.4 Write config

`/opt/convoy/convoy.json` as in §3, plus:

```bash
sudo install -d -m 755 -o root -g root /opt/convoy
sudo tee /opt/convoy/convoy.env >/dev/null <<EOF
CONVOY_DB_PASSWORD=$DBPASS
CONVOY_JWT_SECRET=$(openssl rand -hex 48)
CONVOY_JWT_REFRESH_SECRET=$(openssl rand -hex 48)
EOF
sudo chown root:root /opt/convoy/convoy.env && sudo chmod 600 /opt/convoy/convoy.env
```

### 4.5 Compose file

`/opt/convoy/docker-compose.yml` — the shape that matters:

* image pinned **by digest**, `pull_policy: missing`
* `network_mode: bridge` (docker0 → `172.17.0.0/16`, the subnet `pg_hba.conf` allows)
* ports published as `127.0.0.1:5005:5005` and `127.0.0.1:5008:5008` — **loopback only**
* `env_file: /opt/convoy/convoy.env`, config bind-mounted read-only
* `security_opt: no-new-privileges:true`, `cap_drop: ALL`
* `mem_limit: 512m`, `memswap_limit: 512m`, `cpus: 0.75` per container
* `restart: unless-stopped`
* healthchecks hitting `/healthz` on each port
* a `migrate` service under the `tools` profile so it never starts with `up -d`

Validate before applying: `docker compose -f /opt/convoy/docker-compose.yml config`.

### 4.6 Migrate, then start

Migrations are a **separate step** in this build — the server does not run them.

```bash
sudo docker compose -f /opt/convoy/docker-compose.yml --profile tools run --rm migrate
# -> "Applied 3 migration(s)" / "Migration completed successfully."
sudo docker compose -f /opt/convoy/docker-compose.yml up -d
```

Result: 74 rows in `convoy.gorp_migrations`, both containers `healthy`.

### 4.7 First admin account — read this, it is a security issue

**On first start with an empty `users` table, this build silently creates a superuser
`superuser@default.com` with the hardcoded password `default`** (`cmd/hooks/hooks.go`,
`ensureDefaultUser`). It is a working login with full access. On any host where the UI is
reachable by anyone else, this is a live default credential.

Two upstream defects were hit here and are worth knowing:

1. **`convoy bootstrap` panics in this build.** It creates the user, then segfaults on a nil
   `Licenser` at `services/create_organisation.go:38` — so it leaves an orphan user, no
   organisation, and never prints the generated password. Do not use it.
2. **The OSS/community licence allows exactly 1 user, 1 organisation, 2 projects.** With the
   auto-created superuser occupying the only slot, `POST /ui/auth/register` and `bootstrap` both
   fail with *"your instance has reached it's user limit"*. There is no second admin without a
   commercial licence.

The working path is therefore: **log in as the auto-created superuser and immediately change its
password**, which is what was done here.

```bash
# 1. log in with the default credential and capture the JWT
TOKEN=$(curl -s -X POST http://127.0.0.1:5005/ui/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"superuser@default.com","password":"default"}' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

# 2. rotate the password immediately  (USERID from the login response "uid")
NEWPW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)'Aa1!'
curl -s -X PUT "http://127.0.0.1:5005/ui/users/$USERID/password" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"current_password\":\"default\",\"password\":\"$NEWPW\",\"password_confirmation\":\"$NEWPW\"}"

# 3. give it a real identity
curl -s -X PUT "http://127.0.0.1:5005/ui/users/$USERID/profile" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"first_name":"Najib","last_name":"Alhassan","email":"najib@shaqexpress.com"}'

# 4. confirm the default credential is dead — must return "Invalid credentials"
curl -s -X POST http://127.0.0.1:5005/ui/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"superuser@default.com","password":"default"}'
```

`is_signup_enabled` is `false` in the config, and the user limit blocks registration anyway.
Both were verified.

### 4.8 Organisation, project, endpoint, subscription

```bash
# organisation
curl -s -X POST http://127.0.0.1:5005/ui/organisations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Shaq Express"}'

# project — response contains the project API key (CO.xxx). It is shown ONCE.
curl -s -X POST "http://127.0.0.1:5005/ui/organisations/$ORG/projects" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "name":"payments-settlement-dev","type":"outgoing",
    "config":{
      "strategy":{"type":"exponential","duration":5,"retry_count":5},
      "signature":{"header":"X-Convoy-Signature","versions":[{"hash":"SHA256","encoding":"hex"}]},
      "replay_attacks_prevention_enabled":true,
      "disable_endpoint":false
    }}'

# endpoint — one per consumer, each with its own HMAC secret
HMAC=$(openssl rand -hex 32)
curl -s -X POST "http://127.0.0.1:5005/api/v1/projects/$PROJ/endpoints" \
  -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"ops-api-dev\",\"url\":\"https://…/webhooks/convoy\",\"secret\":\"$HMAC\",
       \"http_timeout\":10,\"rate_limit\":100,\"rate_limit_duration\":60}"

# subscription — routes events to that endpoint
curl -s -X POST "http://127.0.0.1:5005/api/v1/projects/$PROJ/subscriptions" \
  -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"ops-api-dev-settlements\",\"endpoint_id\":\"$EP\"}"
```

From then on the gateway publishes with the **project API key**, not a user JWT:

```bash
# route to every subscription in the project
POST /api/v1/projects/{projectID}/events/broadcast
{"event_type":"payment.settled","idempotency_key":"…","data":{…}}

# or target one endpoint explicitly
POST /api/v1/projects/{projectID}/events
{"event_type":"payment.settled","endpoint_id":"…","idempotency_key":"…","data":{…}}
```

`POST /events` **requires** `endpoint_id` in this build — omitting it queues successfully and
then fails asynchronously in the worker with `please provide an endpoint ID`, with no event row
ever written. Use `/events/broadcast` for real routing.

---

## 5. Verification performed

All of the following were run and passed on 2026-09-06.

| Check | Result |
|---|---|
| `docker compose ps` | both containers `Up (healthy)` |
| `GET 127.0.0.1:5005/healthz` | `{"status":true,"message":"Convoy main-d2f6dfb"}` |
| `GET 127.0.0.1:5008/healthz` | `{"status":true,"message":"Convoy main-d2f6dfb"}` |
| UI root `GET 127.0.0.1:5005/` | `200` |
| Migrations | 74 rows in `convoy.gorp_migrations`, "Applied 3 migration(s)" |
| Postgres auth from container | connects as `convoy` from `172.17.0.2` |
| Old leaked DB password | now rejected — `password authentication failed` |
| Redis isolation | Convoy keys only in db 9 (19 keys); db 0/1 untouched |
| External reachability | `http://172.31.19.91:5005/healthz` → no connection (loopback bind holds) |
| Default credential | `superuser@default.com` / `default` → `Invalid credentials` |
| Self-signup | refused |
| **Event delivery (direct)** | HTTP 200 at receiver, `event_deliveries.status = Success` |
| **Event delivery (broadcast)** | HTTP 200 at receiver, `event_deliveries.status = Success` |
| **HMAC signature** | verified byte-for-byte (below) |
| **Replay** | `POST /eventdeliveries/forceresend` → "1 successful, 0 failed", redelivered, 3rd attempt row written |
| Crash recovery | `kill -9` of the container's host PID → auto-restarted, `RestartCount=1`, healthy |
| Boot survival | `systemctl is-enabled docker` → `enabled`; restart policy `unless-stopped` |
| Shared services | pgbouncer + redis containers still `Up`; nginx/postgresql/redis/mysql all `active`; 1.5 GB RAM still free |

### The end-to-end test

A throwaway `node:22-alpine` container on the docker0 bridge logged the full request, then a real
event was pushed through. Delivered headers:

```
user-agent: Convoy/main-d2f6dfb
content-type: application/json
x-convoy-idempotency-key: smoke-broadcast-1
x-convoy-signature: t=1788691390,v1=5caee2152cd67d50b5b772ff99bd853d21e3705961ea03237b4c07da8436135d
```

**Signature scheme (this is what the consumers must implement).** With
`replay_attacks_prevention_enabled: true`, the signed string is `"<timestamp>,<raw body>"` and the
digest is hex HMAC-SHA256 keyed on the endpoint secret. Verified:

```bash
printf '%s' "1788691390,{\"settlement_id\":\"SET-DEV-0002\",…}" \
  | openssl dgst -sha256 -hmac "$ENDPOINT_SECRET" -r
# 5caee2152cd67d50b5b772ff99bd853d21e3705961ea03237b4c07da8436135d   <- matches v1= exactly
```

Consumers must verify against the **raw request body** (before JSON parsing) and must reject a
`t=` outside an acceptable clock skew window.

The throwaway receiver container has been removed. The project, endpoint and subscription it used
are still present and are smoke-test artifacts — repoint or delete the `ops-api-dev` endpoint when
wiring the real consumers, otherwise broadcast events will retry against a dead address.

---

## 6. Day-to-day operation

```bash
# reach the UI from your laptop (there is NO public port — this is by design)
ssh -i ~/.ssh/shaq-adminn-dev.pem -L 5005:127.0.0.1:5005 \
    ubuntu@ec2-54-226-22-32.compute-1.amazonaws.com
# then open http://localhost:5005

# status / logs
sudo docker compose -f /opt/convoy/docker-compose.yml ps
sudo docker logs -f convoy-server
sudo docker logs -f convoy-agent

# apply a config change
sudo vi /opt/convoy/convoy.json
sudo docker compose -f /opt/convoy/docker-compose.yml up -d --force-recreate

# turn logging back up while debugging a delivery, then turn it back down
#   "logger": { "level": "info" }   <- ~130 MB/day on a SHARED disk. Do not leave it on.

# delivery log / replay
psql: select id,status,created_at from convoy.event_deliveries order by created_at desc limit 20;
POST /api/v1/projects/{proj}/eventdeliveries/forceresend   {"ids":["<delivery id>"]}
POST /api/v1/projects/{proj}/eventdeliveries/batchretry
```

---

## 7. How to verify a healthy install

Run all six; any failure means do not trust the install.

```bash
# 1 both containers healthy
sudo docker compose -f /opt/convoy/docker-compose.yml ps          # expect Up (healthy) ×2

# 2 both planes answer
curl -s http://127.0.0.1:5005/healthz && curl -s http://127.0.0.1:5008/healthz

# 3 schema is current — no pending migrations
sudo docker compose -f /opt/convoy/docker-compose.yml --profile tools run --rm migrate

# 4 not exposed beyond loopback
sudo ss -lntp | grep -E '5005|5008'                               # expect 127.0.0.1 only

# 5 redis still isolated
redis-cli -h 127.0.0.1 -p 6379 info keyspace                      # convoy keys only in db9

# 6 a real event still gets delivered  (see §5; use a scratch receiver + broadcast)
sudo -u postgres psql -d convoy -c \
  "select status,count(*) from convoy.event_deliveries group by 1;"
```

---

## 8. Security posture on dev — what is and is not acceptable

**Done here**

* Nothing binds beyond `127.0.0.1`. No AWS security-group rule is needed and none was requested.
* Dedicated Postgres database and role; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS`, `CONNECTION LIMIT 30`.
* Generated 32-char DB password and two 96-hex-char JWT secrets; secrets only in a `0600
  root:root` env file, never in the repo.
* Rotated the DB password that had leaked into shell history; old password confirmed dead.
* Neutralised the `superuser@default.com` / `default` default credential.
* Self-signup disabled.
* Containers run `no-new-privileges`, `cap_drop: ALL`, with memory/CPU limits and log rotation.
* Stale `/etc/convoy/convoy.json` (world-readable, containing the old password and a JWT secret)
  tightened to `0700 /etc/convoy` + `0600` on the file.

**Known exposures — flagged, deliberately not changed**

1. **Redis has no password**, `bind 0.0.0.0`, `protected-mode no`. Anything that can reach port
   6379 has full access to every DB on it, Convoy's queue included. This is **pre-existing** and
   shared with four other services; fixing it means restarting Redis and reconfiguring all of
   them, which was out of scope. Today only the AWS security group stands between that port and
   the internet. **Verify the SG does not expose 6379 (or 5432/6432).**
2. **`pg_hba.conf` uses `md5`** for the two convoy rules, not `scram-sha-256`. It works — Postgres
   16 negotiates SCRAM anyway when the stored verifier is SCRAM — so it was left alone rather than
   touching shared config. The CIDR in one rule, `172.17.0.1/16`, has host bits set; it behaves as
   `172.17.0.0/16`. Both should be cleaned up during a planned Postgres maintenance window.
3. **The `convoy` role can still `CONNECT` to the other databases** on that server, because
   `PUBLIC` holds the default `CONNECT` grant on them. It cannot read any table it has no grant
   on. Closing this properly means `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC` on each shared
   database — a change to shared services, so it was **not** done. Do it in production.
4. **The old DB password is still in `~ubuntu/.bash_history`** in plaintext (rotated, so it no
   longer authenticates, but it should be scrubbed). Left for the account owner to remove.
5. The `X-Convoy-Signature` timestamp only protects against replay if consumers actually enforce
   a skew window. That is on the consumer side.

---

## 9. What must be different in production

Everything in this list is a dev-only compromise. None of it should be carried over.

| Dev (here) | Production |
|---|---|
| `getconvoy/convoy:latest` — a `main`-branch build (`main-d2f6dfb`) pinned to a digest | Pin an actual **released tag**, digest-pinned, and record the version in this doc. A `main` build is untested for production and has already shown two real defects (see §4.7). |
| Shared host Redis, no auth, `bind 0.0.0.0`, db index 9 | **Dedicated Redis** (ElastiCache or its own instance): `requirepass`/ACL user, TLS (`rediss://`), private subnet, no public route. Convoy's queue is delivery state — sharing it with app caches means an app `FLUSHALL` destroys in-flight webhooks. |
| Shared host Postgres, `sslmode=disable`, `md5` in `pg_hba.conf` | **Dedicated Postgres** (RDS): `sslmode=verify-full` with a pinned CA, `scram-sha-256`, private subnet, no `PUBLIC` `CONNECT`. Convoy stores every event body and delivery attempt — plan capacity and retention. |
| Everything on one 2-vCPU shared box next to four other services | Its own host(s). Convoy's own compose template and CI both assume dedicated infrastructure. |
| Bound to `127.0.0.1`, reached over an SSH tunnel | Behind an ALB/nginx with **TLS**, an ACM cert, and access control on the UI (VPN/SSO/IP allow-list). The `/api/v1` ingest path and the UI have very different audiences — do not expose the UI publicly. Set `host` to the real external URL. Requires an AWS **security-group rule** for 443 only; never open 5005/5008. |
| Secrets in a `0600` file on disk | **AWS Secrets Manager / SSM Parameter Store**, injected at task start. This build also supports HCP Vault natively (`CONVOY_HCP_*`). Rotate the DB password and JWT secrets on a schedule. |
| No backups of the Convoy database | Automated backups + PITR on the Postgres instance, **with a tested restore**. Convoy also ships `convoy backup` for events/deliveries/attempts and has a retention policy (`CONVOY_RETENTION_POLICY`, default 720h, disabled) — enable it or the events table grows without bound. |
| Single `server` + single `agent` | **HA**: ≥2 `server` replicas behind the LB and ≥2 `agent` replicas. Both are stateless; all coordination is in Postgres + Redis. Raise `consumer_pool_size` from 10 to match real throughput and size `max_open_conn` accordingly (`replicas × max_open_conn` must stay well under Postgres `max_connections`). |
| 512 MB / 0.75 CPU, chosen to protect neighbours | Size from measured load. Keep explicit limits — an unbounded consumer pool will happily eat the box. |
| `logger.level: warn` to protect a shared disk | `info`, shipped to CloudWatch/Loki. Also enable the `prometheus` feature flag + `metrics.enabled` and alert on: `event_deliveries` stuck in non-`Success`, delivery attempt failure rate, queue depth in Redis, and agent liveness. |
| `analytics.enabled: false` | Keep it false. |
| No licence — community limits apply | See below. This is the decision that most affects the design. |
| `enforce_secure_endpoints: false` (allows plain-HTTP endpoints) | `true`. Consumers must be HTTPS. |
| `is_signup_enabled: false`, one shared superuser | Same, plus SSO if licensed. Personal API keys per operator rather than a shared login. |

### The community-licence limits are a design constraint, not a footnote

With no licence key this build runs a **community licenser**: **1 organisation, 1 user,
2 projects**, and the following features are **off**:

`advanced_subscriptions`, `webhook_transformations`, `advanced_webhook_filtering`,
`advanced_endpoint_mgmt`, `circuit_breaking`, `consumer_pool_tuning`, `portal_links`,
`webhook_analytics`, `read_replica`, `credential_encryption`, `ip_rules`, `mutual_tls`,
`webhook_archiving` (retention), `export_prometheus_metrics`, `enterprise_sso`, `google_oauth`,
`oauth2_endpoint_auth`, `static_ip`, `agent_execution_mode`, `use_forward_proxy`,
`asynq_monitoring`, `datadog_tracing`, `custom_certificate_authority`.

Three of those bite us directly:

1. **`advanced_subscriptions` — event-type filtering does not work.** A subscription created with
   `filter_config.event_types: ["payment.settled"]` comes back as `["*"]`; the filter is silently
   discarded (`services/create_subscription.go:91`). **Every subscription in a project receives
   every event in that project.** So the intended "ops API gets settlement events, finance API
   gets a different subset" routing is not achievable on the community licence. Options: (a) buy a
   licence; (b) use two projects, one per consumer, and have the gateway publish to each — this
   fits within the 2-project limit but means the gateway, not Convoy, owns routing, and leaves no
   headroom for a third consumer; (c) let both consumers receive everything and filter on their
   side — cheap, but wasteful and it puts correctness in two more places.
2. **`credential_encryption` is off** — endpoint HMAC secrets are stored **in plaintext** in
   `convoy.endpoints`. Anyone with read access to the database can forge signed webhooks to your
   consumers. This is a strong argument for a licence, and a hard requirement for a dedicated,
   encrypted, tightly-scoped production database.
3. **`export_prometheus_metrics` is off** — no first-class metrics endpoint without a licence, so
   monitoring has to be built from health checks and database queries.

**Recommendation: price a Convoy licence before this goes to production.** If the answer is no,
option (b) — one project per consumer — is the design to build against, and it should be decided
now, because it changes the gateway's publishing code.

---

## 10. Rollback

Convoy is fully self-contained: two containers, one directory, one database, one Redis DB index.
Nothing else on the host depends on it, so rollback is clean.

**Stop it (reversible, keeps all data)**

```bash
sudo docker compose -f /opt/convoy/docker-compose.yml down
# start again with:
sudo docker compose -f /opt/convoy/docker-compose.yml up -d
```

**Roll back a bad config change**

```bash
sudo cp /var/backups/convoy/convoy.json.<TS> /opt/convoy/convoy.json
sudo docker compose -f /opt/convoy/docker-compose.yml up -d --force-recreate
```

Take a copy into `/var/backups/convoy/` before every config edit.

**Roll back a bad migration / restore the database**

```bash
sudo docker compose -f /opt/convoy/docker-compose.yml down
sudo docker compose -f /opt/convoy/docker-compose.yml --profile tools run --rm \
     --entrypoint /cmd convoy migrate down --config /convoy.json     # one step down
# or restore wholesale:
sudo -u postgres pg_restore -d convoy --clean --if-exists \
     /var/backups/convoy/convoy-pre-rebuild-<TS>.dump
```

**Remove it entirely**

```bash
sudo docker compose -f /opt/convoy/docker-compose.yml down
sudo rm -rf /opt/convoy
redis-cli -h 127.0.0.1 -p 6379 -n 9 FLUSHDB        # db 9 is convoy-only — verify first
sudo -u postgres psql -c "DROP DATABASE convoy;"   # take a pg_dump first
sudo -u postgres psql -c "DROP ROLE convoy;"
sudo rm -rf /etc/convoy                            # stale leftovers from the old apt install
```

Nothing in the rollback path touches Postgres, Redis, pgbouncer or any of the four dev
applications. The only shared-resource footprint to clean is Redis db 9 and the `convoy`
database/role.

---

## 11. Credentials generated

Secrets are recorded in the handover message that accompanied this document, **not here**. Store
them in the team password manager and keep them out of this repo. The live copies on the server
live in `/opt/convoy/convoy.env` (`0600 root:root`), except the project API key, which Convoy
displays exactly once at project creation.

| Secret | Where it lives |
|---|---|
| Postgres role `convoy` password | `/opt/convoy/convoy.env` → `CONVOY_DB_PASSWORD` |
| JWT secret / refresh secret | `/opt/convoy/convoy.env` |
| Convoy admin UI password | password manager only |
| Project API key (`CO.…`) | password manager; used by the gateway to publish |
| Endpoint HMAC secret | password manager; shared with that one consumer only |
