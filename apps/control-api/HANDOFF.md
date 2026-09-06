# Control API — handoff

## Review fixes (2026-09-06)

Nine confirmed defects from the adversarial review, plus one spec conflict.
Schema changes live in `prisma/migrations/20260906010000_review_fixes/migration.sql`
(hand-written — see the drift note at the bottom).

### For the data-plane agent — read these three

**1. `events.payload_raw` is now the authoritative payload. Sign from it.**

`events.payload` is `jsonb`, and PostgreSQL normalises jsonb: key order,
insignificant whitespace and duplicate keys are not preserved. ARCHITECTURE.md 28
signs the *exact raw request bytes*, so the bytes read back out of `payload` are
not the bytes that arrived, and every inline-payload signature would fail at the
consumer. Section 32 mentions jsonb; **section 28 governs**.

- On ingest, write **both**: `payload_raw` (bytea, the exact request body) and
  `payload` (jsonb, parsed) — the jsonb column is for filtering, search and the
  operator UI only.
- `payload_hash` is SHA-256 of `payload_raw`.
- Signing and outbound delivery read `payload_raw` and nothing else. Never
  re-serialise the jsonb to produce a body.
- `payload_raw` is NULL when the payload was offloaded (`payload_location` set).

**2. `events.ordering_key` exists. Stop stashing it in `headers`.**

`docs/API.md` documents the ingest API accepting `ordering_key` and
`deliveries.ordering_key` already existed; `events` had nowhere to put it. It is
now `events.ordering_key TEXT`. Carry it from the event onto each delivery the
fan-out creates. Enforcement stays deferred (ADR-0004).

**3. API key convention — confirmed against your code, unchanged.**

`src/common/api-key.ts` mirrors `services/data-plane/internal/ingest/apikey.go`
exactly, and `src/common/api-key.spec.ts` pins it:

| | |
|---|---|
| shape | `wk_live_<secret>` / `wk_test_<secret>` |
| minimum length | `len("wk_live_") + 16` = 24, checked before hashing |
| `api_keys.key_hash` | lowercase hex SHA-256 of the **full plaintext key** |
| `api_keys.key_prefix` | the first **12** characters |

Generated secrets are 32 characters over `[A-Za-z0-9]` (~190 bits), so no key
contains `-` or `_` in its secret half and `strings.Cut` splits it correctly.
`apikey.go` was not modified.

### Fan-out router — the ON CONFLICT arbiter now exists

```sql
CREATE UNIQUE INDEX deliveries_event_endpoint_original_key
  ON deliveries (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL;
```

Only `@@index([eventId])` existed before, so the router's `ON CONFLICT` had no
arbiter to name and a router that inserted its deliveries then died before
marking the outbox row processed would be re-run — every subscriber receiving the
event twice. Name this index (or the equivalent
`ON CONFLICT (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL`) in the
insert. It is **partial** because replay legitimately creates a second row for
the same pair; a replayed row carries `replay_of_delivery_id` and is exempt.

### Delivery ledger is no longer cascade-deletable

`deliveries.event_id` and `deliveries.endpoint_id` are now `ON DELETE RESTRICT`.
A single `prisma.endpoint.delete()` used to erase months of `delivery_attempts`
through two cascade chains, contradicting the append-only invariant and the
question the table exists to answer. **Endpoint and project removal is a soft
delete: `status = 'deleted'`.** A hard delete of an endpoint that has ever
delivered now fails loudly. `delivery_attempts → deliveries` stays CASCADE
deliberately — nothing cascades into `deliveries` any more, so attempts can only
go via a deliberate delete of the parent (retention jobs).

### NULL-safe uniqueness (PostgreSQL 15+, dev compose runs postgres:16)

Both indexes are recreated `NULLS NOT DISTINCT` under their original names:

- `rate_limit_policies (project_id, scope, resource_id)` — `resource_id` NULL
  means "every resource in this scope", exactly the row that had to be unique.
- `usage_records (organization_id, project_id, metric, period_start)` —
  org-level rows carry `project_id` NULL, so under the default NULLS DISTINCT
  the hourly aggregator's upsert never matched and **inserted a duplicate every
  run**; billing summed the same hour repeatedly and over-billed. The upsert now
  works. If the aggregator already ran against a database created from the init
  migration alone, dedupe before applying this migration or the index build will
  fail.

### Encryption key rotation

