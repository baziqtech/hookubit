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

---

## Authorization layer (2026-09-06) — `src/authz`

Built **before** any Phase 2 CRUD module, deliberately. `SessionUser` is
`{userId, email, sessionId}` and carries no tenant context; fourteen modules
written against that would each have to remember `organizationId`/`projectId`
scoping by hand, and retrofitting it afterwards is how IDOR ships. This layer
exists so tenant scoping is what you get by *default* and bypassing it is what
takes effort.

### The permission model

`src/authz/permissions.ts` holds a single matrix. `Permission` is derived from
its keys and `MemberRole` comes from `schema.prisma`, so **the mapping cannot be
incomplete**: a new permission does not exist as a type until it has a row, and
a new role makes every row fail `satisfies Record<string, Record<MemberRole,
boolean>>`. A missing grant is a compile error, never a silent deny.

| | owner | admin | developer | viewer | billing |
|---|---|---|---|---|---|
| `projects.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `projects.write` | ✓ | ✓ | | | |
| `endpoints.read` | ✓ | ✓ | ✓ | ✓ | |
| `endpoints.write` | ✓ | ✓ | ✓ | | |
| `subscriptions.read` | ✓ | ✓ | ✓ | ✓ | |
| `subscriptions.write` | ✓ | ✓ | ✓ | | |
| `api-keys.read` | ✓ | ✓ | ✓ | | |
| `api-keys.write` | ✓ | ✓ | ✓ | | |
| `events.read` | ✓ | ✓ | ✓ | ✓ | |
| `events.replay` | ✓ | ✓ | ✓ | | |
| `deliveries.read` | ✓ | ✓ | ✓ | ✓ | |
| `deliveries.replay` | ✓ | ✓ | ✓ | | |
| `members.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `members.write` | ✓ | ✓ | | | |
| `billing.read` | ✓ | ✓ | | | ✓ |
| `billing.write` | ✓ | | | | ✓ |

`api-keys.*` and `subscriptions.*` are additions to the ARCHITECTURE.md 10 list;
the module list implies both. Judgement calls worth arguing with rather than
inheriting: developers may issue API keys (it is the integration work) but may
not change the team or create projects; viewers cannot read the API-key
inventory and cannot replay, because a replay puts real HTTP traffic on a
customer's endpoint and is a write; admin cannot do `billing.write`.

**Suspension.** A `suspended` organization or project narrows the caller's set to
reads plus `billing.write` — locking a customer out of the payment form is how a
billing suspension becomes permanent. `deleted` is treated as absent (404).

### Not-found vs forbidden — the rule, applied everywhere

- **404 `not_found`** whenever the caller is *outside* the tenant that owns the
  resource: no membership, a project belonging to another organization, an
  endpoint/event/delivery under someone else's project, or a genuinely absent
  row. All four give the same code **and the same message** — one exported
  constant, `CROSS_TENANT_MESSAGE` (`'Resource not found.'`) — so neither the
  status nor the body can be used as an existence oracle to enumerate a
  competitor's infrastructure. It used to be per-resource wording (`'Endpoint
  not found.'` for an absent id, `'Organization not found.'` for one that hit
  inside a foreign tenant), which was exactly that oracle; the specific reason
  is now logged at debug level and never crosses the wire. `permissions.spec.ts`
  and `tenant-resolver.spec.ts` assert one identical string across every anchor
  kind × {absent, foreign}. **Any new not-found in any module must use that
  constant, never a resource name.**
- **403 `forbidden`** only once membership is proven and the caller's *role* is
  what falls short. They already know the tenant exists — they are in it — so
  the response names the missing permission and their role.

This matches the ingest path (`TestKeyForAnotherProjectIsNotFound`), so the two
planes cannot be played off against each other. The rationale lives in the
`CROSS_TENANT` docblock in `tenant-resolver.service.ts`; keep it in sync if the
policy ever changes.

**Corollary for every module:** never `findUnique({ where: { id } })` and then
check ownership. By then you have already decided to answer differently for a
real id. Put the tenant predicate in the WHERE clause — which is what
`ScopedRepository` does for you.

### How a new module uses this

`AuthzModule` is `@Global`, so there is nothing to import for authorization.
`PrismaModule` is NOT global any more: a module that genuinely needs the raw
client must put `PrismaModule` in its `imports`, and `.eslintrc.json` bans
importing `PrismaService` outside `src/authz`, `src/auth`, `src/infrastructure`,
`src/cli` and `src/health`. Feature modules inject `TenantScopeFactory`.

`@RequirePermission` and `@ResolveTenantFrom` enforce nothing on their own — a
route that declares one without `@Authorized()`/`@UseGuards(TenantGuard)` serves
unauthenticated. `assertRoutesAreGuarded(app)` in `main.ts` walks every
registered controller at boot and throws with the offending
`Controller.handler` list, so that mistake fails the deploy rather than one
request.

Role changes have invariants beyond `members.write`: call `mayAssignRole`,
`assertRoleChangeAllowed` and `assertMemberRemovalAllowed` from
`authz/permissions.ts` in the members module. `members.write` alone lets an
admin set its own row to `owner` and hold `billing.write` a request later.

`AuditService.record` is private; controller-driven paths call `recordFor`,
which takes organization, actor, IP and user agent off the resolved context.
 The worked example is
`ExampleController` in `src/authz/authz.http.spec.ts` — it is a real controller
run by a real Nest app in that suite, so it cannot rot.

