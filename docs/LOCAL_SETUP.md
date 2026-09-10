# Running locally, without Docker

Everything except Redis runs as a native process. This is the path to a real
end-to-end delivery: publish an event, watch it fan out, watch it get signed and
sent.

## 0. Prerequisites — check these first

**PostgreSQL 15 or newer.** The schema uses `NULLS NOT DISTINCT` unique indexes,
which 14 and earlier cannot express. The migration refuses to run on an older
server rather than half-applying, so check before anything else:

```bash
psql -h localhost -U postgres -tAc "show server_version;"
```

If that reports 14.x, install a newer server (`brew install postgresql@16`) —
this is the one hard requirement.

Redis you already have. Node 20+, pnpm, and Go 1.21+ are also needed.

**If you cloned before the HookuBit rename**, the dev compose file's Postgres
role, password and database are all `hookubit` now (they were `webhook` /
`webhook_platform`), and the compose project is `hookubit-dev`. Postgres only
runs initdb on an EMPTY data directory, so an existing volume keeps the old
role and the new `DATABASE_URL` fails to authenticate against a server that
looks healthy. Reset it once:

```bash
docker compose -f deployments/compose/docker-compose.dev.yml down -v
```

That deletes only the throwaway dev volume. If you run PostgreSQL natively
instead, nothing changes — point `DATABASE_URL` at whatever role you already
created.

## 1. Create the role and database

```bash
psql -h localhost -U postgres <<'SQL'
CREATE ROLE hookubit WITH LOGIN PASSWORD 'hookubit';
CREATE DATABASE hookubit OWNER hookubit;
SQL
```

Adjust the superuser name if yours differs.

## 2. Generate secrets and write .env

Three secrets are mandatory and validated at boot. `ENCRYPTION_KEY` must decode
to exactly 32 bytes — it is the AES-256-GCM key protecting endpoint signing
secrets, and both the control plane and the Go worker read the same value.

```bash
cd /Users/naj/development/shaq/shaq_webhooks
cp .env.example .env

cat >> .env <<EOT

# --- generated $(date +%F) ---
JWT_SECRET=$(openssl rand -base64 48)
SESSION_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)
EOT
```

Then edit `.env` and confirm:

```
DATABASE_URL=postgresql://hookubit:hookubit@localhost:5432/hookubit?schema=public
DIRECT_DATABASE_URL=postgresql://hookubit:hookubit@localhost:5432/hookubit?schema=public
REDIS_URL=redis://localhost:6379/0
APP_ENV=development
ALLOW_OPEN_REGISTRATION=false
```

## 3. Install, generate the client, migrate

```bash
pnpm install
pnpm generate           # prisma generate
pnpm migrate:deploy     # applies the two committed migrations
```

Use `migrate:deploy`, not `migrate`. The migrations are committed; `migrate dev`
would try to author a new one.

## 4. Create the first owner

There is no default account, by design. Build first — the CLI runs from `dist/`:

```bash
pnpm --filter @hookubit/control-api build

BOOTSTRAP_EMAIL='you@example.com' \
BOOTSTRAP_PASSWORD='a-real-password-12+' \
BOOTSTRAP_ORG='ShaQ Express' \
pnpm --filter @hookubit/control-api bootstrap
```

It refuses to run twice, and creates the organization, the owner and the
membership in one transaction.

## 5. Start the services

**The Go data plane does NOT read `.env`** — it reads the process environment.
Export it in each shell that runs a Go service:

```bash
set -a; source .env; set +a
```

Terminal 1 — control plane on :3000 (OpenAPI at /docs):

```bash
pnpm dev:api
```

Terminal 2 — data plane. `all` runs ingest, router, scheduler and worker in one
process; run them separately if you want to watch a single stage:

```bash
set -a; source .env; set +a
pnpm dev:data-plane            # or: cd services/data-plane && go run ./cmd/webhookd worker
```

Ingest listens on :8080, probes and Prometheus metrics on :9090.

Terminal 3 — dashboard on :5173, against the real API rather than mocks:

```bash
VITE_API_TRANSPORT=http pnpm dev:dashboard
```

Without that variable it serves mock data and shows a red "Demo data" banner.

Terminal 4 — something to deliver to. Any HTTP server that echoes will do:

```bash
python3 -m http.server 8081        # crude; returns 501 for POST, useful for testing retries
```

For a sink that returns 200 and prints what it received:

```bash
node -e '
require("http").createServer((req,res)=>{
  let b="";req.on("data",c=>b+=c);
  req.on("end",()=>{
    console.log("\n---",req.method,req.url);
    console.log("signature:",req.headers["webhook-signature"]);
    console.log("delivery:",req.headers["webhook-delivery-id"],"attempt:",req.headers["webhook-attempt"]);
    console.log(b);
    res.writeHead(200).end("ok");
  });
}).listen(8081,()=>console.log("sink on :8081"));'
```

## 6. Mail: verification links, password reset, invitations

Self-serve signup, forgot-password and team invitations all end in an email
carrying a single-use link, and login refuses an unverified address. With no
transport configured the control plane logs a six-character token prefix and
delivers nothing — deliberately (`apps/control-api/HANDOFF.md`, FIX 5) — so
none of those flows can be finished from the console. Run a catcher:

```bash
docker compose -f deployments/compose/docker-compose.dev.yml up -d mailpit
```

Add to `.env` and restart `pnpm dev:api`:

```
SMTP_URL=smtp://localhost:1025
MAIL_FROM="HookuBit <no-reply@localhost>"
```

Every message lands in the inbox at http://localhost:8025; nothing leaves your
machine. Links are built from `DASHBOARD_URL`, so they open the dashboard from
step 5 at `/verify-email?token=…`, `/reset-password?token=…` and
`/accept-invitation?token=…`.