Envelope is now `v1.<kid>.<iv>.<tag>.<ct>`. New config, both optional with safe
defaults, so no `.env` change is required to boot:

- `ENCRYPTION_KEY_ID` — names `ENCRYPTION_KEY` in the envelope (default `k1`).
- `ENCRYPTION_KEYS_RETIRED` — comma-separated `<kid>:<base64key>`, accepted for
  **decryption only**.

Rotation: promote the new key to `ENCRYPTION_KEY`/`ENCRYPTION_KEY_ID`, move the
old pair into `ENCRYPTION_KEYS_RETIRED`, re-encrypt in the background, drop it.
Legacy four-part `v1.<iv>.<tag>.<ct>` values still decrypt (every key in the ring
is tried; GCM disambiguates).

`encrypt`/`decrypt` now **require an `EncryptionContext` (`{ table, id }`)**,
bound in as AES-GCM AAD, so a ciphertext lifted out of one row and pasted into
another fails to authenticate — an attacker with DB write access cannot copy
endpoint A's signing secret onto endpoint B. Callers must pass the row's own
table and primary key. Legacy envelopes carry no AAD and are read without one.

### Sessions and auth throttling

Sessions were stateless JWTs: logout cleared the cookie but could not withdraw a
token already copied off the machine, and there was no rate limit on login or
forgot-password at all.

- New `sessions` table. The cookie is still a signed JWT but carries `sid`, and
  `SessionService.verify` checks the row on every request (one indexed PK
  lookup). Logout revokes that session; a password reset calls
  `revokeAllForUser` — sign out everywhere.
- Pre-fix tokens without a `sid` claim are rejected, so every existing session is
  invalidated on deploy. Users log in again once.
- `ThrottleGuard` + `@Throttle(...)` on the auth routes: login 10/15min,
  register/forgot 5/hour, reset 10/hour, verify 20/hour — counted per IP **and**
  per account (email hashed before it becomes a bucket key; it is PII).
- **LIMITATION:** the counter is in process memory, so N replicas allow N × limit.
  `ThrottleStore` (`src/common/throttle.store.ts`) is the seam for a Redis
  implementation — ioredis is already a dependency. Do that before running more
  than one control-plane replica.

### Bootstrap CLI

`prisma.user.count()` sat outside the transaction (and READ COMMITTED would not
have serialised it anyway), so two concurrent invocations both created an
organization. The count now happens after `pg_advisory_xact_lock` inside the
transaction. `argon2.hash()` moved outside the interactive transaction — at
hardened parameters it blew Prisma's 5s timeout and surfaced as an opaque P2028.
`BOOTSTRAP_ORG="!!!"` (any name with no alphanumerics) is now rejected with a
readable message instead of writing an empty slug.

### Migration drift — READ BEFORE RUNNING `prisma migrate dev`

Three statements in `20260906010000_review_fixes` **cannot be expressed in
`schema.prisma`**: the partial unique index and the two `NULLS NOT DISTINCT`
indexes. Prisma does not model either.

Consequences:

- `prisma migrate diff` and `prisma migrate dev` will report these as drift, and
  a regenerated migration will silently drop them. Preserve the file verbatim.
- `src/infrastructure/prisma/schema.spec.ts` asserts the SQL text directly, so a
  regeneration that loses them fails the build rather than reintroducing the
  defect invisibly.
- The Prisma `@@unique` attributes are retained on `RateLimitPolicy` and
  `UsageRecord` so the generated client still types the compound `where` for
  upserts; only the underlying index differs.

**The requested drift check could not be run.** `prisma migrate diff
--from-migrations` requires `--shadow-database-url`, no database is available
(Docker down), and Prisma refuses the command without one:

```
Error: You must pass the --shadow-database-url if you want to diff a migrations directory.
```

What was run instead, and passed: `prisma validate` (with dummy URLs — the schema
is valid) and `prisma migrate diff --from-empty --to-schema-datamodel --script`,
which needs no database. The rendered target DDL matches init + review_fixes on
every table, column and foreign key, differing only in the three hand-written
index clauses above — i.e. exactly the known, documented drift and nothing else.
**Someone must still run the real drift check and apply both migrations against a
live postgres:16 before this is trusted.**

### Verified

`prisma:generate`, `lint`, `build`, `test` all pass. 101 tests, 7 suites.
New: `crypto.service.spec.ts`, `api-key.spec.ts`, `throttle.guard.spec.ts`,
`session.service.spec.ts`, `bootstrap.spec.ts`, `infrastructure/prisma/schema.spec.ts`.