```ts
@Controller('v1/organizations/:orgId/projects/:projectId/endpoints')
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get()
  @Authorized('endpoints.read')                 // mounts SessionGuard + TenantGuard
  list(@Tenant() ctx: RequestContext) {
    return this.endpoints.list(ctx);
  }

  @Post()
  @Authorized('endpoints.write')
  create(@Tenant() ctx: RequestContext, @Body() dto: CreateEndpointDto) {
    return this.endpoints.create(ctx, dto);
  }
}

@Injectable()
export class EndpointsService {
  // Inject the scope factory, NOT PrismaService.
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
  ) {}

  list(ctx: RequestContext) {
    // Already fenced to ctx's organization + project. No projectId in sight.
    return this.scopes.for(ctx).endpoints.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(ctx: RequestContext, dto: CreateEndpointDto) {
    const scope = this.scopes.for(ctx);
    const endpoint = await scope.endpoints.create({ id: newId('endpoint'), ...dto });
    await this.audit.recordFor(ctx, {
      action: 'endpoint.created',
      resourceType: 'endpoint',
      resourceId: endpoint.id,
    });
    return endpoint;
  }

  // 404 for an id in another tenant, never 403, and never a fetch-then-check.
  get(ctx: RequestContext, id: string) {
    return this.scopes.for(ctx).endpoints.requireById(id);
  }
}
```

Route-parameter convention: `:orgId` (or `:organizationId`) and `:projectId`.
**Not `:id`** — a bare `:id` is ambiguous and a resolver that guessed would one
day guess in the direction that grants access. For resource-addressed routes
where the tenant is not in the path, declare the anchor:

```ts
@Get('v1/deliveries/:deliveryId')
@Authorized('deliveries.read')
@ResolveTenantFrom('delivery', 'deliveryId')   // delivery → endpoint → project → org
```

Transactions: `scope.withClient(tx)` inside `prisma.$transaction`, and pass the
same `tx` to `audit.recordFor(ctx, entry, tx)` so the audit row commits with the
change it describes.

Things that fail loudly rather than quietly: a guarded route with no tenant in
the path (500, not an unscoped 200); `requireProject()` on an organization-level
route (500); `create()` on a table whose tenancy comes from a parent (500).

### What is structurally guaranteed, and what is not

`ScopedRepository` deliberately does **not** expose `findUnique`, `update` or
`delete` — all three take a bare primary key. Everything routes through
`findFirst`/`updateMany`/`deleteMany` with the tenant predicate ANDed in, so a
caller-supplied `{ projectId: theirs }` becomes `AND [{ mine }, { theirs }]` and
matches nothing. `create()` fills the tenant columns itself and omits them from
the caller's input type. Nested tables use relation filters
(`endpoint_secrets → endpoints → projects`, `delivery_attempts → deliveries`), so
the join happens in PostgreSQL and no unscoped row ever exists in memory.

**Not guaranteed:** `PrismaService` is still globally injectable. That is the
escape hatch and it is meant to be conspicuous — a `PrismaService` in a feature
service's constructor should draw a review comment. There is no lint rule
enforcing this; consider one when Phase 2 starts.

**Known trade-off:** `scope.deliveries` and `scope.events` filter on the
denormalised `organization_id`/`project_id` columns, because that is what the
`(project_id, status, created_at)` index is for. A delivery row whose columns
disagreed with its endpoint's real owner would therefore appear in a *listing*.
Id-addressed access does not have this weakness: `@ResolveTenantFrom('delivery',
…)` walks the real chain and refuses on any mismatch, logging it at error level.
The columns are written by the fan-out router from the endpoint's own project, so
a mismatch is a data-integrity bug, not an attack path — but if that ever becomes
untrue, switch the two predicates to relation filters and accept the index loss.

### Deliberately left out

- **No CRUD.** No controllers, no DTOs, no modules for organizations/projects/
  endpoints. This is the layer they will be written against.
- **No relation loading in `ScopedRepository`.** `findMany` takes
  `where`/`orderBy`/`take`/`skip` and returns the model row. `include`/`select`
  would need per-model result typing; add it when a module actually needs it,
  and keep `where()` as the way to build the predicate.
- **No API-key principal.** `RequestContext` is built from a browser session.
  Server-to-server ingest authenticates in the Go data plane; when the control
  API grows key-authenticated routes, add a second resolver that produces the
  same `RequestContext` shape from `api_keys.scopes` — `AuditActor.apiKeyId`
  already exists for it.
- **No invitation / role-change flows.** `members.write` is the permission; the
  module that uses it is Phase 2.
- **No audit call sites.** `AuditService` is the hook; nothing was retrofitted,
  because there is nothing to retrofit yet. It is not an interceptor on purpose —
  an automatic "log every mutating request" layer records HTTP verbs, not
  business facts, and cannot know the id of a thing it just created.
- **Suspension is enforced at the permission level only.** Nothing stops the
  data plane delivering for a suspended tenant; that belongs with billing.

### Verified