Gotchas:

- **Both variables or neither.** `SMTP_URL` without `MAIL_FROM` refuses to boot.
  Quote `MAIL_FROM` — the angle brackets are shell syntax if you export it. The
  display name is also the product name the messages use.
- **`SMTP_URL` set means SMTP in every environment**, `APP_ENV=development`
  included. `SMTP_URL` unset under staging or production refuses to boot, by
  name — there is no "quiet" mode outside development/test.
- **The stub is not a fallback for a server that is down.** With `SMTP_URL` set
  and Mailpit stopped you get one warning at boot and an error line per message
  (`Failed to send email_verification to <hash>@domain`), and signup still
  answers 202 — that is deliberate (FIX 3), the response must not say whether
  the address exists. Start Mailpit and use "resend verification" from the
  login screen.
- **The `bootstrap` owner needs none of this.** It is created verified.
- **Only the control plane reads `.env`** (step 5). The Go services do not send
  mail, so there is nothing to export in their shells.
- The link in the message is the only copy of the token; the log carries a
  prefix. Never paste a token out of Mailpit into a ticket.

## 7. Drive the path

Log in through the dashboard at http://localhost:5173, or use the API directly.
**Confirm exact request shapes at http://localhost:3000/docs** — the OpenAPI
document is generated from the controllers and is authoritative; it is served in
every environment except production.

The order is:

1. Log in — session is an HTTP-only cookie, so use `curl -c/-b` a cookie jar.
2. `POST /v1/organizations/:orgId/projects` — note the id and `environment`.
3. `POST /v1/projects/:projectId/api-keys` — **the plaintext key is returned
   exactly once.** Copy it now; it is stored only as a hash.
4. `POST /v1/projects/:projectId/endpoints` with `url: http://localhost:8081/hook`.
   As an owner you get the signing secret back once. Copy it.
5. `POST /v1/projects/:projectId/subscriptions` binding that endpoint to
   `["*"]` or a specific type.
6. Publish, against the **ingest port 8080**, not the control API:

```bash
curl -sS -X POST http://localhost:8080/v1/projects/<PROJECT_ID>/events \
  -H "Authorization: Bearer <THE_API_KEY>" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.50}}'
```

A `202 {"id":"evt_...","status":"accepted"}` means durably persisted, not
delivered. Within a poll interval the router materialises a delivery row and the
worker signs and sends it — you should see it arrive at the sink with
`Webhook-Signature: t=...,v1=...`.

## 8. Verify the signature the way a consumer would

```
HMAC-SHA256(secret, "<t>.<exact raw body bytes>")
```

compared in constant time against any `v1=` value. During a rotation window
there will be two `v1=` components, one per active secret.

## 9. Prove the dashboard against the real stack

`apps/dashboard/e2e/` is a Playwright journey that exercises every dashboard
control against the running control API, data plane and Mailpit - the mock
transport proves nothing here, so the runner starts Vite with
`VITE_API_TRANSPORT=http` and a local webhook receiver on `127.0.0.1:9797`.

It expects, beyond section 5: the control API started with
`ALLOW_OPEN_REGISTRATION=true` (it registers a fresh account per run and reads
the verification link from Mailpit), and `EGRESS_ALLOW_PRIVATE_NETWORKS=true`
on both planes (the receiver is a loopback address).

```bash
pnpm --filter @hookubit/dashboard test:e2e
pnpm --filter @hookubit/dashboard exec playwright show-report   # traces and video for any failure
```

Two things bite on repeated runs from one machine. Registration is throttled at
5 per hour and sign-in at 10 per 15 minutes per address, and the buckets live in
Redis when it is up; a dev-only reset is
`docker exec <redis> sh -c "redis-cli --scan --pattern 'throttle:auth.*' | xargs -r redis-cli DEL"`.
And each run leaves its account and organization behind on purpose - they are
what the audit log and retention are for.

## Where to look when it does not work

```bash
psql "$DATABASE_URL" -c "select id,status,payload_hash from events order by created_at desc limit 5;"
psql "$DATABASE_URL" -c "select id,status,attempt_count,next_attempt_at,last_error from deliveries order by created_at desc limit 5;"
psql "$DATABASE_URL" -c "select delivery_id,attempt_number,status,http_status,duration_ms,error_message from delivery_attempts order by created_at desc limit 10;"
curl -s localhost:9090/metrics | grep -E 'events_ingested|deliveries_|outbox_pending'
```

- Event accepted but no delivery row → the router. Check `event_outbox.status`
  and whether a subscription actually matches the event type.
- Delivery row stuck `pending` → the worker is not claiming. Check it is running
  and that `ENCRYPTION_KEY` is exported in its shell.
- Attempts recorded with a signature the consumer rejects → the NestJS/Go crypto
  or signing contract. This is the least-tested seam in the system.
- Registered (202) but no mail → `SMTP_URL` is unset (the stub logs
  `[dev-mailer] … token abc123…` and sends nothing) or Mailpit is down (the
  control-api log has `SMTP transport … could not be verified at boot` and a
  `Failed to send …` line per message). `curl -s localhost:8025/api/v1/messages`
  shows what the catcher actually received.

## The documentation site

`apps/docs` is the customer-facing documentation (VitePress). It needs nothing
running - no database, no API:

```bash
pnpm docs:dev      # http://localhost:4000
pnpm docs:build    # what CI runs: regenerates the API reference, then builds with dead-link checking ON
```

The API reference under `apps/docs/api/` is generated from
`apps/control-api/openapi.json`, which `pnpm --filter @hookubit/control-api openapi`
emits from source. Do not edit the generated pages; change the DTO decorators
and rebuild. A build failure naming a dead link is a real broken link - fix the
link, not the check.