## Auth review round 2 (2026-09-06)

Five confirmed findings from the second adversarial pass. Code only - no schema
change, no new migration.

### FIX 1 - registration told the truth about the wrong index

`isUniqueViolation` duck-typed on the P2002 code alone, so every unique violation
in `register` was reported as "An account with that email already exists."
Registration writes **two** unique columns and the other one collides routinely:
the default org name is the local part of the address, so `info@acme.com` and
`info@globex.com` both slugify to `info`. `uniqueSlug`'s SELECT runs inside the
transaction and under READ COMMITTED cannot see the other transaction's
uncommitted row, so both pass the check and the second INSERT raises P2002 on
`organizations_slug_key`. The second signup was lost behind a false 409.

`AuthService.uniqueViolationTarget` now reads `err.meta.target` (matching both
the PostgreSQL column-list shape `["email"]` and the constraint-name shape) and
branches: `slug` retries the whole transaction with a forced random suffix (5
attempts, then an honest "could not allocate an organization slug" conflict),
`email` takes the collision path below, anything else is **rethrown** rather than
laundered into a friendly 409.

`FakePrisma.$transaction` now rolls back on failure, because the retry is only
correct if the losing attempt's writes are undone.

### FIX 2 - decision: unconditional 202, notify the address owner

`POST /v1/auth/register` returned 201 for a free address and 409 for a taken one,
so an attacker could walk a list - while the class docblock claimed no response
reveals whether an address is registered.

**Chosen: the 202, not the docblock edit.** The claim is worth keeping: every
other route in this module already pays for it (uniform login errors, dummy
argon2 verify, silent forgot-password), and leaving registration as the one hole
would make the other work pointless. Enumeration resistance is also cheaper to
build in now than to retrofit once a customer-facing portal exists.

Consequences, deliberate:

- Register always answers **202 `{"status":"accepted"}`**, no body, **and no
  session cookie**. A `Set-Cookie` on the success path alone would re-open the
  oracle the 202 closes, so the "log in immediately after signup" shortcut is
  gone: verify the address, then log in.
- The password is hashed *before* the collision is known, so the argon2 cost is
  paid on both paths and the timing does not leak either.
- The collision path mails the address owner a "someone tried to register with
  your address" notice - new `AuthMailer.sendRegistrationAttemptNotice`. The
  caller is not told; the owner, who is entitled to know, is.
- **Breaking for `apps/dashboard`** (not mine to edit):
  `src/features/auth/api.ts` types the register mutation as returning `Session`
  and assumes a cookie. It now gets `{status:'accepted'}` and no session. That
  flow must be changed to a "check your email, then sign in" screen, and
  `src/lib/mock/server.ts` updated to match.

### FIX 3 - mail failures no longer 500 (or enumerate)

`sendVerification` was awaited after the transaction committed with no try/catch:
SMTP down meant a 500 for an account that existed, and the retry hit the
duplicate-email path with no session and no mail ever sent. In `forgotPassword`
the same pattern was an **oracle** - unknown addresses returned early with 202,
known ones reached the mailer - so a degraded transport answered 202 for
unregistered and 500 for registered.

Both are wrapped now. The failure is logged at error level with the **user id**
only (never the token, never the address - it is PII), and the caller still gets
its 202. `forgotPassword` wraps the token issue/revoke too, so a DB hiccup on the
known-address path cannot become the same oracle.