`prisma:generate`, `lint`, `build`, `test` all pass — **323 tests, 18 suites**
(was 234/12). New suites, all under `src/authz`: `permissions.spec.ts` (the
matrix restated independently, so a change nobody meant fails), 
`tenant-resolver.spec.ts` (membership, the `/orgs/A/projects/<B>` IDOR, deleted
and suspended tenants, every anchor, the denormalised-column mismatch),
`tenant-scope.spec.ts` (cross-tenant reads, writes and deletes, and that a
caller's own `where` — including an `OR` — cannot escape the predicate),
`tenant.guard.spec.ts` (403-vs-404, developer attempting `members.write`, class
vs handler metadata), `audit.service.spec.ts`, and `authz.http.spec.ts` (a real
Nest app on a real port, asserting the status codes on the wire).

Tests run against `src/authz/testing/tenant-prisma.fake.ts` — a new in-memory
fake in the spirit of the auth one, but with a WHERE evaluator that really
understands `AND`/`OR`/`NOT` and one-hop relation filters. That matters: a fake
that ignored `where` would make every isolation test pass vacuously.

**Still no live database** (Docker daemon down), so nothing here has run against
real PostgreSQL. The two things a live run should confirm: that Prisma's
generated SQL for a relation filter nested inside `AND` is what these tests
assume (`endpoint_secrets` → `endpoints` → `projects`), and that
`organization_members` compound-unique lookups behave as the fake models them.
Neither is exotic, but neither has been executed.

### Note for the concurrent tenant-scope work (2026-09-06)

- Lint, build and the full suite (397 tests) pass across the package as of this
  note, with both sets of changes in the tree.
- `permissions.spec.ts` now asserts that **every getter on `TenantScope`** maps
  to a declared permission in `TENANT_SCOPE_PERMISSIONS`
  (`authz/permissions.ts`), and that the map names nothing `TenantScope` does
  not expose. `organization` and `endpointHealth` are mapped; a new accessor
  needs one line there or that test fails.
- New permissions exist: `endpoint-secrets.read/.write` (owner/admin only —
  secrets no longer ride along on `endpoints.read`), `audit.read` (owner/admin),
  `policies.read/.write`.

## Write-side fixes to `ScopedRepository` (2026-09-06, second pass)

Both independent reviews landed the same verdict on the *write* side: the layer
inverted its own governing principle. `where` was fenced, `data` was not, so the
two most natural calls a module author makes — `create` with a required sibling
foreign key, and `updateById` with a request body — were the two that crossed the
tenant boundary, while the types, names and docblocks all said "scoping is
handled". That is worse than no layer: an author who trusts it does not write the
ownership check they would have written from scratch.

What changed, all inside `tenant-scope.ts` / `tenant-scope.factory.ts`:

1. **The tenant columns are not writable.** `create` takes
   `ScopedCreateInput<TCreate>` and `updateById`/`updateMany` take
   `ScopedUpdateInput<TUpdate>` (`Omit<…, 'organizationId' | 'projectId' | 'id'>`),
   and the same keys are *rejected at runtime* — types are erased and compiled JS
   callers exist. A row can no longer be moved out of the tenant that the `where`
   predicate just proved owns it. `updateById` also runs its `updateMany` and its
   read-back in one `$transaction`, against a delegate bound to the transaction
   client, so it can no longer report 404 for a write that committed.
2. **Sibling foreign keys are proved, not trusted.** Each repository declares its
   tenant-owned FKs (`subscriptions: { endpointId: 'endpoints' }`,
   `deliveries: { eventId, endpointId, subscriptionId, replayOfDeliveryId }`,
   `endpoints: { retryPolicyId }`, …) and every one present in a payload is
   resolved through *its own* scoped repository before the write — 404, never a
   cross-tenant binding. `requireOwned(field, id)` / `assertOwned(field, id)`
   expose the same check for ids used outside a column.
3. **Nested relation writes are gone.** `TCreate`/`TUpdate` are now Prisma's
   scalars-only `*CreateManyInput`/`*UncheckedUpdateManyInput`, so
   `{ secrets: { connect: [{ id }] } }` does not typecheck; a DMMF-derived
   allowlist of each model's scalar fields rejects it at runtime too. `connect`,
   `set`, `disconnect`, `delete`, `deleteMany` and `upsert` all take bare unique
   keys with no tenant filter — the exact unscoped access this class removed from
   `where`, re-entering through `data`.
4. **`deliveries`/`deliveryAttempts` now agree with `TenantResolver`.** Scoped via
   `{ endpoint: { projectId } }` (and `{ delivery: { endpoint: … } }`), with the
   denormalised `organization_id`/`project_id` kept as an extra AND conjunct for
   index selectivity. `del_corrupt` used to be refused by the id-addressed anchor
   and served by the listing, in the same commit.
5. **Coverage, so authors are not pushed onto `PrismaService`** (which is
   `@Global()`, so reaching for it costs them nothing): `endpointHealth` (keyed by
   `endpoint_id` — the repository now takes an `idField`), `organization`
   (predicate `{ id: <resolved org> }`), and `aggregate`/`groupBy` wrappers that
   AND the predicate exactly as `where()` does. The deliveries dashboard is
   entirely aggregates.
6. **Bounded reads and deliberate bulk writes.** `take` is clamped to
   `MAX_PAGE_SIZE` (200) and defaults to `DEFAULT_PAGE_SIZE` (50);
   `updateMany`/`deleteMany` now require a non-empty `where`, because
   `await scope.endpoints.deleteMany()` read as innocuous and hard-deleted every
   endpoint in the organization.

`tenant-scope.spec.ts` proves each of these as a *negative* (43 tests): a
cross-tenant FK, a nested `connect`, a tenant-column write, an unfiltered bulk
delete and an oversized `take` are each rejected, with the fixture asserting the
victim row was left untouched. The fake's `NOT: [a, b]` was also corrected to
Prisma's `NOT(a AND b)`; it was `NOT(a) AND NOT(b)`, which is *stricter* than
production and could have let an isolation test pass against the fake while
leaking against PostgreSQL.

### Needed from whoever owns `index.ts`

Please re-export from `./tenant-scope`, none of which is exported today:

```ts
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AggregateArgs,
  type GroupByArgs,
  type OwnedRepository,
  type OwnershipVerifier,
  type ScopedCreateInput,
  type ScopedUpdateInput,
  type TransactionRunner,
} from './tenant-scope';
export { type TenantRepositoryName } from './tenant-scope.factory';
```

A Phase 2 controller that paginates needs `MAX_PAGE_SIZE` to validate its query
DTO against the same ceiling the repository enforces, and a service that takes a
`ScopedUpdateInput<…>` in its own signature needs the type.

### Two deliberate gaps, for the next author

- **`endpointSecrets`/`endpointHealth`/`deliveryAttempts` still cannot be
  created** through the scope: their tenancy comes from a parent, so there is no
  column to stamp, and `create` raises `internal_error` pointing at the parent
  transaction. Secret *rotation* will want this. It is now safe to allow — the FK
  ownership check proves the `endpointId` — but it is a behaviour change with a
  test pinning the current refusal, so it was left alone.
- **`usageRecords.projectId` cannot be set.** `usage_records` is organization-
  scoped (org rollups carry `project_id NULL`), but `projectId` is one of the two
  banned tenant columns everywhere, so per-project rollups cannot be written
  through the scope. The billing aggregator is not built yet; when it is, either
  give that repository an explicit `projectId`-taking method that validates
  through `projects`, or make the banned set depend on the scope kind.


---

## Projects and API keys (2026-09-06) — `src/projects`, `src/api-keys`

Phase 2 CRUD written against the authorization layer at b379b8d/cbf6b6a. No
schema change, no migration, nothing outside these two directories.

### Wire them up — the lines I could not add myself

`app.module.ts` (`src/app.module.ts`), in the Phase 2 block:

```ts
import { ApiKeysModule } from './api-keys/api-keys.module';
import { ProjectsModule } from './projects/projects.module';

// imports: [...]
    ProjectsModule,
    ApiKeysModule,
```

Neither module has `imports`, and neither should grow any: `AuthzModule` is
`@Global` and re-exports `AuthModule`, so `TenantScopeFactory`, `AuditService`,
`TenantGuard` and `SessionGuard` all resolve without an import ceremony.
`PrismaModule` is deliberately absent from both — no file under either directory
imports `PrismaService`, so the eslint ban still means something here.

Routes (the `v1` prefix comes from `main.ts`):

```
GET    /v1/organizations/:orgId/projects              projects.read
POST   /v1/organizations/:orgId/projects              projects.write
GET    /v1/organizations/:orgId/projects/:projectId   projects.read
PATCH  /v1/organizations/:orgId/projects/:projectId   projects.write
DELETE /v1/organizations/:orgId/projects/:projectId   projects.write   (soft)
GET    /v1/projects/:projectId/api-keys               api-keys.read
POST   /v1/projects/:projectId/api-keys               api-keys.write
POST   /v1/projects/:projectId/api-keys/:apiKeyId/revoke   api-keys.write
```

The API-key routes are project-only paths with no `@ResolveTenantFrom`:
`TenantResolver.coordinatesFromParams` already reads the organization off the
project row and checks membership against that, so the project id in the URL is
a lookup key and never an authorization claim.

### Decisions worth arguing with

- **`environment` is immutable, and refused rather than ignored.** It is absent
  from `UpdateProjectDto` (so `forbidNonWhitelisted` refuses the body) *and*
  checked in `ProjectsService.update`, which answers `invalid_request` with a
  sentence explaining why. A silently-dropped field would be the worst outcome:
  the caller believes the flip happened. `status` is refused the same way —
  soft delete is `DELETE`, so it is audited as `project.deleted` rather than as
  an edit.
- **Deletion is `status = 'deleted'` and the slug is NOT released.** Releasing
  it would mean mutating a customer-chosen identifier on a row that might be
  restored. The cost is that recreating a project under a deleted project's slug
  409s; the conflict message says so, and `GET ...?status=deleted` is how you
  see the row holding it. Revisit if customers hit it.
- **A project's API keys are not revoked on delete.** The ingest path already
  refuses every key whose project is not `active` (`handler.go:166`), so a
  cascade here would be a second, weaker copy of that rule and the one that has
  to be undone by hand after a mistaken delete.
- **P2002 is decided by `err.meta.target`, never by the code alone.**
  `src/projects/unique-violation.ts` flattens both shapes Prisma reports (the
  column list and the constraint name), matches by substring, and **rethrows
  anything unrecognised** — including a P2002 whose `meta.target` is empty. That
  is the auth-module bug (`FIX 1`) not repeated: a slug collision reported as
  "email already exists" sends people looking in the wrong place.
- **Revocation is idempotent, and files one audit row.** Revoke is what an
  operator does under pressure, often twice; a 409 on the second call makes "is
  this key dead?" ambiguous at exactly the wrong moment. The original
  `revoked_at` is kept.
- **API-key scopes are validated against the permission matrix AND against the
  caller's own set.** `api-keys.write` is granted to `developer` on purpose;
  without this a developer could mint a key carrying `members.write` and hand it
  over. Note for whoever builds the key-authenticated resolver: `api_keys.scopes`
  is written and validated here but is **not consulted by the ingest path**,
  which authenticates on the key, its project and its environment only.
- **No status filter on the API-key list.** Status is derived from two
  timestamps at read time; a filter would either page wrongly (filtering after
  the query) or disagree with the derivation by a clock skew. Revoked and expired
  keys are listed *with* their status instead.

### The cross-process contract, and what pins it

`ApiKeysService` never builds a key string. It calls `generateApiKey` from
`src/common/api-key.ts` — the file that mirrors `internal/ingest/apikey.go` —
and then re-asserts `isValidApiKeyShape` and the environment marker before
writing, so a future change to the generator fails the first create instead of
filling the table with credentials that authenticate nowhere.
`api-keys.http.spec.ts` proves the round trip on a real create: the stored
`key_hash` equals `hashApiKey(plaintext)` and matches `/^[0-9a-f]{64}$/`, the
stored `key_prefix` equals `apiKeyPrefix(plaintext)` and is 12 characters, and
the plaintext is >= 24 characters and passes the shared shape check.

`apikey.go` was read and not touched.

### Verified

`build` passes; the full suite passes — **474 tests, 23 suites** with every
agent's work in the tree, of which **77 tests in 4 suites** are mine
(`projects.http.spec.ts`, `slug.spec.ts`, `api-keys.http.spec.ts`,
`api-key-state.spec.ts`). Both HTTP suites run a real Nest app on a real port
with the real guards, the real `ValidationPipe` settings from main.ts and the
real exception filter, over `authz/testing/tenant-prisma.fake.ts`. Neither
harness imports `PrismaService` — the providers are constructed around the fake
— so the eslint ban holds for the tests too.

Covered, all as negatives with the victim row asserted untouched: org A cannot
list, create in, read, rename or delete anything of org B's (404 with
`CROSS_TENANT_MESSAGE`, including B's project id under A's path and B's key id
under A's project); environment immutability from three directions; slug
collision on create and on update (409 naming the slug, from a real
`PrismaClientKnownRequestError`); slug uniqueness being per-organization; the
plaintext key appearing exactly once and in no list, revoke or audit row; a
revoked key being labelled and a second revoke changing nothing; a viewer
refused the key inventory; a developer refused a `members.write` scope; and a
suspended project readable but not writable.

**`lint` cannot currently be run, and not because of these modules.**
`apps/control-api/.eslintrc.json` (someone else's in-flight edit) has a `"//"`
comment key inside `overrides[1]`, which ESLint rejects outright:
`Unexpected top-level property "overrides[1].//"`. It fails before any file is
read, so the whole package is unlintable. The fix is to move that note out of the
override object (a `//` key is legal at the top level of the config, not inside
an `overrides` entry). Both of my directories lint clean under a config identical
to the committed one minus that entry, `no-restricted-imports` included.

Two things a live database should still confirm, since none was reachable:
that PostgreSQL raises the `(organization_id, slug)` P2002 with a `meta.target`
in one of the two shapes `unique-violation.ts` matches, and that `updateById`'s
`updateMany`-plus-read-back sees its own write under READ COMMITTED (it runs in
one `$transaction`; the fake cannot prove isolation).

## Organizations + memberships (Phase 2)

Owned files: `src/organizations/**`, `src/members/**`. Nothing else was touched
except `.eslintrc.json` (one allowlist entry — see below).

### Module registration — please wire these up

```ts
// app.module.ts, in imports, after AuthzModule:
import { OrganizationsModule } from './organizations';
import { MembersModule } from './members';
    OrganizationsModule,
    MembersModule,
```

`MembersModule` imports `OrganizationsModule`, so registering both is only for
route discovery; order between them does not matter.

### Routes

```
GET    /v1/organizations                                 user-scoped
POST   /v1/organizations                                 user-scoped
GET    /v1/organizations/:orgId                          projects.read
PATCH  /v1/organizations/:orgId                          projects.write
DELETE /v1/organizations/:orgId                          projects.write + owner
GET    /v1/organizations/:orgId/members                  members.read
POST   /v1/organizations/:orgId/members                  members.write   (202, invite)
PATCH  /v1/organizations/:orgId/members/:memberId        members.write
DELETE /v1/organizations/:orgId/members/:memberId        members.write
POST   /v1/invitations/accept                            user-scoped
```

Redemption is at `/v1/invitations/accept`, NOT under `:orgId`: the invitee is
not a member yet, so a nested route would be resolved by `TenantGuard` and 404
— correctly. A top-level prefix also keeps it out of the `:orgId` route table,
where `/organizations/invitations/...` would depend on controller registration
order not to be captured by the parameter.

### The untenanted-route problem

`GET`/`POST /v1/organizations` name no tenant, so `@Authorized()` cannot resolve
one (`TenantResolver.coordinatesFromParams` throws `internal_error` there, on
purpose). Rather than `@UseGuards(SessionGuard)` plus an inline
`where: { members: { some: { userId } } }`, there is now a named primitive with
the same shape and failure posture as the tenant layer:

- `@UserScoped()` mounts `SessionGuard` + `UserScopeGuard` in that order, as one
  decorator, so the pair cannot be half-mounted.
- The principal is derived from `request.sessionUser` only — never a param, body
  field or header. No code path lets a caller state a user id.
- `UserScope.create` **throws** on a principal with no user id. Prisma reads
  `{ userId: undefined }` as "no filter", so failing closed is the only safe
  answer to an empty principal.
- Every read puts the principal's user id in the WHERE clause; both writes
  (`createOwnedOrganization`, `joinOrganization`) take no user id argument at
  all, so neither can create a membership in someone else's name.
- It uses its own metadata key, so `assertRoutesAreGuarded` is unaffected.

**These belong in `src/authz` once reviewed** (`user-scope.ts` next to
`tenant-scope.ts`). Three files carry the unscoped client and are allowlisted by
exact filename in `.eslintrc.json` — I added one `overrides` entry; please check
it survived any concurrent edit:

| file | why it exists |
|---|---|
| `organizations/user-scope.ts` | the primitive above |
| `organizations/user-directory.ts` | resolves `users`, which `TenantScope` deliberately does not cover, so a member list can show who the members are |
| `organizations/tenant-transaction.ts` | nothing in authz can START a transaction, and the role lattice needs one (below) |

`OrganizationsModule` exports all three purely so `MembersModule` need not
re-invent them; that export list is what should disappear when they move.

### Requested changes inside src/authz (not made — I own neither file)

From the concurrent security review of the lattice. What I could enforce in my
own service, I did (see the `MembersService` docblock); these would make it
structural instead of conventional:

1. **`assertMemberCreationAllowed(actorRole, targetRole)` in
   `permissions.ts`.** There is no creation-side assertion, so
   `members.create({ userId, role: 'owner' })` mints an owner with no check at
   all. `mayAssignRole` already encodes the rule; it just is not named as an
   assertion, so a module author has nothing to fail to call.
   *Meanwhile:* `MembersService` never calls `members.create`. The only
   membership-creating path is `UserScope.joinOrganization`, and the role is
   gated by `mayAssignRole` twice — at issue and again at redemption.
2. **Make `role` and `userId` unwritable on the `members` repository**, the way
   `organizationId`/`projectId` already are — or add a purpose-built
   `members.changeRole(id, next)` that runs the lattice itself.
   `OrganizationMemberUncheckedUpdateManyInput` accepts both today, so
   `updateById(id, { role: 'owner' })` skips the lattice and
   `updateById(id, { userId: <someone else> })` re-points an existing membership
   at another account — a takeover that audits as a role change.
   *Meanwhile:* `changeRole` is the only method in my module that writes `role`,
   it calls `assertRoleChangeAllowed` first every time, and no DTO in the module
   declares a user id (`forbidNonWhitelisted` turns an attempt to supply one
   into a 400 — tested).
3. **`TenantScopeFactory.transaction(context, fn)`.** `TenantScope.withClient`
   says "use inside `$transaction`", but no exported thing can open one, so a
   module needing atomicity had to choose between injecting `PrismaService` and
   not being atomic. `RoleChange.ownerCount`'s own docblock says the count must
   be inside the writing transaction or concurrent demotions leave zero owners.
   `tenant-transaction.ts` is that method, in the wrong place.

### Findings worth acting on

- **`ScopedRepository.notFound()` still says `"<Resource> not found."`** while
  `TenantResolver` says `CROSS_TENANT_MESSAGE` ("Resource not found."). Not an
  oracle today — every id on a given route gets the same string — but it is two
  spellings of one policy, and the next route to mix them will not be. Suggest
  `notFound()` return `CROSS_TENANT_MESSAGE` and keep `resourceName` for logs.
- **The permission matrix has no `organizations.write`.** The closest declared
  gate for the `organization` accessor is `projects.write`, which `admin` holds,
  and letting an admin retire the tenant that owns everyone else's data is a
  bigger grant than "may create projects". `DELETE /v1/organizations/:orgId`
  therefore carries `@Authorized('projects.write')` **plus** an explicit
  `role === 'owner'` check in the service. If a real `organizations.write` /
  `organizations.delete` row lands, move the check onto it.
- **The last-owner branch of the lattice is defensive-only.** Demoting or
  removing an owner requires owner rank, and self-modification is refused, so
  actor and target are two distinct owners and `ownerCount >= 2` in any
  consistent snapshot. What actually keeps the last owner in place is the
  self-modification rule. The branch is still reachable under a race — a
  concurrent removal of the other owner between guard and handler — and that is
  exactly how it is tested.
- **A refused redemption burns the invitation token.** `TokenService.consume` is
  a conditional UPDATE and runs before the organization/inviter checks, so an
  invitation refused at (3) cannot be retried and must be re-issued. The
  alternative — a token that survives every failed check — is worse for a
  credential that grants membership, but the inviter-facing UX is worth knowing.
- **No rate limit on `POST /v1/organizations`.** `@Throttle` is per-IP, which
  behind a proxy would deny service to real users on an authenticated route.
  A per-user cap on owned organizations is the better shape; not built.
- **Suspended organizations refuse new members.** `accept` requires
  `status === 'active'`.

### Dashboard notes (not mine to edit)

`apps/dashboard/src/features/organizations/api.ts` will need the shapes above.
Three that will surprise a client written against a normal CRUD API:

- `POST /v1/organizations/:orgId/members` returns **202 `{status:'accepted'}`**
  and creates nothing. Show "invitation sent", never "member added", and never
  branch on whether the address was already a member — the response is identical
  by design.
- `DELETE /v1/organizations/:orgId` is **204** and soft; the organization stays
  in the database and every route under it starts answering 404.
- `POST /v1/invitations/accept` requires a session. The invite link must land on
  a page that signs the user in (or registers them) first, then POSTs the token.

### Verified

`lint`, `build` and `test` all pass for `@webhook/control-api`: **671 tests, 32
suites** across the whole package, of which **85 in 4 suites** are new here
(`organizations.service.spec.ts`, `organizations.http.spec.ts`,
`members.service.spec.ts`, `members.http.spec.ts`). Still no live database —
everything runs against `src/organizations/testing/world.ts`, which composes
`authz/testing/tenant-prisma.fake.ts` and adds `user_tokens`, real unique
constraints on `organizations.slug` and `(organization_id, user_id)`,
transaction rollback, and a per-transaction statement log so "the owner count is
taken inside the writing transaction" is asserted rather than asserted-in-a-
comment.

---

## Endpoints and endpoint-secrets (2026-09-06) — `src/endpoints`, `src/endpoint-secrets`

Two modules, one invariant between them. Nothing outside those two directories
was edited.

### Module registration — for whoever owns `app.module.ts`

```ts
import { EndpointSecretsModule } from './endpoint-secrets/endpoint-secrets.module';
import { EndpointsModule } from './endpoints/endpoints.module';
```

and, in `imports`, after `AuthzModule`:

```ts
    EndpointsModule,
    EndpointSecretsModule,
```

`EndpointsModule` already imports `EndpointSecretsModule`, so listing the second
is redundant for the DI graph; it is listed because a controller that appears in
the route table only as a side effect of another module's `imports` is the kind
of thing nobody finds later. Neither module imports `PrismaModule`, and neither
mentions `PrismaService`.

### Routes

```
GET    /v1/projects/:projectId/endpoints              endpoints.read
POST   /v1/projects/:projectId/endpoints              endpoints.write
GET    /v1/projects/:projectId/endpoints/:endpointId  endpoints.read
PATCH  /v1/projects/:projectId/endpoints/:endpointId  endpoints.write
POST   .../:endpointId/enable                          endpoints.write
POST   .../:endpointId/disable                         endpoints.write
DELETE .../:endpointId                                 endpoints.write   (soft delete, 204)

GET    /v1/endpoints/:endpointId/secrets               endpoint-secrets.read
POST   /v1/endpoints/:endpointId/secrets/rotate        endpoint-secrets.write
DELETE /v1/endpoints/:endpointId/secrets/:secretId     endpoint-secrets.write
```

`docs/API.md` writes the rotate route as `secrets:rotate`; it is `secrets/rotate`
here, because a colon in a path segment is a route-parameter sigil in Nest and
Express and the escaping is not worth the aesthetic. Update `docs/API.md` or say
so and I will change it.

The secrets controller carries `@ResolveTenantFrom('endpoint', 'endpointId')` at
the class level — the tenant is not in that path, so the resolver walks
endpoint → project → organization in the database and checks membership at the
top of it. The endpoints controller resolves from `:projectId` alone.

---

### THE ONE CHANGE I NEED IN `src/authz` — `ScopedRepository.create`

**Rotation is blocked without it.** `scope.endpointSecrets.create(...)` throws
today:

> Endpoint secret rows are scoped through a parent and cannot be created by a
> scoped repository; create them alongside their parent inside a transaction.

Rotation *is* that write — a new `endpoint_secrets` row for an endpoint that
already exists — and there is no parent transaction to create it alongside.
`PrismaService` is banned in these modules and should stay banned, so this is
the change, in `tenant-scope.ts` and nowhere else. Endpoint creation depends on
it too, because creating an endpoint mints its version 1 secret.

**1. Add, next to `tenantColumns`:**

```ts
/**
 * Tables whose tenancy comes from a parent ROW rather than from a column, and
 * the foreign key that names that parent. A create against one of these is
 * legal exactly when that key is present in the payload and resolves inside the
 * caller's tenant through its own scoped repository - which is the same proof
 * `create` already demands of every other tenant-owned foreign key.
 */
const PARENT_KEY: Partial<Record<TenantScopeKind, string>> = {
  viaEndpoint: 'endpointId',
  viaDelivery: 'deliveryId',
};
```

**2. Replace the opening of `create`:**

```ts
  async create(data: ScopedCreateInput<TCreate>): Promise<TRecord> {
    const columns = tenantColumns(this.kind, this.context);
    const parentKey = PARENT_KEY[this.kind];
    if (!columns && !parentKey) {
      throw new AppError(
        'internal_error',
        `${this.resourceName} rows are scoped through a parent and cannot be created by a scoped repository; create them alongside their parent inside a transaction.`,
      );
    }

    const payload = this.sanitize(data, 'create');

    if (!columns && parentKey) {
      // There is no tenant column to stamp: the parent IS the tenancy, so it
      // must be stated, and it must be a declared foreign key so that
      // assertForeignKeysOwned below actually resolves it.
      const parent = payload[parentKey];
      if (typeof parent !== 'string' || parent.length === 0) {
        throw new AppError(
          'invalid_request',
          `${this.resourceName}: '${parentKey}' is required - it is what places this row in a tenant.`,
        );
      }
      if (!this.foreignKeys[parentKey]) {
        throw new AppError(
          'internal_error',
          `${this.resourceName} does not declare '${parentKey}' in its foreignKeys map; add it in tenant-scope.factory.ts or this row could be created under another tenant's parent.`,
        );
      }
    }

    await this.assertForeignKeysOwned(payload);
    return this.delegate.create({ data: { ...payload, ...(columns ?? {}) } as TCreate });
  }
