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

## 1. Create the role and database

```bash
psql -h localhost -U postgres <<'SQL'
CREATE ROLE webhook WITH LOGIN PASSWORD 'webhook';
CREATE DATABASE webhook_platform OWNER webhook;
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
DATABASE_URL=postgresql://webhook:webhook@localhost:5432/webhook_platform?schema=public
DIRECT_DATABASE_URL=postgresql://webhook:webhook@localhost:5432/webhook_platform?schema=public
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
pnpm --filter @webhook/control-api build

BOOTSTRAP_EMAIL='you@example.com' \
BOOTSTRAP_PASSWORD='a-real-password-12+' \
BOOTSTRAP_ORG='ShaQ Express' \
pnpm --filter @webhook/control-api bootstrap
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

## 6. Drive the path

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

## 7. Verify the signature the way a consumer would

```
HMAC-SHA256(secret, "<t>.<exact raw body bytes>")
```

compared in constant time against any `v1=` value. During a rotation window
there will be two `v1=` components, one per active secret.

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