Still awaited rather than enqueued: there is no queue in the control plane yet
(Redis is the data plane's). When one lands, these two calls are the first
things to move onto it - the try/catch becomes the enqueue failure path.

### FIX 4 - the guard now checks the account, not just the token

`SessionGuard` verified signature, expiry and the `sessions` row, but never that
the user still existed or was enabled: an admin setting `users.disabled_at` bought
nothing for up to seven days. Not exploitable while the only guarded route
re-checked `disabledAt` downstream, but the guard is exported for Phase 2's
organizations/projects/api-keys/endpoints to mount, and the first module to trust
it alone would have handed a disabled user a week of access.

The check went into **`SessionService.verify`**, not the guard body, so every
caller of `verify` gets it and it costs no extra round trip - the `sessions` row
was already being read, and the account status rides along as
`include: { user: { select: { disabledAt: true } } }`. A session whose user row
is missing (deleted account) is treated exactly like a disabled one.

Knock-on, accepted: `logout` verifies before revoking, so a disabled user's
logout now clears the cookie without revoking the row. Harmless - the session is
already unusable - but when admin-disable ships it must call
`SessionService.revokeAllForUser(userId, 'admin')` rather than relying on logout.

### FIX 5 - the dev mailer stopped printing account-takeover tokens

`process.stdout.write(... token=<raw>)` bypassed pino entirely, so app.module.ts's
redaction config could not touch it: one wrong `APP_ENV` in a staging deploy
would have shipped full password-reset tokens into centralised logging next to
the address they unlock.

- Everything now goes through the Nest logger, and only a **fingerprint**
  (`abc123…(43 chars)`) is emitted - enough to correlate two log lines, useless
  to whoever reads them. No raw token is printed in any environment.
- `DevelopmentAuthMailer` **throws in its constructor** unless `APP_ENV` is
  `development` or `test`, so a staging/production boot with no real transport
  fails module init instead of coming up healthy with registration and password
  reset silently non-functional. The old warning text asked for this; nothing
  enforced it.
- Local manual testing needs a real transport pointed at a catcher (Mailpit /
  MailHog), since tokens are no longer readable from the console and only their
  SHA-256 is stored.

### Verified (round 2)

`prisma:generate`, `lint`, `build`, `test` all pass. **118 tests, 9 suites**
(was 101/7). New: `session.guard.spec.ts`, `mailer.port.spec.ts`. Regression
tests for all five fixes; the FIX 1 slug race is reproduced by stubbing
`organization.findUnique` to return null, which is exactly what READ COMMITTED
does to it in production. Still no live database, so nothing here has been run
against real PostgreSQL - the FIX 1 retry depends on Prisma's P2002 `meta.target`
being the column name or the constraint name, and both shapes are matched, but a
real concurrent-signup test should be run once a database is available.

---

## Security review round 3 (2026-09-06) — the FAIL driver and six follow-ons

### FIX 1 — auth throttling was one platform-wide bucket (HIGH)

`ThrottleGuard` buckets by `req.ip`, but Express only derives `req.ip` from
X-Forwarded-For when `trust proxy` is set, and main.ts never set it. Behind the
nginx Ingress every request carried the ingress controller pod's address, so
*one* bucket covered the whole platform: ~15 anonymous requests an hour 429'd
every user out of login **and** password reset, repeatedly, for as long as the
attacker cared to keep it up.

- **(a)** `main.ts` now calls `applyTrustProxy(app, TRUST_PROXY_HOPS)` before
  anything reads `req.ip`. The hop count is **exact** and comes from config; it
  is never `true`, which would let any client prepend its own X-Forwarded-For
  entry and mint a fresh bucket per request. Default 0 (trust nothing).
  **Anything that fronts this service must set `TRUST_PROXY_HOPS` to the number
  of proxies in front of it** — 1 for the Kubernetes Ingress, 2 behind a CDN.
  A wrong value is a silent security regression in one direction or the other,
  so the boot log says which value was applied.
- **(b)** `reset-password` and `verify-email` are counted per address but can no
  longer 429 on it (`enforcePerIp: false`). Their tokens are 256-bit and
  single-use; an IP-only limit there denied service to real users and stopped no
  realistic attack. Login, register and forgot-password stay enforced per
  address — that is where the brute-force surface is.
- **(c)** `RedisThrottleStore` implemented (ioredis, already a dependency) and
  selected whenever `REDIS_URL` is set; the in-memory store remains for local
  development and as the degraded fallback, and now logs loudly when it is what
  you are running. The manifests ship `replicas: 2`, which silently doubled
  every limit. Redis failure degrades to per-process counting (fails neither
  open nor closed) and is logged once per outage, not once per request.
- **(d)** The comment at `throttle.guard.ts` claiming "req.ip honours
  `trust proxy`" — true of Express, false of this app — is corrected and now
  points at where the setting actually lives.

### FIX 4 — /docs is not mounted in production

`SwaggerModule.setup` is gated on `APP_ENV !== 'production'`. It handed
unauthenticated callers the full route inventory, DTO shapes and validation
constraints of the production control plane.

> **For the devops agent:** the production Ingress still routes `/docs` to this
> service. That path should be removed from the Ingress — the app now 404s it,
> but there is no reason to route it. Also add `TRUST_PROXY_HOPS` to the
> control-api env (value `1` for the current single-Ingress topology, higher only
> if something else fronts it) and make sure `REDIS_URL` is set wherever
> `replicas > 1`, or rate limiting silently counts per pod.

### FIX 5 — login now requires a verified email

Login never looked at `emailVerifiedAt`, so with open registration anyone could
sign up with an address they did not control and immediately own a working
organization. The check runs **after** the password check and returns the new
`email_not_verified` code (403), which is reachable only by someone who already
knows the password — it enumerates nothing. `bootstrap` already sets
`emailVerifiedAt`, so the first owner is unaffected.

> **For the dashboard agent:** `POST /v1/auth/login` can now answer 403
> `email_not_verified`. Treat it as "we know who you are, confirm your address"
> and offer a resend, not as a credential failure.

### FIX 3 / FIX 2 / FIX 6 / FIX 7 — briefly

- **Session cookie Secure** is now an explicit opt-*out*: off only for APP_ENV
  exactly `development` or `test`. It was `APP_ENV !== 'development'`, so an
  unset or misspelled APP_ENV (`prod`, `Production`) shipped the session cookie
  without `Secure`. The zod enum already rejects unknown values; the set in
  `SessionService` is belt-and-braces for a service built outside that
  validation. Nothing else keys off APP_ENV insecurely — the pino pretty
  transport and `DevelopmentAuthMailer` both fail closed already.
- **`.env.example` ships `ALLOW_OPEN_REGISTRATION=false`.** `docs/DEVELOPMENT.md`
  tells operators to `cp .env.example .env`, so the file's value is what people
  actually run — it was `true`, i.e. self-serve signup on a multi-tenant control
  plane by default.
- **The legacy 4-part crypto envelope is gone.** It decrypted with
  `aad = undefined`, so stripping the kid off a 5-part envelope was a supported
  way to turn the row binding off. No 4-part ciphertext exists anywhere (the
  migration has never run outside CI). `EncryptionContext` also gained a
  required `owner` (the endpoint id): the AAD bound only the row id, so an
  attacker with DB write access could re-point `endpoint_secrets.endpoint_id` at
  another endpoint instead of copying the ciphertext — the docblock claimed that
  was prevented and it was not. The claim and the code now agree.
- **`x-request-id` from a client is validated** against `/^[A-Za-z0-9_-]{1,64}$/`
  (`common/request-id.ts`) before it becomes pino's `req.id`, the response header
  or the `request_id` in an error body. It was taken verbatim, so arbitrary
  attacker text became a first-class field in centralised logging.

### Noted, deliberately NOT fixed

**`SESSION_SECRET` is passed to `cookieParser` but the session cookie is neither
signed nor read as a signed cookie.** `main.ts` does
`app.use(cookieParser(process.env.SESSION_SECRET))`, `SessionService.issue` sets
the cookie with plain `res.cookie` (no `signed: true`), and `readSessionCookie`
reads `req.cookies`, never `req.signedCookies`. Nothing is broken — the cookie
is a JWT and carries its own signature, which is the real integrity mechanism —
but the wiring implies a signature layer that does not exist, and a future
reader may "simplify" by trusting it. Either drop the secret from
`cookieParser`, or sign the cookie and read `req.signedCookies`. Signing buys
little on top of the JWT; removing the argument is the honest change.

### Verified (round 3)

`prisma:generate`, `lint`, `build`, `test` all pass — **234 tests, 12 suites**
(was 218/10). New suites: `config/trust-proxy.spec.ts` (real Express, via the
instance `ExpressAdapter` builds, asserting X-Forwarded-For is ignored at 0 hops,
honoured at 1, and unforgeable at either) and `common/request-id.spec.ts`. New
regression coverage in `throttle.guard.spec.ts` (shared Redis counter, degraded
fallback, `enforcePerIp:false`), `crypto.service.spec.ts` (4-part envelope
refused, kid-stripping downgrade refused, re-pointed row refused),
`session.service.spec.ts` (Secure-flag matrix including unset/misspelled
APP_ENV), `env.schema.spec.ts` (`TRUST_PROXY_HOPS`, APP_ENV enum) and
`auth.service.spec.ts` (unverified login, non-enumeration).

Still no live database and no live Redis: `RedisThrottleStore` is tested against
a fake implementing the three commands it uses, so the INCR/PTTL/PEXPIRE sequence
and the degraded path are pinned, but nothing here has spoken to a real Redis.
Worth one manual check against `dev:infra` before it fronts production traffic.