```

**Why this is safe, precisely.** `assertForeignKeysOwned` resolves every declared
foreign key present in the payload through *its own* scoped repository, so
`endpointId` goes through `scope.endpoints.requireById`, which has the tenant
predicate in its WHERE clause. A parent in another tenant matches no row and the
call is a 404 **before any insert is issued** — the child row cannot be created
under a foreign parent, and it cannot be created with no parent at all. The
factory already declares what is needed (`endpointSecrets` and `endpointHealth`
→ `{ endpointId: 'endpoints' }`, `deliveryAttempts` → `{ deliveryId: 'deliveries' }`),
so **no change to `tenant-scope.factory.ts` is required.** `organizationSelf`
deliberately gets no `PARENT_KEY` entry and stays refused.

**3. The pinning test changes.** `tenant-scope.spec.ts` currently asserts the
refusal. Replace that case with the three that describe the new contract:

- `create` with no `endpointId` → `invalid_request`;
- `create` with **org B's** endpoint id, from an org A scope → `not_found`, and
  the row is not in the table afterwards;
- `create` with an owned endpoint id → succeeds and the row hangs off that
  endpoint.

The third one is already written and passing, in
`src/endpoint-secrets/endpoint-secrets.service.spec.ts`
("sanity: the harness really enforces the parent check on create") against the
shim described next.

**Until this lands**, `src/endpoint-secrets/testing/harness.ts` supplies
`withCreatableSecrets`, a Proxy that implements *exactly* the behaviour above
(require the key, resolve it through `scope.endpoints`, then insert) so the
suites are not vacuous. **Delete `withCreatableSecrets` and `testScopeFactory`'s
use of it the moment the change lands** — the tests should then run against the
real repository unmodified. Everything else in the harness stays.

---

### The signing invariant, and why it shapes both modules

`signing.Header` (`services/data-plane/internal/signing/signing.go`) returns
`ErrNoSecrets` when an endpoint has no active secret. It fails **closed** — it
will not emit a header without a `v1=` component, because `Verify` rejects one.
So:

> **A live endpoint must always have at least one active, unexpired secret.**

Four paths could break that; each is closed, and each has a test:

1. **Create.** The endpoint row is inserted `status: 'paused', enabled: false`,
   the version 1 secret is minted, and only then is it flipped to `active`.
   There is no transaction available (see above), so the *order* is the
   guarantee: an endpoint that is never active while it has no secret can never
   be dispatched to. If minting fails, the stub is marked `deleted` on the way
   out and the original error is what the caller sees.
2. **Enable.** Refused with `conflict` when the endpoint has no live secret.
3. **Rotate.** The new secret is INSERTed **before** the old ones are given an
   expiry. A crash between the two statements leaves two live secrets and a
   stale overlap — cosmetic, fixed by rotating again. The reverse order would
   leave a window with zero. **Do not reorder these two statements**, and when a
   transactional path exists, wrap the pair rather than swapping it.
4. **Revoke.** Refused with `conflict` when it is the last live secret of an
   endpoint that is not deleted. The caller is pointed at
   `rotate` with `overlap_seconds: 0`, which reaches the same end state without
   the outage — safe for exactly the reason in (3).

### Rotation contract — for the data-plane secret loader

Nothing in `services/data-plane` loads `endpoint_secrets` yet. When it does:

```sql
SELECT secret_encrypted, version
  FROM endpoint_secrets
 WHERE endpoint_id = $1
   AND active = true
   AND (expires_at IS NULL OR expires_at > now())
 ORDER BY version DESC;
```

`active = true` **and** an unexpired `expires_at` — both halves. `active` alone
keeps an expired secret in the header until a sweep runs; `expires_at` alone
resurrects a secret that was explicitly revoked. The control plane's
`isEffectivelyActive` (`src/endpoint-secrets/dto/index.ts`) is the same rule in
TypeScript and is what `GET .../secrets` reports as `active`. `active` is also
flipped to `false` lazily, on the next rotation, so the set stays small; do not
depend on that having happened.

Every row returned becomes one `v1=` in the header. During a rotation window
there are two, and a consumer verifying with either one passes — that is the
whole point, and `endpoint-secrets.service.spec.ts` proves it by rebuilding
`Sign`/`Header`/`Verify` in TypeScript and checking both secrets verify the same
header.

Plaintext is AES-256-GCM at rest via `CryptoService`, with the AAD bound to
`{ table: 'endpoint_secrets', id: <secret id>, owner: <endpoint id> }`. Decrypt
with exactly those three or it will not open. Secrets are `whsec_` + 32 random
bytes base64url; **the prefix is part of the key** — HMAC over the whole string.

### URL validation is a MIRROR, not a replacement

`src/endpoints/endpoint-url.ts` refuses non-http(s) schemes, credentials in the
URL, `localhost`/`*.localhost`, and literal private, loopback, link-local,
CGNAT, documentation, benchmarking, reserved and cloud-metadata addresses,
including the obfuscations (decimal/hex/octal IPv4, IPv4-mapped IPv6, and 6to4 /
NAT64 addresses that embed an IPv4 destination). The ranges and the wording
track `services/data-plane/internal/egress/ssrf.go`.

**`internal/egress/ssrf.go` remains the authority, and nothing may be removed
from it because this exists.** This check runs on a different host at save time
and cannot see what a hostname resolves to; `Guard.CheckIP` runs as
`net.Dialer.Control`, after resolution and immediately before connect, which is
the only placement that defeats DNS rebinding. Most customer URLs are hostnames,
and every one of them passes this check and is judged there. This is a usability
mirror — it tells a customer their URL is unusable when they press Save instead
of letting them accumulate blocked deliveries — and it is a strict subset by
construction. The file's docblock says all of this; keep it if the file moves.

### Reserved custom headers

`custom_headers` is tenant-controlled and merged into the outbound request, so
`Webhook-*` (the whole namespace), `Authorization`, `Host`, `Content-Length` and
`Transfer-Encoding` are refused at save time, case-insensitively, along with
CR/LF in a value, non-token names, and two spellings of one name. Refused rather
than filtered at delivery time: a silent filter is a support ticket, and it puts
the check in the data plane's hot path where forgetting it is a silent
vulnerability instead of a failing test.

The `Webhook-*` ban is not tidiness. `signing.Verify` accepts a delivery if
**any** `v1=` component matches — which is exactly what makes the overlap window
work — so a tenant that could add a second `Webhook-Signature` would be handing
the consumer a signature the platform never computed, next to one it did.

### For the dashboard agent

- `POST /v1/projects/{id}/endpoints` returns `201` with the endpoint **plus**
  `secret` and `secret_version`. `secret` is the plaintext and is **null** when
  the caller does not hold `endpoint-secrets.write` (i.e. for a `developer`).
  Show it once, with a "copy it now" affordance; there is no way to retrieve it.
- `POST /v1/endpoints/{id}/secrets/rotate` returns `previous_secrets_expire_at`
  and `overlapping_versions`. Surface them: "your old secret keeps working until
  X" is the whole reason rotation is safe, and a UI that hides it will get
  consumers broken by people who assume a swap.
- `endpoint-secrets.read` is **owner/admin only**. A viewer or developer gets
  `403` on the secrets routes while `200` on the endpoint itself; hide the tab
  rather than letting them click into a 403.
- `DELETE` is a soft delete and returns `204`. The endpoint keeps appearing in
  `GET /endpoints/{id}` with `status: "deleted"` so a delivery row can still be
  explained; it is hidden from the list unless `include_deleted=true`.

### Two observations for the authz owner, not fixed here

- **`ScopedRepository.notFound()` still uses `${resourceName} not found.`**, not
  `CROSS_TENANT_MESSAGE`. Within one repository that is not an oracle — absent
  and foreign give the identical string — but it is a *different* string from
  the one every other 404 in the control plane now uses, so a module that mixes
  `requireById` with its own `CROSS_TENANT_MESSAGE` throw creates a
  distinguishable pair. These two modules therefore never call `requireById` on
  a caller-supplied id; they use `findById` and raise `CROSS_TENANT_MESSAGE`
  themselves, and they pre-resolve `retry_policy_id` so the repository's internal
  FK check cannot surface "Retry policy not found." either. Changing
  `notFound()` to the constant would let the next module just use `requireById`.
- **`create` does not fill Prisma defaults in the fake.** `seedWorld` seeds no
  `created_at`, which is a shape PostgreSQL cannot produce (`NOT NULL DEFAULT
  now()`); `harness.ts` backfills rather than making the response mappers
  tolerate impossible rows. Worth adding to the fixture if other modules trip
  on it.

### Verified

`pnpm --filter @webhook/control-api lint`, `build` and `test` all pass with
everything in the tree — **671 tests, 32 suites**, of which 112 in 5 new suites
here: `endpoints/endpoint-url.spec.ts` (40 cases, lifted from
`egress/ssrf_test.go`), `endpoints/endpoint-headers.spec.ts`,
`endpoints/endpoints.service.spec.ts`, `endpoints/endpoints.http.spec.ts` (real
Nest, real guards, real `ValidationPipe` and exception filter, on a real port)
and `endpoint-secrets/endpoint-secrets.service.spec.ts`.

Still no live database: everything runs against
`authz/testing/tenant-prisma.fake.ts`. Three things a live run should confirm —
that the relation-filter join `endpoint_secrets → endpoints → projects` produces
the SQL these tests assume; that the `(endpoint_id, version)` unique index really
serialises two concurrent rotations into one `conflict` (the P2002 path is
exercised with a stubbed error, not a real race); and that `updateById`'s
`updateMany`-plus-read-back sees its own write under READ COMMITTED.
