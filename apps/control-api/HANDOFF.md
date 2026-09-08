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

## Authz residual fixes (2026-09-06) — `src/authz`, `.eslintrc.json`

Five findings from the third pass. Code only, no schema change. `lint`, `build`
and the whole `src/authz` suite pass.

### FIX 1 — `create` on a parent-scoped table now works, and is stricter

**Landed exactly as specified above.** `PARENT_KEY` (`viaEndpoint → endpointId`,
`viaDelivery → deliveryId`) sits next to `tenantColumns` in `tenant-scope.ts`, and
`create` requires the parent key, requires it to be a declared foreign key, and
resolves it through the sibling scoped repository *before* the insert.
`organizationSelf` has no entry and stays refused. No change to
`tenant-scope.factory.ts` was needed.

Net effect: a parent-scoped row cannot be created with no parent, and cannot be
created under another tenant's parent (404, before any INSERT). That is a
stronger guarantee than the blanket refusal it replaces.

> **ACTION FOR THE ENDPOINT-SECRETS OWNER: `withCreatableSecrets` in
> `src/endpoint-secrets/testing/harness.ts` is now obsolete and must be deleted,**
> along with `testScopeFactory`'s use of it. The suite currently proves the
> behaviour of a Proxy shim; it should run against the real repository, which
> implements the same contract. I did not delete it — that file is under review.
> Everything else in the harness stays.

### FIX 2 — `requirePredicate` counted keys, so the empty conjunction walked past

`updateMany({})` threw; `updateMany({ AND: [] })` did not, and matched every row
in the tenant — the one guard between a typo and an organization-wide rewrite.
`isEmptyPredicate` is now recursive: an empty object, an empty/all-empty
`AND`/`OR`/`NOT`, and nested combinations of those (`{ AND: [{ AND: [] }] }`) are
all empty at every depth. Deliberately conservative — `{ OR: [] }` arguably means
"match nothing" in Prisma, and is still refused, because a caller who means
nothing can say so and the cost of guessing wrong the other way is every row.

### FIX 3 — the lint fence covered a path, not the class

`import { PrismaClient } from '@prisma/client'; new PrismaClient()` was
unrestricted and handed a feature module the same unscoped client the
`**/prisma.service` pattern bans. `.eslintrc.json` now carries a `paths` entry
restricting the **`PrismaClient` import name only**, so type-only imports of the
generated types (`Prisma`, `Endpoint`, `Delivery`, …) are untouched. Every
existing allowlist override still applies verbatim, including `**/testing/**` and
`*.spec.ts`.

### FIX 4 — "I processed everything" is now expressible

`findMany()` truncated at `DEFAULT_PAGE_SIZE` and returned a bare array, so a
bulk operation over the result ("revoke every API key", "disable every endpoint
on suspension", "expire every secret older than N") covered 50 rows and reported
success. Three changes in `tenant-scope.ts`:

- **`findPage(args)` → `Page<T> = { rows, hasMore, nextSkip }`.** Reads `take + 1`
  and discards the probe row, so a full page is distinguishable from a complete
  one. `Page` is exported from `src/authz`.
- **`forEachPage(handler, { where, pageSize })` → number of rows processed.** Pages
  to exhaustion by **keyset** (`WHERE id > <last seen>`), not by `skip`,
  deliberately: an offset walk over rows the handler is mutating — the usual
  reason to want this — shifts the window and skips rows. Iteration order is
  primary key ascending.
- **`findMany` with an explicit `take` is unchanged** (the caller declared a page).
  **`findMany` with no `take` now throws `internal_error` when it would have
  truncated**, naming `findPage`/`forEachPage`. Every current module caller passes
  an explicit `take`, so nothing breaks today.
- **`groupBy` is bounded.** The ceiling applied only when `take` was given; an
  omitted `take` was an unbounded read. It is now capped at `MAX_PAGE_SIZE`, and a
  defaulted rollup that overflows throws rather than returning a silently partial
  one. `orderBy` defaults to the grouped columns ascending, because `take` on a
  `groupBy` needs an order to be stable (and Prisma requires one).

> **ACTION FOR MODULE OWNERS — two call sites are the dangerous shape:**
>
> 1. `src/endpoint-secrets/endpoint-secrets.service.ts` `secretsFor()` reads
>    `findMany({ where: { endpointId }, take: MAX_PAGE_SIZE })` and then makes
>    rotation/expiry decisions across the result **as if it were every secret**. At
>    201 secrets on one endpoint that silently becomes wrong, and it is the exact
>    "expire every secret older than N" shape. Use `forEachPage`, or `findPage`
>    and refuse loudly on `hasMore`.
> 2. The list endpoints in `projects`, `endpoints`, `api-keys` and `members` page
>    correctly but return no `has_more`/next-cursor to the client, so an API
>    consumer has the same problem one layer out. `findPage` now gives you the
>    flag; surfacing it is an API-contract change for `docs/API.md`.

### FIX 5 — the cross-tenant 404 reason was invisible in production

`TenantResolver.crossTenant` logged the per-resource reason at `debug`, and
`app.module.ts` defaults `LOG_LEVEL` to `info`, so an operator got neither the
message on the wire (by design) nor the line in the log. It is now
`logger.log` (info). The reason contains only ids the request already supplied
plus the organization id we resolved for the caller; it still never crosses the
wire, and `tenant-resolver.spec.ts` asserts both halves — emitted at info,
absent from `AppError.message`.

### Note on the test run

`src/members/zz-probe.spec.ts` (untracked, written by the concurrent members
reviewer) fails with two deliberate probes showing a last-owner race in
`MembersService`. Unrelated to `src/authz` — it fails identically with these
changes reverted. Everything else passes: 681 of 683.

---

## Projects and API keys — review hardening (2026-09-07) — `src/projects`, `src/api-keys`

Second pass over the two modules after two independent reviews. Nothing here was
a live tenant-isolation defect; all five items are hardening or consistency.

### FIX 1 — throttles and ceilings on the write routes

Neither module limited anything, while every `AuthModule` route did. Both create
routes were authenticated but unbounded in rate AND in total.

- `POST /v1/organizations/:orgId/projects` — `@Throttle` 20/min per address.
- `POST /v1/projects/:projectId/api-keys` — `@Throttle` 10/min.
- `POST /v1/projects/:projectId/api-keys/:apiKeyId/revoke` — `@Throttle` 60/min,
  deliberately loose. Revocation is what an operator does under pressure, often
  from a script with retries; a tight limit there would cause the incident it
  was added to contain. It is a **separate bucket** from create, so a tripped
  create limit cannot stop a revoke.

`ThrottleGuard` is mounted at CLASS level on both controllers, so it runs before
the route-level `SessionGuard`/`TenantGuard` that `@Authorized` mounts — a flood
is refused before it costs a session lookup and a tenant resolution. Only
handlers carrying `@Throttle` are limited; the listings are not.

The throttle numbers are compile-time constants (`projects/project-limits.ts`,
`api-keys/api-key-limits.ts`) because `@Throttle` is decorator metadata,
evaluated when the class is defined — which is **before** `ConfigModule` has read
a `.env` file. An env-driven value there would silently always be the default.

Ceilings, read through `ConfigService` at call time so they can be raised without
a deploy:

| Var | Default | Clamp | Counts |
|---|---|---|---|
| `MAX_PROJECTS_PER_ORGANIZATION` | 100 | 1–10 000 | projects with `status != deleted` |
| `MAX_API_KEYS_PER_PROJECT` | 50 | 1–1 000 | keys with `revoked_at IS NULL` |

Neither is in `config/env.schema.ts` — that file is owned elsewhere and zod
strips unknown keys, but `ConfigService.get` falls back to `process.env`, so they
work today. **Adding them to the schema is a good idea** and would move the
clamping to boot time; the clamp in the limits module can stay as the belt.

Two counting decisions, both deliberate and both tested:

- **Deleted projects do not count.** A soft-deleted project keeps its slug and
  its whole delivery ledger forever, so counting them would make the ceiling a
  ratchet with no operation available to a tenant that frees a slot. `DELETE` is
  that operation.
- **Revoked keys do not count; expired keys do.** Same ratchet argument for
  revocation. Expiry is excluded from the exemption because `status` is derived
  from two timestamps at read time and is not a column — filtering it out would
  need a `now()` comparison in SQL that disagrees with the derivation by a
  request's worth of clock, and the ceiling would then move on its own with
  nobody touching anything. Revoke an expired key to free its slot.

**Both ceilings are advisory under concurrency.** Two racing creates can both
read `existing = ceiling - 1` and both insert, so the true bound is
`ceiling + concurrent writers`. Holding it exactly needs a serializable
transaction or a counter column on the parent, and paying for either on every
create to stop a tenant reaching 101 instead of 100 is the wrong trade. If a hard
limit is ever needed, the cheap form is a `projects_count` / `api_keys_count`
column on the parent row, incremented in the same transaction as the insert and
guarded by a CHECK constraint.

### FIX 2 — API-key scopes are a snapshot with no issuer. THIS NEEDS A MIGRATION.

`ApiKeysService.resolveScopes` correctly refuses any scope the caller does not
hold, which closes the self-escalation `api-keys.write` would otherwise be for a
`developer`. What it does **not** do is bind the key to the human who minted it,
and nothing re-checks the scopes after issuance.

The scenario, once key-authenticated control routes exist: a developer mints a
key carrying `endpoints.write` and `events.replay`, is then demoted to `viewer`
or removed from the organization entirely, and the key retains full developer
authority indefinitely. It is LOW today only because the ingest path does not
consult `scopes` at all (`internal/ingest/handler.go` authenticates on the key,
its project and its environment). The first key-authenticated control route makes
it real.

**What I did without a schema change.** `api_key.created` audit metadata now
carries `created_by_user_id`, `created_by_membership_id` and `created_by_role`.
The audit row's actor column already held the user id; the **role** was recorded
nowhere, and it is exactly what a re-derivation has to compare the stored scopes
against. This is also the backfill source for the migration below.

**The exact migration required** (I do not own `prisma/schema.prisma`):

```prisma
model ApiKey {
  // ...existing fields...
  createdByUserId       String?  @map("created_by_user_id")
  createdByMembershipId String?  @map("created_by_membership_id")

  createdByUser       User?               @relation("ApiKeyCreatedBy", fields: [createdByUserId], references: [id], onDelete: SetNull)
  createdByMembership OrganizationMember? @relation("ApiKeyCreatedByMembership", fields: [createdByMembershipId], references: [id], onDelete: SetNull)

  @@index([createdByMembershipId])
  @@index([createdByUserId])
}
```

```sql
-- api_keys: record who minted a key, so its scopes can be re-derived.
ALTER TABLE "api_keys"
  ADD COLUMN "created_by_user_id"       TEXT,
  ADD COLUMN "created_by_membership_id" TEXT;

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "api_keys_created_by_membership_id_fkey"
    FOREIGN KEY ("created_by_membership_id") REFERENCES "organization_members"("id") ON DELETE SET NULL;

CREATE INDEX "api_keys_created_by_membership_id_idx" ON "api_keys" ("created_by_membership_id");
CREATE INDEX "api_keys_created_by_user_id_idx"       ON "api_keys" ("created_by_user_id");
```

Both columns are NULLABLE and both FKs are `ON DELETE SET NULL`, deliberately:

- Existing rows have no issuer and must not block the migration. Backfill from
  `audit_logs` where you can — `action = 'api_key.created' AND resource_id =
  api_keys.id`, taking `user_id` and `metadata->>'created_by_membership_id'` —
  and leave the rest NULL.
- `RESTRICT` would make a key un-mintable-by a user who can then never be
  deleted, and `CASCADE` would delete the credential (and orphan its delivery
  history) when a person leaves. Neither is right; `SET NULL` plus the rule below
  is.
- Both columns are needed. `created_by_user_id` survives the membership being
  deleted and is what an operator wants in the UI; `created_by_membership_id` is
  what the role lookup joins to, and its going NULL is itself the signal that the
  issuer has left.

**The enforcement, once the columns exist.** Two options; the second is stronger
and I recommend it, but they compose.

1. *Re-derive at authentication time.* Wherever a key authenticates a
   control-plane request, compute
   `effective = key.scopes INTERSECT permissionsForRole(currentRoleOf(created_by_membership_id))`
   and authorize on `effective`, never on `key.scopes`. A NULL
   `created_by_membership_id` (issuer removed) yields the empty set, so the key
   keeps working for ingest — which does not read scopes — and can do nothing on
   the control plane. Cache the role lookup per request, not across requests: the
   whole point is that a demotion takes effect immediately.
2. *Auto-revoke on membership removal.* In the same transaction that deletes an
   `organization_members` row, stamp `revoked_at = now()` on every non-revoked
   `api_keys` row whose `created_by_membership_id` is that membership, and write
   one `api_key.revoked` audit entry per key with
   `metadata.reason = 'issuer_membership_removed'`. This belongs in
   `MembersService.remove` (the `src/members` owner, not me) and needs the
   membership id, which is why the column is there rather than only the user id.
   It changes the removal path from "authority silently persists" to "credentials
   die with the person", which is the behaviour an auditor expects.

Option 1 alone leaves live credentials in the wild that merely do nothing;
option 2 alone leaves keys minted by someone who was demoted rather than removed.
Do both.

Whoever applies this should also add `created_by_user_id` to `ApiKeyDto` (it is
safe to publish — it is a member of the caller's own organization) so the
operator surface can answer "who minted this?" without reading `audit_logs`.

### FIX 3 — both list endpoints now return a page, not a bare array

`GET /v1/organizations/:orgId/projects` returns `ProjectListDto` and
`GET /v1/projects/:projectId/api-keys` returns `ApiKeyListDto`, both
`{ data, count, has_more, next_offset }`, built on `ScopedRepository.findPage`.
`findMany` is no longer usable here anyway — it throws when a result overflows
the default page and no `take` was given, which for the key listing would have
been a 500 on the fifty-first key.

`has_more` is the fix, not `count`: a caller receiving exactly `limit` rows could
not previously tell a full page from a complete result, and the reason to
enumerate a project's keys is usually "revoke everything that can authenticate as
us". `next_offset` is null on the last page. The OpenAPI decorators are updated
(`@ApiOkResponse({ type: ProjectListDto })`, `ApiKeyListDto`), so the generated
dashboard client changes shape — **both list responses are breaking for any
existing consumer**, which is fine today because nothing consumes them yet.

### FIX 4 — one 404 vocabulary

Both modules now answer every `not_found` with `CROSS_TENANT_MESSAGE`
("Resource not found."), matching `endpoints` and `endpoint-secrets`. Neither
vocabulary was an oracle — a per-resource message is only ever emitted for an id
inside an already-resolved tenant, where absent and foreign produce the identical
string — but two idioms in one API is a trap for the eight modules still to be
written.

Implemented as a three-line `withCrossTenantNotFound()` wrapper in each module
(`src/projects/not-found.ts`, `src/api-keys/not-found.ts`) that rewrites ONLY
`AppError`s with code `not_found`. Nothing useful is lost: the only thing the
repository message carried was the resource type, which the route already states.
The distinctions that matter inside the tenant — the slug conflict, the expiry in
the past, the scope the caller does not hold, the ceiling — are different codes
and are untouched.

**The duplication is deliberate.** The right home for this is
`ScopedRepository`'s own `notFound()`, or a helper in `src/common`; I own
neither. If the authz owner wants it, the one-line version is to make
`ScopedRepository.notFound()` return `new AppError('not_found',
CROSS_TENANT_MESSAGE)` and delete both wrappers — but note that `src/members`
deliberately emits "Member not found." and would need to be checked first.

### FIX 5 — boolean query parameters: not applicable here

`?flag=false` parsed with `@Type(() => Boolean)` is `Boolean('false') === true`.
**Neither of my modules has a boolean query parameter.** `ListProjectsQueryDto`
carries `status` (an enum), `limit` and `offset`; `ListApiKeysQueryDto` carries
`limit` and `offset` only. Nothing to fix and nothing to pin. If one is ever
added here, the idiom is
`@Transform(({ value }) => value === true || value === 'true' || value === '1')`.

### Verified

`pnpm --filter @webhook/control-api lint && build && test` — all three pass,
once the concurrent `src/organizations`, `src/members`, `src/endpoints` and
`src/endpoint-secrets` work had landed. **33 suites, 724 tests, all passing.**

New regression tests, one per fix:

- Both ceilings — reached and refused with 409 and `details.limit`/`current`,
  writing neither a row nor an audit entry; freed by `DELETE` (projects) and by
  revoke (keys); clamped rather than obeyed when configured to 0; and applied per
  project rather than per organization for keys.
- All three throttles — 429 with `Retry-After` and
  `details.retry_after_seconds`, create and revoke in separate buckets, the
  listings unthrottled.
- `has_more` at **exactly** the page boundary, asserted in both directions (a
  full page that is the last one, and a full page that is not), plus a walk to
  exhaustion through `next_offset` that returns every key once.
- The 404 alignment across absent, foreign-but-real, and cross-tenant, asserting
  both that the message IS `CROSS_TENANT_MESSAGE` and that it is not the old
  per-resource string.
- Issuer provenance in the `api_key.created` audit metadata.

## Endpoints and endpoint-secrets — review hardening (2026-09-07) — `src/endpoints`, `src/endpoint-secrets`

Seven findings from two independent reviews, plus the paginated-read migration.

**1 (HIGH, execution-confirmed). Two concurrent revokes left an ACTIVE, ENABLED
endpoint with ZERO live signing secrets.** `revoke` was read-then-check-then-write
with no transaction: two `DELETE /v1/endpoints/:id/secrets/:secretId`, one for v1
and one for v2, each snapshotted both secrets, each computed the OTHER as its
survivor, and both wrote. `signing.Header` fails closed, so every delivery to that
endpoint failed permanently and silently. A second interleave — a revoke landing
between rotation's INSERT of v2 and its expiry of v1 — was reachable through the
`overlap_seconds: 0` leak playbook this service documents.

`rotate` and `revoke` now run snapshot → check → write inside one
`TenantTransactionRunner.run`, and `assertStillSigning` re-counts the invariant
after the write, inside the transaction, so a violation rolls back rather than
commits.

> **DEPENDENCY, and it changed under us mid-task.** The plan was an explicit
> `SELECT ... FROM endpoint_secrets WHERE endpoint_id = $1 FOR UPDATE` in both
> paths. While this was being written, `TenantTransactionRunner` was hardened to
> open every transaction at **SERIALIZABLE** with a retry loop, and to stop
> passing the raw `Prisma.TransactionClient` to the callback (it hands over a
> `TenantAudit` instead). Raw SQL is therefore no longer reachable from these
> modules, and it is no longer needed: that runner's own docblock argues
> explicitly that SSI is the right closure for a read-a-set/write-a-row race and
> that a per-caller `FOR UPDATE` is the property that just failed. These modules
> are coded against that interface and **inherit their correctness from its
> isolation level** — if `TENANT_TRANSACTION_ISOLATION` is ever relaxed, FIX 1
> reopens here. `assertStillSigning` is what would catch it.
>
> `EndpointSecretsModule` now imports `OrganizationsModule` for the runner. That
> import should become `AuthzModule` when the runner moves to
> `TenantScopeFactory.transaction(context, fn)` as this file already plans.

**2 (MEDIUM). A developer created an endpoint that went live with a signing
secret nobody ever received.** `endpoints.write` is a developer grant;
`endpoint-secrets.*` is owner/admin. The endpoint went `active`/`enabled` with
an HMAC key that existed only as ciphertext — every delivery signed with a key
the consumer did not hold, and the owner's later rotation changed it AGAIN: two
verification outages instead of none. The endpoint now stays in the paused state
it is already created in when the creator cannot be handed the secret, and the
response carries `secret_pending: true`. `enable` — which already requires a live
secret — is the step that goes live, after an owner has rotated. The permission
split is unchanged; a developer still never sees a secret.

**3 (LOW, execution-confirmed). `?include_deleted=false` parsed as TRUE.**
`@Type(() => Boolean)` is `Boolean('false')`. Measured: `'false'`→true,
`'0'`→true, `''`→false. Replaced with a `BooleanQuery()` decorator exported from
`src/endpoints`; **the eight modules still to be written should import that
rather than re-deriving the idiom.** Pinned by
`dto/list-endpoints.query.dto.spec.ts` over `'true' | '1' | 'false' | '0' | '' |
absent`.

**4 (LOW). The rotation audit row recorded `previous_secrets_expire_at:
"[redacted]"`.** `AuditService` redacts any key matching /secret/i not ending in
`_id`, so the one fact that audit row is opened to answer was the one it lost.
Renamed to `previous_expire_at`. `AuditService` is untouched. The same trap bit
`endpoint.created` metadata during this work: `awaiting_secret_handover` is now
`awaiting_key_handover`. **Any new metadata key containing "secret" is redacted —
name around it.**

**5 (LOW). `rotate` under-reported what is still signing.** Secrets whose
existing expiry precedes the new overlap end are correctly not extended — and are
still live, still emitting `v1=`. Reporting only the extended set told a consumer
rolling off `overlapping_versions` that nothing else was signing.
`overlapping_versions` is now every prior version still signing, newest first,
and `previous_secrets_expire_at` is the max of their effective expiries.
`overlap_seconds: 0` still correctly reports an empty set.

**6. The rotation shim is gone.** `withCreatableSecrets` and
`PatchedScopeFactory` are deleted; the authz `PARENT_KEY` change has landed, so
`scope.endpointSecrets.create` resolves the parent endpoint through its own
scoped repository. Both suites now run against the **unmodified** repository, and
the "sanity" block at the end of the secrets suite keeps that honest.

**7 (MEDIUM). No route carried a throttle.** `@Throttle` added to
`POST /v1/projects/:projectId/endpoints` (60 / 5 min) and
`POST /v1/endpoints/:endpointId/secrets/rotate` (30 / 5 min), with
`@UseGuards(ThrottleGuard)` on both controllers. A rate limit bounds the speed,
not the total, so `MAX_ENDPOINTS_PER_PROJECT = 500` is the ceiling; soft-deleted
endpoints do not count, or a long-lived project eventually becomes uncreatable.

**Paginated reads.** `EndpointsService.list` and `EndpointSecretsService.list`
now use `findPage()` and return `{ data, has_more, next_offset }` — **a breaking
response-shape change on both list routes.** Separately: `secretsFor` makes
CORRECTNESS decisions (next version, survivor count, `hasLiveSecret`) and now
uses `forEachPage()` to exhaustion. It was a single capped page, which is right
for a realistic endpoint and wrong past `MAX_PAGE_SIZE` — a survivor on page two
is invisible to the check that exists to find it.

### What a reviewer should check next

- `LockingTransactionRunner` is gone; `SerializableTransactionRunner` in
  `endpoint-secrets/testing/harness.ts` models SERIALIZABLE as a serial schedule.
  It does **not** model rollback and never aborts an attempt, so the real
  runner's retry loop is unexercised by these suites.
- The concurrency suite asserts the PROPERTY (never zero live secrets on a
  non-deleted endpoint) under `Promise.allSettled`, not the mechanism. It was
  confirmed to fail with the pre-fix shape restored, reproducing
  `0 live secrets, status=active enabled=true`.
- No integration test runs against real PostgreSQL (no Docker here), so SSI
  aborting one of two colliding revokes is argued, not executed.

---

## webhook-subscriptions (2026-09-07)

New module at `src/webhook-subscriptions/`, mounted at
`/v1/projects/:projectId/subscriptions`. List / get / create / update /
enable / disable / delete, all `@Authorized('subscriptions.read' | '.write')`
+ `@Tenant()`, all data access through `TenantScopeFactory`. `PrismaService` is
not imported anywhere in the module.

### FOR WHOEVER WIRES app.module.ts — the two lines

```ts
import { WebhookSubscriptionsModule } from './webhook-subscriptions/webhook-subscriptions.module';
// ...in @Module({ imports: [...] }), after EndpointSecretsModule:
    WebhookSubscriptionsModule,
```

It imports `OrganizationsModule` for `TenantTransactionRunner` only — the same
temporary address `EndpointSecretsModule` uses, and the same import that should
become `AuthzModule` when the runner moves onto `TenantScopeFactory`.

### Two contract corrections landed here first

- **List envelope is `{ data, has_more, next_offset }`** and nothing else. No
  `count`, no `total`, no `limit`/`offset` echo. `next_offset` is `null` — never
  absent, never `0` — on the last page.
- **`limit_exceeded` was added to `ERROR_CODES`** in `src/common/errors.ts`
  (409, like `conflict`). Every resource ceiling must now use it and must attach
  `details: { limit, current, resource }`. `conflict` in this module means only
  "that endpoint is deleted". **The four existing ceilings (projects, api-keys,
  endpoints, and whatever rate-limits/retry-policies add) still return `conflict`
  and need realigning.**

### Decisions worth arguing with, if you disagree

**DELETE IS A HARD DELETE.** `webhook_subscriptions` has no status column and
nothing has an FK to it — `deliveries.subscription_id` is a bare nullable TEXT
column with no `@relation` in `schema.prisma`. A soft delete could therefore
only mean `enabled = false`, which is already what PAUSE means, so a "deleted"
subscription would sit in the list forever, count against the ceiling, and be
one click from resurrection. The ledger loses nothing that matters: a delivery
row keeps its own `endpoint_id` (RESTRICT, kept forever) and `event_id`, so
"did finance ever receive this?" is unaffected — only "which routing rule
matched" goes, and `remove()` writes the whole rule (endpoint, event types,
payload filter, enabled) into `audit_logs` on the way out.

> **For the operator-UI and data-plane agents: `deliveries.subscription_id` can
> dangle.** Render it as "the subscription that matched has since been deleted".
> Never a broken link, never a lookup that throws.

**EMPTY `event_types` IS REFUSED, at write time, with a 400.** `Match()` fails
closed on `[]` (matches nothing) while the column default is `["*"]` (matches
everything), so a caller saving `[]` either meant "everything" and would
silently receive nothing, or meant "nothing", which `enabled: false` already
says legibly and reversibly. Both readings are defensible, which is exactly why
guessing is not — coercing to `["*"]` would be Convoy's bug re-created by our
own hand. The 400 names both alternatives. `["*"]` alongside any other pattern
is refused for the same reason: the row would read as filtered and receive
everything.

### For the data-plane agent — event-type patterns

`src/webhook-subscriptions/event-type-pattern.ts` contains
`matchesEventType()`, a line-for-line mirror of `MatchesEventType` in
`internal/router/match.go`, and `event-type-pattern.spec.ts` pins the whole
table (`payment.*` matches `payment.settled` and `payment.card.captured`, and
does NOT match `payments.settled` or the bare `payment`). **If you change
`match.go`, change the mirror in the same commit** or the validator starts lying
about the thing it exists to guarantee.

The control plane is deliberately STRICTER than the matcher, never looser. Two
patterns are legal Go and refused at write time: `.*` (empty prefix — matches
only types starting with a literal dot) and anything with a `*` outside the two
sanctioned shapes (`pay*` falls through to exact equality in Go, so it would be
stored as a subscription that never fires, silently). Everything the API accepts
is matched by the router exactly as written.

### For the data-plane agent — `payload_filter` SEMANTICS, validated but NOT YET EXECUTED

Nothing evaluates `payload_filter` today; a subscription carrying one currently
behaves as if it were null. The shape is nailed down NOW so you are not writing
the evaluator against rows someone already guessed at. `payload-filter.ts` is
the full spec; the contract in short:

A filter is a JSON object; keys are LOGICAL operators or FIELD PATHS, implicitly
ANDed. Field paths are dot-separated `[A-Za-z0-9_-]+` segments resolved against
the parsed payload. A condition is either a JSON scalar (shorthand for `$eq`) or
an object of comparison operators, also ANDed.

- comparison: `$eq` `$ne` (scalar), `$gt` `$gte` `$lt` `$lte` (number),
  `$in` `$nin` (non-empty array of scalars), `$exists` (boolean)
- logical: `$and` `$or` (non-empty arrays of filters), `$not` (one filter)

Implement exactly these seven rules:

1. **Strict JSON typing, no coercion.** `"1000" != 1000`; `1 != true`.
2. **Absent is not null.** Only `{"$exists": false}` matches an absent path.
   `{"$eq": null}` matches a path present and holding JSON `null`. Every other
   operator is FALSE against an absent path — **including `$ne` and `$nin`**, or
   a filter tightens into a leak the moment a producer drops a field.
3. **Type mismatch is false, not an error.** `{"$gte": 10}` against a string is
   false; the delivery must not fail over it.
4. **Ordering is numeric only.** No implicit string or date ordering.
5. **Arrays and objects are not comparable.** A path holding one satisfies only
   `$exists`. There is no `$contains` and no implicit "matches any element" —
   both are real features and both need their own operator, added deliberately.
6. **`{}` is not a filter.** It is refused at write time (it would match every
   payload). Absence of a filter is SQL NULL, written as `Prisma.DbNull`.
7. **FAIL CLOSED.** A stored filter you cannot parse or evaluate means NO
   delivery for that subscription, plus a loud operator-visible error. Never
   treat it as "no filter". Everything above is designed to make that state
   unreachable; rule 7 is what happens when it is reached anyway.

Bounds enforced at write time, so you may assume them: 4096 bytes serialised,
depth 5, 64 conditions, 8 path segments, 200-char paths, 50 `$in` values,
20 `$and`/`$or` branches, 500-char string operands.

### Config

`MAX_SUBSCRIPTIONS_PER_PROJECT` (default 500, clamped to [1, 10000], warns and
falls back rather than refusing to boot). Subscriptions are the fan-out
multiplier — one event becomes one `deliveries` row per matching subscription —
so the ceiling is enforced INSIDE the create's SERIALIZABLE transaction, not
advisorily beside it like the endpoint and API-key ceilings.
`webhook-subscriptions.concurrency.spec.ts` asserts that property under
`Promise.allSettled` **and keeps the pre-fix shape (count outside the
transaction) in a second block to prove the property test actually
discriminates** — without it the suite would pass against a service that never
opened a transaction at all.

### Verified

`lint` (this module, clean), `build`, and the full `test` run: **994 tests, 44
suites, all passing**, of which 155 in 5 new suites here. The repo-wide `lint`
currently fails on `src/retry-policies/retry-policy-rules.spec.ts:221`
(`no-loss-of-precision`) — another agent's file, untouched by this work.

Still no live database, so as everywhere else in this file, nothing here has run
against real PostgreSQL. Two things a real run should confirm: that Prisma
accepts `payloadFilter: Prisma.DbNull` on `WebhookSubscriptionCreateManyInput`
through `ScopedRepository.create` (the fake models the write and the read-back,
not Prisma's own input coercion), and that the SERIALIZABLE ceiling really
aborts one of two concurrent creates with `40001` rather than serialising them
by luck.

---

## Retry policies and rate limits (2026-09-07) — `src/retry-policies`, `src/rate-limits`

Two modules. Nothing outside those two directories was edited: no schema, no
`app.module.ts`, no `src/authz`, no `src/common`, no migration files.

### Module registration — for whoever owns `app.module.ts`

```ts
import { RateLimitsModule } from './rate-limits/rate-limits.module';
import { RetryPoliciesModule } from './retry-policies/retry-policies.module';
```

and, in `imports`, after `EndpointSecretsModule`:

```ts
    RetryPoliciesModule,
    RateLimitsModule,
```

Both import `OrganizationsModule` for one export — `TenantTransactionRunner` —
and nothing else. Neither imports `PrismaModule` and neither mentions
`PrismaService`; no `.eslintrc.json` allowlist entry was needed or added.

### Routes

```
GET    /v1/projects/:projectId/retry-policies                  policies.read
POST   /v1/projects/:projectId/retry-policies                  policies.write
GET    /v1/projects/:projectId/retry-policies/:policyId        policies.read
PATCH  /v1/projects/:projectId/retry-policies/:policyId        policies.write
POST   /v1/projects/:projectId/retry-policies/:policyId/default  policies.write
DELETE /v1/projects/:projectId/retry-policies/:policyId        policies.write

GET    /v1/projects/:projectId/rate-limits                     policies.read
POST   /v1/projects/:projectId/rate-limits                     policies.write
GET    /v1/projects/:projectId/rate-limits/:policyId           policies.read
PATCH  /v1/projects/:projectId/rate-limits/:policyId           policies.write
DELETE /v1/projects/:projectId/rate-limits/:policyId           policies.write
```

List envelope on both: **`{ data, has_more, next_offset }`** — no `count`, no
`total`, `next_offset` null (not absent, not 0) on the last page. Ceilings return
the dedicated `limit_exceeded` code with `details: { limit, current, resource }`;
a duplicate on the rate-limit unique index returns `conflict`. Those are
different things and the dashboard must not have to match on a message to tell
them apart.

### The rules chosen — default policy and deletion

**Exactly one default per project, whenever the project has any policy at all.**

- The FIRST policy created in a project is promoted whether or not it asked. A
  project with policies and no default is a state nothing downstream resolves.
- `is_default` has exactly ONE writer path (`setDefault`, plus `create`'s
  promotion), and it is deliberately absent from `UpdateRetryPolicyDto`. A PATCH
  that just sets the field is precisely the shape that skips the clear;
  `forbidNonWhitelisted` turns an attempt into a 400 rather than a silent no-op.
- Every write that touches the column runs inside `TenantTransactionRunner`
  (SERIALIZABLE + bounded retry). The clear is `updateMany(isDefault: true AND
  NOT id, → false)` — over the SET, not over the row that was read — so a stale
  snapshot cannot leave a second default behind. `setDefault` is idempotent and
  repairs a project that somehow acquired two.

**Deletion of a retry policy:**

1. **Refused (409 `conflict`) while any LIVE endpoint references it.**
   `endpoints.retry_policy_id` is an optional relation with no explicit
   referential action — i.e. `ON DELETE SET NULL` — so deleting the policy would
   silently move those endpoints onto `retry.DefaultPolicy()` (8 attempts, 5s
   base, 24h budget) with nothing anywhere saying so. The error carries
   `details.endpoints`.
2. **Soft-deleted endpoints do not block it**, but they are unlinked
   EXPLICITLY inside the same transaction and the count is recorded as
   `unlinked_deleted_endpoints` in the audit row. They cannot be PATCHed
   (`EndpointsService` refuses to modify a deleted endpoint), so counting them
   would make the policy permanently undeletable; letting the FK null them would
   be the same silent rewrite by a quieter route.
3. **The project default cannot be deleted without a successor** while other
   policies remain: `?replacement_id=` is required and is promoted in the SAME
   transaction, so no reader ever sees a project with policies and no default.
   `replacement_id` is resolved through the same scoped repository, so another
   tenant's policy is a 404. Passing it when it is not needed is a 400.
4. **Deleting the LAST policy is allowed.** The project falls back to
   `retry.DefaultPolicy()`, which is a defined state.

Retry policies are HARD deleted (unlike endpoints): nothing in the delivery
ledger references one, so there is no history to preserve.

### MIGRATION REQUEST — CHECK constraints and one partial unique index

I cannot edit `prisma/schema.prisma` or add a migration. Everything below is
enforced by the control plane today; the database currently accepts all of it.
The control plane is not the only writer forever (the CLI, a backfill, the next
service), and the data plane CLAMPS rather than refuses, so a bad row does not
fail loudly — it silently stops behaving the way it reads.

```sql
-- retry_policies: every one of these is a value retry.Delay/Exhausted cannot
-- consume sanely. max_delay_ms = 0 is the one with a scar: the clamp in
-- retry.Delay used to be gated on MaxDelay > 0, so the exponential term
-- overflowed int64 nanoseconds and time.Duration(d) became math.MinInt64 -
-- next_attempt_at permanently in the past, and a dead endpoint polled every
-- 250ms. Go clamps defensively now; this is the refusal.
ALTER TABLE retry_policies
  ADD CONSTRAINT retry_policies_strategy_check
    CHECK (strategy IN ('exponential', 'linear', 'constant')),
  ADD CONSTRAINT retry_policies_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 50),
  ADD CONSTRAINT retry_policies_initial_delay_check
    CHECK (initial_delay_ms BETWEEN 1 AND 86400000),
  ADD CONSTRAINT retry_policies_max_delay_check
    CHECK (max_delay_ms BETWEEN 1 AND 86400000),
  ADD CONSTRAINT retry_policies_delay_order_check
    CHECK (initial_delay_ms <= max_delay_ms),
  ADD CONSTRAINT retry_policies_multiplier_check
    CHECK (multiplier >= 1 AND multiplier <= 100),
  -- retry.Delay substitutes 2 for any multiplier <= 1 on the exponential
  -- branch, so a stored 1 there is a row that does not describe what happens.
  ADD CONSTRAINT retry_policies_exponential_multiplier_check
    CHECK (strategy <> 'exponential' OR multiplier > 1),
  ADD CONSTRAINT retry_policies_jitter_check
    CHECK (jitter_ratio >= 0 AND jitter_ratio <= 1),
  -- 7 days, not 30: the column is int4 and 30 days is 2_592_000_000, past
  -- 2_147_483_647.
  ADD CONSTRAINT retry_policies_max_retry_duration_check
    CHECK (max_retry_duration_ms BETWEEN 1000 AND 604800000);

-- "At most one default per project", which the control plane holds in a
-- SERIALIZABLE transaction and the schema holds not at all. A partial unique
-- index is not expressible in schema.prisma - same situation as the NULLS NOT
-- DISTINCT indexes in 20260906010000, and it must be preserved verbatim if the
-- migration is ever regenerated.
CREATE UNIQUE INDEX retry_policies_one_default_per_project
  ON retry_policies (project_id)
  WHERE is_default;

-- rate_limit_policies: limit = 0 disables delivery/ingestion entirely for
-- whatever the policy covers, window_seconds = 0 is a division by zero in the
-- refill rate, and burst < limit means the configured limit can never be
-- reached because the bucket cannot hold one window's worth of tokens.
ALTER TABLE rate_limit_policies
  ADD CONSTRAINT rate_limit_policies_limit_check
    CHECK ("limit" BETWEEN 1 AND 10000000),
  ADD CONSTRAINT rate_limit_policies_window_check
    CHECK (window_seconds BETWEEN 1 AND 86400),
  ADD CONSTRAINT rate_limit_policies_burst_check
    CHECK (burst IS NULL OR (burst >= "limit" AND burst <= 10000000));
```

Note the partial index would make `setDefault` depend on statement ORDER inside
its transaction (clear before set, which is what it already does). Adding it
does not remove the need for the transaction — a unique index cannot express
"at least one row", so the zero-default direction is still the service's job.

### FOR THE DATA-PLANE TEAM — nothing reads `rate_limit_policies` yet

`internal/ingest/handler.go` wires `ingest.AllowAll{}`, and the delivery workers
have no policy lookup at all. Every row written through these routes is
currently INERT. That is worse than an empty table: an operator reads the list,
believes a ceiling is in force, and stops looking for why a partner is being
flooded. Please either implement the resolution below or say so in the UI.

**Resolution order.** Two separate rules, and conflating them is the trap:

- **Within one scope, the most specific row wins.** A row whose `resource_id`
  matches the resource beats the `resource_id IS NULL` row for that scope
  ("every resource in this scope"). Never both.
- **Across scopes, EVERY applicable bucket is charged, and any one may refuse.**
  They are nested budgets, not fallbacks — an endpoint limit of 100/s inside a
  project limit of 500/s means both, and the most restrictive bites first.

Outbound delivery, per attempt:

```
1. endpoints.rate_limit / endpoints.rate_limit_window_seconds   (the columns on
   the endpoint row itself - most specific, and already populated today)
2. rate_limit_policies WHERE scope='endpoint' AND resource_id=<endpoint id>
   else                 scope='endpoint' AND resource_id IS NULL
3. rate_limit_policies WHERE scope='project' AND resource_id IN (<project id>, NULL)
4. rate_limit_policies WHERE scope='organization' AND resource_id IN (<org id>, NULL)
```

Ingest, per accepted event — this maps onto `ingest.Scope`
(`OrganizationID`/`ProjectID`/`APIKeyID`) as it already stands:

```
1. rate_limit_policies WHERE scope='ingest' AND resource_id=<api key id>
   else                 scope='ingest' AND resource_id IS NULL
2. rate_limit_policies WHERE scope='project'      AND resource_id IN (<project id>, NULL)
3. rate_limit_policies WHERE scope='organization' AND resource_id IN (<org id>, NULL)
```

`burst` is the bucket CAPACITY and `limit / window_seconds` the refill rate;
`burst IS NULL` means "capacity equals limit". The control plane guarantees
`limit >= 1`, `window_seconds >= 1` and `burst >= limit`, so no consumer needs a
divide-by-zero guard — but please keep failing OPEN on a limiter fault, as
`limiter.go` already documents.

`scope='ingest'` with a non-null `resource_id` names an **API key**, chosen
because `ingest.Scope` already carries `APIKeyID`: it is the per-credential
ceiling that stops one integration's runaway retry loop eating the project's
whole ingest budget.

### Two notes for the authz owner

- **`rate_limit_policies.resource_id` is a POLYMORPHIC foreign key** — its target
  table depends on `scope` — so it cannot go in `ScopedRepository`'s
  `foreignKeys` map, which is column → one repository. It is resolved explicitly
  in `src/rate-limits/rate-limit-resource.ts`, through the scoped repository for
  whatever the scope names (`endpoints`, `apiKeys`, `projects`, `organization`),
  on every create and on every update that touches `scope` or `resource_id`. If
  the map ever grows a "resolver function" form, this is its first caller.
- **`ScopedRepository.notFound()` still says `${resourceName} not found.`**
  These modules therefore never call `requireById` on a caller-supplied id; they
  use `findById` and raise `CROSS_TENANT_MESSAGE` themselves, exactly as
  endpoints and endpoint-secrets do. Third module in a row working around the
  same thing — changing `notFound()` to the constant would let the next one just
  use `requireById`.

### Verified

`pnpm --filter @webhook/control-api lint`, `build` and `test` all pass with
everything in the tree — **1091 tests, 48 suites**, of which 170 in 7 new suites
here:

- `retry-policies/retry-policy-rules.spec.ts` — bounds, cross-field coherence,
  and a property run over ~48 accepted policies against a PORT of `retry.Delay`'s
  own arithmetic (not a restatement of the bounds, which would pass by
  construction): no accepted policy yields a negative, NaN or unbounded delay at
  any attempt inside its budget. Includes an executable demonstration that the
  refused `max_delay_ms = 0` policy really does exceed int64 nanoseconds at
  attempt 40.
- `retry-policies/retry-policies.service.spec.ts` — isolation, merged-settings
  validation, default promotion, all four deletion rules, ceiling, paging.
- `retry-policies/retry-policies.concurrency.spec.ts` — the default invariant
  under `Promise.allSettled`, **including the pre-fix shape run against the same
  property check**: `setDefaultUnsafe` (read the default, clear that row, set the
  new one, no transaction) reproducibly leaves TWO defaults and
  `assertExactlyOneDefault` throws on it. If that test ever passes, the property
  check has stopped detecting the bug and everything above it is vacuous.
- `rate-limits/rate-limit-rules.spec.ts`, `rate-limits.service.spec.ts` —
  cross-tenant `resource_id` at all four scopes, validation, uniqueness
  including the `resource_id IS NULL` row, and P2002 handling **by index**: a
  violation is matched on `meta.target` in all three shapes Prisma reports it in
  (column list, camelCase, constraint name) and mapped to a real 409, while a
  foreign index, a P2002 with no target, a P2003 and an ordinary Error are all
  rethrown UNCHANGED rather than laundered into a friendly conflict.
- `rate-limits/rate-limits.concurrency.spec.ts` — the same pre-fix/post-fix pair
  for the check-then-insert.
- `retry-policies/policies.http.spec.ts` — both controllers on a real port with
  real guards, the real `ValidationPipe` and the real exception filter:
  401/403/404 wiring, the `policies.read`/`policies.write` split across viewer,
  developer and billing, the list envelope asserted to be exactly three keys,
  `@Throttle` present on every write route and absent on the reads, and a real
  429 with `Retry-After`.

### What a reviewer should check next

- No integration test runs against real PostgreSQL (no Docker here), so the
  claims that SSI aborts one of two colliding transactions, and that the NULLS
  NOT DISTINCT index catches the create that the in-transaction check races
  past, are ARGUED, not executed. `SerializableTransactionRunner` models
  SERIALIZABLE as a serial schedule and never aborts an attempt, so the runner's
  retry loop is unexercised here too.
- `FakeTenantPrisma` has no unique indexes, so the rate-limit uniqueness suites
  exercise the in-transaction check; the P2002 path is exercised by injecting a
  real `PrismaClientKnownRequestError` into the delegate.
- The per-project ceilings (50 retry policies, 300 rate limits) are compile-time
  constants, not `ConfigService`-driven like `MAX_PROJECTS_PER_ORGANIZATION`.
  Worth aligning if an operator ever needs to raise one without a deploy.

---

## Migration `20260907000000_handoff_schema_requests` — the consolidated schema requests

One migration, hand-written, consolidating every schema/index/constraint request
found in `apps/control-api/HANDOFF.md`, `services/data-plane/HANDOFF.md` and
`deployments/HANDOFF.md`. Files touched: `prisma/schema.prisma`,
`prisma/migrations/20260907000000_handoff_schema_requests/migration.sql`,
`deployments/ci/expected-schema-drift.txt`. Nothing under `src/`.

### To apply

```bash
pnpm --filter @webhook/control-api prisma:generate
DATABASE_URL=... DIRECT_DATABASE_URL=... \
  pnpm --filter @webhook/control-api prisma:deploy
```

`prisma:deploy` applies `20260906000000_init`, then `20260906010000_review_fixes`,
then this one. **Never `prisma migrate dev`** — see
`deployments/ci/expected-schema-drift.txt`.

### Satisfied

| Request | From | Where it lives |
|---|---|---|
| `api_keys.created_by_user_id` / `created_by_membership_id`, both nullable, both FK `ON DELETE SET NULL`, both indexed | control-api FIX 2 | schema.prisma (`ApiKey`, `User`, `OrganizationMember`) + migration §1, with a backfill from `audit_logs` |
| Nine CHECK constraints on `retry_policies` (strategy, max_attempts, initial_delay_ms, max_delay_ms, delay ordering, multiplier, exponential multiplier > 1, jitter_ratio, max_retry_duration_ms) | control-api MIGRATION REQUEST | migration §2 — hand-written; Prisma cannot express CHECK |
| Partial unique index `retry_policies_one_default_per_project` (`WHERE is_default`) | control-api MIGRATION REQUEST | migration §2 |
| Three CHECK constraints on `rate_limit_policies` (limit, window_seconds, burst) | control-api MIGRATION REQUEST | migration §3 |
| `deliveries_ready_idx`, predicate **including `processing`** | data-plane item 6 | migration §4, exactly the requested column list, plus `NULLS FIRST` |
| `event_outbox_ready_idx` (`available_at, created_at` WHERE status IN pending/processing) | data-plane §4 item 1 | migration §5 |
| `events.ordering_key` | data-plane item 3 | **already shipped** in `20260906010000_review_fixes`; ingest can move off `headers->>'ordering_key'` now |
| `idempotency_keys` / `api_keys.key_hash` indexes | data-plane items 1, 2 | recorded as "no change needed"; nothing was optimised away |

**Added beyond the requests: `deliveries_ready_fifo_idx`.** The requested
`deliveries_ready_idx` leads with `(organization_id, project_id)`, which serves
`CLAIM_STRATEGY=tenant_fair`'s LATERAL and the tenant-snapshot CTE. It cannot
serve `CLAIM_STRATEGY=fifo` — **the strategy that ships as the default** — whose
claim orders globally by `(next_attempt_at, created_at)` with no tenant
predicate. Two different leading columns, two indexes; both are partial over the
same ready set, so both are bounded by the backlog rather than the table.

Both carry `NULLS FIRST` on `next_attempt_at`, which the requests did not ask
for. The claim orders `next_attempt_at NULLS FIRST` and `next_attempt_at` is
still nullable; a default (`ASC NULLS LAST`) index cannot satisfy that ordering
and the planner would sort the whole ready set. It becomes a no-op the day the
column goes NOT NULL.

### Deliberately NOT done

1. **`deliveries.next_attempt_at` NOT NULL** (ADR-0007, data-plane item 7).
   **It would break the data plane on the first terminal delivery.**
   `internal/worker/store.go` `advanceSQL` writes
   `next_attempt_at = CASE WHEN $5::bool THEN now() + $6::interval ELSE NULL END`
   on every transition, so every succeed / exhaust / cancel sets it to NULL, and
   `internal/worker/store_integration_test.go` asserts terminal rows have a NULL
   `next_attempt_at` ("*is terminal but next_attempt_at = %v, so the claim query
   would pick it up again*"). The router does always set it on INSERT — that half
   of the claim is true — but the terminal writer is the blocker. **Order of
   operations: change `advanceSQL` to stop nulling it (a terminal row is excluded
   by `status`, not by a NULL timestamp), ship that, then a follow-up migration
   does `UPDATE deliveries SET next_attempt_at = created_at WHERE next_attempt_at
   IS NULL; ALTER TABLE deliveries ALTER COLUMN next_attempt_at SET NOT NULL;`.**
   Only then can `readyPredicate` drop its `IS NULL` half and both indexes drop
   `NULLS FIRST`.
2. **`idempotency_keys.expires_at` → `@db.Timestamptz`** (data-plane, "recorded,
   not fixed"). The data plane itself says it is not worth a schema change on its
   own, the drift is zero in the distroless image, and `ALTER COLUMN ... TYPE
   timestamptz` rewrites the table. Fold it into the next change that touches
   that table, or fix it in Go with `time.Now().UTC()` — either alone is enough.
3. **Retention sweeps** for `idempotency_keys` and `event_outbox`, and the
   orphaned-payload reconciliation. Jobs, not schema; the indexes they need
   (`idempotency_keys.expires_at`, `event_outbox.processed_at` via
   `event_outbox_ready_idx`'s siblings) already exist.
4. **A `projects_count` / `api_keys_count` counter column.** Hypothetical in the
   source HANDOFF ("if a hard limit is ever needed"), not requested.
5. ~~**The `api_keys` enforcement itself**~~ **DONE (2026-09-08)** — the columns
   are written from the resolved context and read back as
   `ApiKeyDto.effective_scopes` / `created_by_*`. Re-derivation at use time was
   chosen over auto-revoke in `MembersService.remove`; see "API key effective
   scopes" at the end of this file for the reasoning and the contract the Go
   ingest path adopts when it starts consulting scopes.

### Safety on a non-empty database

No database exists yet, but the file is written as if one did.

- New columns are **nullable with no default** → no table rewrite.
- The `audit_logs` backfill runs **before** the foreign keys exist, and is
  followed by two `NOT EXISTS` sweeps that null out any recovered id whose
  `users` / `organization_members` row is gone. The audit trail is not a foreign
  key and outlives what it names; a dangling id would abort `ADD CONSTRAINT` and
  take the whole deploy with it.
- Every CHECK is added `NOT VALID` and `VALIDATE`d in a separate statement, so
  the ACCESS EXCLUSIVE lock covers only the catalog write and the row scan runs
  under SHARE UPDATE EXCLUSIVE.
- **Every CHECK and unique index is preceded by an idempotent repair pass** that
  clamps out-of-range rows first and `RAISE NOTICE`s what it changed. Chosen over
  "fail on a bad row" because one legacy row would otherwise abort the deploy,
  and over silent `NOT VALID`-forever because that enforces nothing on the rows
  that already exist. Each repair is a no-op on an empty table. Notable choices:
  an out-of-range or NaN `multiplier` becomes `2` (what `retry.Delay` already
  substitutes), an unusable `burst` becomes NULL (which already means "capacity
  equals limit"), and the **oldest** default retry policy in each project is the
  one kept.
- Indexes are `CREATE INDEX IF NOT EXISTS`, **not `CONCURRENTLY`**: Prisma wraps
  a migration file in a transaction and `CONCURRENTLY` cannot run inside one. On
  a large populated `deliveries` table, build them by hand with `CONCURRENTLY`
  first (the definitions in the migration are exact) and this migration then
  skips them.

### PostgreSQL floor

Unchanged at **15+**. Nothing added here needs it — partial indexes and CHECK
constraints are ancient — but the `server_version_num` guard from
`20260906010000_review_fixes` is repeated at the top of this file so it is
self-describing if it is ever applied alone.

### CI drift fixture

`deployments/ci/expected-schema-drift.txt` gains four index names:
`retry_policies_one_default_per_project`, `deliveries_ready_idx`,
`deliveries_ready_fifo_idx`, `event_outbox_ready_idx`. All four are partial;
Prisma has no partial-index syntax, so all four are drift by construction.

**The twelve CHECK constraints are deliberately NOT in the fixture.** Prisma's
datamodel has no concept of a CHECK constraint so `migrate diff` does not report
them — and the fixture's second consumer (`.github/workflows/ci.yml`, "Hand-written
indexes survive a real migrate deploy") looks every line up in `pg_indexes`, where
a constraint name will never appear. If a future Prisma release starts emitting
`DROP CONSTRAINT` for them, that file needs a **second** list and the job a
second loop. Do not paste constraint names into the existing one.

### Verified, and not

- `pnpm --filter @webhook/control-api prisma:generate` — **passes** (client v5.22.0).
- `npx prisma validate` — **passes**.
- `pnpm --filter @webhook/control-api build` — **passes**.
- `src/infrastructure/prisma/schema.spec.ts` — 21 tests, **pass** (it asserts the
  `review_fixes` SQL text; nothing there was touched).
- **The SQL has NOT been executed.** No database is reachable: Docker is down and
  the local PostgreSQL is 14 with a broken icu4c link, below the 15 floor. The
  migration was read statement by statement against the real column and enum
  definitions in `20260906000000_init` and `schema.prisma`, and the claim SQL it
  is indexing was read out of `internal/queue/postgres.go` and
  `internal/router/store.go` rather than from the ADR. **Someone must run
  `prisma migrate deploy` against a real PostgreSQL 15+ before this is trusted**,
  and confirm the two things a dry read cannot: that the four partial indexes
  appear in `pg_indexes` (the CI job does exactly this), and that the claim
  queries actually choose them — `EXPLAIN` the FIFO claim and look for
  `deliveries_ready_fifo_idx` with no Sort node above it.

## Audit log + the list-envelope standardisation (2026-09-07) — `src/audit`, six existing modules

### REGISTER THIS MODULE — one line, for whoever owns `app.module.ts`

`src/audit` is written, tested and NOT registered; nobody may edit
`app.module.ts` right now. Add the import and the entry:

```ts
import { AuditModule } from './audit/audit.module';
// ...
    RateLimitsModule,
    AuditModule,          // <- add this
```

It imports nothing (`TenantScopeFactory` comes from the global `AuthzModule`),
so ordering does not matter. Until it is registered, `/v1/organizations/:orgId/
audit-logs` is not served, though its suites run.

### FOR THE FRONTEND — BREAKING WIRE CHANGE on six list routes

The backend was shipping **three different list envelopes** for the same idea.
All six are now the canonical one, which the three newest modules already used:

```
{ data: T[], has_more: boolean, next_offset: number | null }
```

| route | was | now |
| --- | --- | --- |
| `GET /organizations` | `{ data, total, limit, offset }` | canonical |
| `GET /organizations/:orgId/members` | `{ data, total, limit, offset }` | canonical |
| `GET /organizations/:orgId/projects` | `{ data, count, has_more, next_offset }` | canonical |
| `GET /projects/:projectId/api-keys` | `{ data, count, has_more, next_offset }` | canonical |
| `GET /projects/:projectId/endpoints` | canonical | unchanged |
| `GET /endpoints/:endpointId/secrets` | canonical | unchanged |

**Removed: `total`, `count`, `limit`, `offset`.** Regenerate the client; the
`@nestjs/swagger` decorators were updated with the code, so the OpenAPI document
carries the change.

- **`total` is not coming back.** It cost a second `COUNT` on every request and
  is taken at a different instant from the rows, so `offset + data.length <
  total` claims there is more when a row was deleted between the two reads and
  the reverse when one was inserted. `has_more` comes off the probe row
  `ScopedRepository.findPage` takes and discards, so it is a fact about *this*
  page. That is also the whole reason `findMany` now throws rather than
  truncating silently.
- **`count` was `data.length` restated**, and it invited the `count === limit`
  last-page test `has_more` exists to replace.
- **`next_offset` is `null` — never absent, never `0` — on the last page**, so
  the client branches on one thing. `organizations` and `members` had no
  `has_more` at all, which was the worst of the three.

### FOR THE FRONTEND — resource ceilings now answer `limit_exceeded`

A ceiling used to be `conflict`, indistinguishable from a duplicate slug or a
unique-constraint violation, and only two of the four attached details. All four
now raise `limit_exceeded` (still HTTP 409) with
`details: { limit, current, resource }`:

| ceiling | `details.resource` |
| --- | --- |
| organizations per user (`POST /organizations`) | `organizations` |
| projects per organization | `projects` |
| API keys per project | `api_keys` |
| endpoints per project | `endpoints` |

**Genuine uniqueness conflicts stay `conflict`** and carry `{ field, value }`
instead — a taken organization or project slug, a deleted endpoint, a lost
rotation race. Match on `error.code`; never on the message.
`projects.http.spec.ts` has the two side by side on the same route, same status,
told apart only by the code.

### The audit module

`GET /v1/organizations/:orgId/audit-logs` and
`GET /v1/organizations/:orgId/audit-logs/:auditLogId`. **Read-only, and that is
enforced rather than asserted.**

- **Permission is `audit.read` (owner/admin).** Deliberately not `members.read`,
  which viewer and billing also hold: these rows carry other members' actions,
  IP addresses and user agents.
- **Filters:** `user_id`, `action`, `resource_type`, `resource_id`,
  `created_after`, `created_before`, plus `limit`/`offset`. Index support is
  documented per filter on `ListAuditLogsQueryDto`: the date range and `action`
  are covered by the two indexes on the table; **`user_id`, `resource_type` and
  `resource_id` are SCANS** within the organization and date window. Both routes
  are `@Throttle`d for that reason. An inverted date range is a 400, not an
  empty page — "nothing happened" is the one answer an audit log must never give
  by accident.
- **No metadata filter, on purpose.** `AuditService` redacts by key name at write
  time; a predicate over stored metadata would let a caller test candidate values
  against rows whose value reads `[redacted]` and recover by search what the
  redaction removed. Nothing on the read path re-derives or re-fetches a redacted
  value either.
- **Nothing here can create, alter or remove a row.** Two GET handlers and no
  other verb; `audit.no-mutations.spec.ts` asserts the decorator metadata, the
  service's prototype surface and the absence of any mutating repository call in
  the source, and the HTTP suite proves POST/PUT/PATCH/DELETE are not routed even
  for an owner. **A correction is a new row.**

### Left for someone else

- **`next_offset` is still `@ApiPropertyOptional` on five modules** —
  `webhook-subscriptions`, `retry-policies`, `rate-limits`, `events`,
  `deliveries`. That generates a client field which may be *absent* as well as
  null: two things to branch on where the contract has one. Fixed on the six
  modules in scope here; the other five belong to other authors. The table in
  `src/audit/list-envelope.contract.spec.ts` (`REQUIRED_NEXT_OFFSET`) lists which
  modules are checked — add each as it is fixed, and do not weaken the assertion.
- **`audit_logs` has no index for `user_id`, `resource_type` or `resource_id`.**
  The route documents them as scans rather than smuggling a `schema.prisma`
  change into this change. If the operator UI leans on "everything that happened
  to this endpoint", `(organization_id, resource_type, resource_id, created_at
  DESC)` is the index to add.
- **The audit list orders by `created_at DESC` only.** Rows written in the same
  millisecond have no defined order between them, so a row can move across an
  offset boundary — the same caveat every offset-paged list in this API carries.
- **No boolean query parameter exists on the audit routes**, so `BooleanQuery()`
  is not used there. Every filter is a string, an id or a timestamp; inventing a
  boolean to exercise the idiom would have been a worse API.

### Verified

`lint`, `build` and `test` all pass over the whole tree — **1239 tests, 54
suites**, of which 99 in 4 new suites here:

- `audit/audit-logs.service.spec.ts` — cross-tenant isolation on the unfiltered
  read, on every filtered read and by id (with the same message an absent id
  gets); each filter; the date range asserted on the **emitted WHERE** rather
  than only on returned rows, because `FakeTenantPrisma` compares range operands
  as strings and a row-count assertion could pass over a predicate PostgreSQL
  reads differently; the envelope at the page boundary and on the last page;
  metadata served verbatim with its redaction intact and copied rather than
  aliased; and no mutating operation issued on any code path.
- `audit/audit.http.spec.ts` — real Nest, real guards, real pipe and filter:
  401/403/404 wiring, owner and admin in, **viewer, developer and billing out**,
  the canonical envelope, and POST/PUT/PATCH/DELETE unrouted for an owner.
- `audit/audit.no-mutations.spec.ts` — the append-only property read off the
  decorator metadata and the source, not off a docblock.
- `audit/list-envelope.contract.spec.ts` — table-driven over **all ten** list
  DTOs, asserting the `@nestjs/swagger` metadata (which is what the dashboard
  client is generated from, not the TypeScript type), plus a sweep of the whole
  source tree so a module landing later cannot introduce a fourth envelope
  unnoticed. It lives in `src/audit` because this change is what standardised the
  envelope; move it if a better home appears, but do not delete it.

## Events and deliveries, including replay (2026-09-07) — `src/events`, `src/deliveries`

The two modules that answer the question the product exists for. ARCHITECTURE.md
34 and CLAUDE.md are blunt about it: *the reason people pay for a webhook
platform is not the retry loop, it is answering "what happened to this event?"
at 2am — if a human needs psql to answer that, the product is not finished.*
Every decision below was measured against that sentence.

### FOR WHOEVER OWNS `app.module.ts` — the two lines

```ts
import { DeliveriesModule } from './deliveries/deliveries.module';
import { EventsModule } from './events/events.module';
```

and in `imports`, after `EndpointsModule` (order only matters for readability):

```ts
    DeliveriesModule,
    EventsModule,
```

`EventsModule` imports `DeliveriesModule`, and `DeliveriesModule` imports
`OrganizationsModule` for `TenantTransactionRunner`. Nothing else is needed;
neither module has config of its own.

### Routes

```
GET    /v1/projects/:projectId/events                       events.read
GET    /v1/projects/:projectId/events/:eventId              events.read
GET    /v1/projects/:projectId/events/:eventId/deliveries   events.read + deliveries.read
POST   /v1/projects/:projectId/events/:eventId/replay       events.replay + deliveries.replay
GET    /v1/projects/:projectId/deliveries                   deliveries.read
GET    /v1/projects/:projectId/deliveries/:deliveryId       deliveries.read
GET    /v1/projects/:projectId/deliveries/:id/attempts      deliveries.read
POST   /v1/projects/:projectId/deliveries/:id/replay        deliveries.replay
```

Every route is `@Authorized(...)` + `@Tenant()`, every read goes through
`TenantScopeFactory`/`ScopedRepository`, every list returns
`{ data, has_more, next_offset }` from `findPage()`, and both replay routes carry
a `@Throttle` (events 10/5min, deliveries 30/5min — the event route is tighter
because one request there can create up to `MAX_REPLAY_FAN_OUT` real HTTP calls
rather than one). `PrismaService` is not imported anywhere in either module.

### Replay — the invariant, and the index that carries half of it

`DeliveryReplayService` is the ONE implementation, shared by both routes. A
replay is an INSERT and only an INSERT: `replay_of_delivery_id` names the row
being replayed, `replayed_by` names the actor, `attempt_count` restarts at 0 with
the ORIGINAL's `max_attempts`, and `status = 'pending'` with
`next_attempt_at = now()` — which is exactly what the fan-out router writes and
what `queue/postgres.go`'s ready predicate claims, so **the insert is the
enqueue**. No UPDATE and no DELETE is issued against `deliveries` or
`delivery_attempts` on any path.

Setting `replay_of_delivery_id` is load-bearing, not decoration:
`deliveries_event_endpoint_original_key` is partial (`WHERE
replay_of_delivery_id IS NULL`) precisely so replays are exempt, so an insert
that forgot it would collide with the ORIGINAL row — and the natural "fix" for
that collision is an upsert, i.e. the history-destroying write section 34
forbids. Both shapes are demonstrated failing in
`deliveries.concurrency.spec.ts`.

Four more decisions worth arguing with:

- **Replay-to-all reads the existing delivery rows, never a fresh subscription
  match.** Subscriptions are mutable; re-matching a three-week-old event against
  today's subscriptions delivers it to endpoints that were never targeted and
  skips ones that were. Selection is `WHERE event_id = ? AND
  replay_of_delivery_id IS NULL`, which also makes replaying twice re-send to the
  same set rather than compounding over the rows the first call created.
- **Replaying to an endpoint the event never reached is REFUSED** (409), not
  silently created: there is no attempt budget to inherit and no subscription
  that matched. That is a new delivery, not a replay. A cross-tenant
  `endpoint_id` in the body gets the shared 404 instead, checked first, so the
  409 can never be used as an oracle over another customer's endpoint ids.
- **A deleted, disabled or paused endpoint is refused with its current status in
  `details`.** The worker would abandon such a delivery with `endpoint_deleted` /
  `endpoint_disabled`, so accepting it would turn a 201 into a second failure.
  All-or-nothing across a fan-out: one dead endpoint refuses the whole request.
- **`subscription_id` is carried over only if that subscription still exists.**
  `webhook_subscriptions` rows are hard-deletable while the ledger is not, and
  `ScopedRepository` proves every declared FK before writing — blindly copying
  the id would fail a months-old replay with a 404 about a resource the operator
  never mentioned. `replay_of_delivery_id` is the provenance that cannot vanish.

`MAX_REPLAY_FAN_OUT = 50` bounds one request, for egress and because each insert
is five statements (four FK proofs) inside a SERIALIZABLE transaction. Over the
cap is `limit_exceeded` with `{ limit, current, resource }`, and `current` is a
real COUNT so an operator can plan the split.

### `payload_raw` vs `payload` is on the wire, not in a comment

`GET /events/:id` returns `payload.body` — the AUTHORITATIVE raw bytes, decoded —
plus `payload.normalised_json`, the jsonb copy, plus a `notice` saying in a
sentence that the second is not what was delivered. Presenting jsonb as "the
payload" would send someone debugging a signature failure into the wrong system.

- UTF-8 when the buffer round-trips, base64 otherwise — checked by re-encoding,
  because `toString('utf8')` silently produces U+FFFD for a binary body, which
  looks like data and hashes to nothing.
- An offloaded payload (`payload_raw IS NULL`, `payload_location` set) returns
  `source: 'object_storage'`, `body: null` and the location, **not** an empty
  body that reads as "this event had no payload". The control plane has no
  object-storage client and no `S3_*` config exists yet; if one is added, this is
  the single place to fetch through.
- Listings never inline a payload. `payload_size` and `payload_inline` are there
  instead.

### Index support, stated per filter

Every filter is either index-supported or documented as a scan, in the DTO
description that ends up in the OpenAPI doc:

| filter | index |
|---|---|
| events: `event_type`, `created_after/before` | `events_project_id_event_type_created_at_idx`, `events_project_id_created_at_idx` |
| events: `status` | **scan** — four values, `processed` for nearly every row |
| events: `idempotency_key` | **scan** — `ILIKE '%x%'` cannot use a b-tree; minimum 3 chars |
| deliveries: `status`, `failing_now`, dates | `deliveries_project_id_status_created_at_idx` |
| deliveries: `endpoint_id` | `deliveries_endpoint_id_created_at_idx` |
| deliveries: `event_id` | `deliveries_event_id_idx` |
| deliveries: `event_type` | **scan** — a join to `events` on a column deliveries does not carry |

`failing_now` is `status IN (retrying, failed, exhausted)`; passing it together
with `status` is a 400 rather than a silently resolved contradiction. Date ranges
are `[after, before)` so adjacent windows tile without a boundary row appearing
twice.

### Credential redaction on two read paths

`deliveries.read` and `events.read` are viewer permissions;
`endpoint-secrets.read` and `api-keys.read` are not. So:

- `delivery_attempts.request_headers` — an endpoint's `custom_headers` are in
  there, which is where a customer puts their consumer's bearer token. Values for
  `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, `api-key`,
  `x-auth-token` become `[redacted]`; the KEY stays, so "did we send it?" is
  still answerable. The signature header is deliberately NOT redacted — it is an
  HMAC over the payload, not the key, and it is what a consumer compares against.
- `events.headers` — the ingest call's own `Authorization` carries the project's
  live API key. Same list, same treatment.

### FOR THE DATA-PLANE AGENT — two things to know

1. **Replays arrive as ordinary `pending` rows** with `next_attempt_at = now()`,
   `attempt_count = 0`, `locked_by/locked_until` NULL, and the ORIGINAL's
   `max_attempts` and `ordering_key`. Nothing special is needed to pick them up.
   `replay_of_delivery_id` is metadata for the operator surface; the worker can
   ignore it.
2. **Nothing in the control plane writes delivery state.** There is no cancel, no
   "retry now" and no status write in either module, deliberately: a
   control-plane UPDATE racing a worker's lease is a corruption this API is not
   going to introduce.

### Verified

`pnpm --filter @webhook/control-api lint`, `build` and `test` all pass with
everything in the tree — **1321 tests, 57 suites**, of which 130 in 5 new suites
here:

- `events/event-payload.spec.ts` — the raw/jsonb distinction at the level where
  it is decided, including a round-trip of every byte value 0–255 through one of
  the two encodings.
- `events/events.service.spec.ts` — filters, the case-insensitive idempotency
  search still fenced by the tenant, page-boundary exactness, the three payload
  situations, and the replay rules: **historical endpoints not a re-match**
  (subscriptions are mutated between the fan-out and the replay, in both
  directions), originals-only so replaying twice does not compound, the fan-out
  cap with a real count, and all-or-nothing when one endpoint is deleted.
- `deliveries/deliveries.service.spec.ts` — isolation across four shapes
  (another org, another project, the deliberately corrupt fixture row, absent)
  on all three id-addressed routes with ONE message, attempt ordering across the
  9→10 boundary, inline truncation plus paged exhaustion, header redaction, and
  replay leaving the original **byte-identical**.
- `deliveries/deliveries.concurrency.spec.ts` — the properties
  (`assertOriginalsIntact`, `assertReplaysAreMarked`, `assertOneOriginalPerPair`)
  under `Promise.allSettled`, **plus both pre-fix shapes run against the same
  checks**: an insert with no `replay_of_delivery_id` is rejected by the modelled
  partial unique index, and the read-modify-write "replay" that reuses the
  original row makes `assertOriginalsIntact` throw. If either stops failing, the
  suites above are vacuous.
- `deliveries/ledger.http.spec.ts` — both controllers on a real port with real
  guards: `assertRoutesAreGuarded`, the viewer/developer/billing split,
  `?failing_now=false` meaning FALSE (`BooleanQuery`, not `@Type(() => Boolean)`),
  the three-key envelope on all four list routes, `@Throttle` present on both
  replays and absent on every read, and a real 429 with `Retry-After`.

### What a reviewer should check next

- `FakeTenantPrisma` compares with `String(a) < String(b)`, which is wrong for
  `DateTime` (April before January) and for `Int` (`'10' < '9'`), and cannot do
  `contains` or the `deliveries -> events` join at all. Rather than weakening the
  production queries to fit it, `deliveries/testing/rich-fake.ts` replaces the
  three delegates this module reads with type-aware ones over the SAME storage,
  and adds the partial unique index. It is a fixture, not a Prisma emulator —
  the `ILIKE`/`gte` semantics it models are argued against the documentation,
  not executed against PostgreSQL, because no database is reachable here.
- No integration test runs against real PostgreSQL, so "SERIALIZABLE aborts one
  of two colliding replays" is argued, not executed;
  `SerializableTransactionRunner` models it as a serial schedule and never
  aborts, so the runner's retry loop is unexercised here too.
- `MAX_REPLAY_FAN_OUT` (50) and `MAX_INLINE_ATTEMPTS` (100) are compile-time
  constants, not `ConfigService`-driven. Worth aligning with
  `MAX_PROJECTS_PER_ORGANIZATION` if an operator ever needs to raise one without
  a deploy.
- ~~`ScopedRepository.notFound()` still says `${resourceName} not found.`~~
  **DONE (2026-09-08).** `notFound()` now returns `CROSS_TENANT_MESSAGE`, so the
  repository and `TenantResolver` speak one 404 vocabulary and a new module gets
  it for free from `requireById`. The per-module `withCrossTenantNotFound`
  helpers remain as the fence for `not_found`s a SERVICE raises;
  `authz/not-found-vocabulary.spec.ts` fails if a second dialect appears.
- The `origin` filter (`original` / `replay`) uses `replay_of_delivery_id IS
  NULL` / `IS NOT NULL`, which has no index. It is a refinement of an already
  narrowed set today; if a "replays only" dashboard becomes a real screen it
  wants a partial index.

---

## API key effective scopes (2026-09-08) — `src/api-keys`, and a contract for the data plane

The columns from migration `20260907000000` are now **written and read**. Before
this, `api_keys.created_by_user_id` / `created_by_membership_id` existed with
their indexes and FKs and nothing populated or consulted them.

### What changed

- `ApiKeysService.create` writes both columns from the **resolved
  `RequestContext`** (`context.user.userId`, `context.membershipId`). There is no
  DTO field that could set them; `ValidationPipe` runs `forbidNonWhitelisted`, so
  a body naming an issuer is a 400. A caller who could name the issuer could mint
  a key attributed to an owner and keep owner authority forever.
- `src/api-keys/effective-scopes.ts` is the derivation, and `ApiKeyDto` now
  carries `effective_scopes`, `created_by_user_id`, `created_by_membership_id`
  and `created_by_role` (the issuer's role **now**, not at mint time). `scopes`
  is unchanged and is explicitly documented as history.

### The enforcement chosen: re-derive at use time (HANDOFF option 1), not auto-revoke

    effective = key.scopes ∩ permissionsForRole(current role of created_by_membership_id)
    created_by_membership_id IS NULL  ⇒  effective = ∅

Why this one rather than auto-revoking a key when its issuer's membership is
removed:

- **A key is bound to a project, not to a person.** Auto-revoke takes a
  production ingest credential offline on an HR event that has nothing to do with
  the integration it serves. The first time it happens it is an outage nobody can
  explain from the key's own history.
- **It fails closed with no sweep to miss.** Auto-revoke is a write that must
  happen on every path that can remove a membership — this API, a CLI, a
  migration, a backfill, another service, or PostgreSQL's own FK enforcement. A
  missed sweep fails **open**, and silently. The derivation reads current state on
  every use, so there is no window and nothing to replay.
- **It handles demotion, which revocation cannot.** A developer demoted to viewer
  keeps a membership; auto-revoke never fires and the key keeps developer
  authority. This is the larger half of the original finding.
- **It degrades rather than destroys.** The key keeps exactly the scopes the
  issuer still holds, which is the answer an operator would give by hand.

Revocation stays the operator's tool for "this credential must die", and remains
the only thing that frees a slot against the per-project ceiling. Auto-revoke can
still be added later in `MembersService.remove` — the two compose, and this
choice is the one that is safe *without* the other.

Verified against PostgreSQL 16 (`hookubit_test`): deleting an
`organization_members` row leaves `api_keys.created_by_membership_id` NULL and
`created_by_user_id` intact, so the derivation yields ∅ and the operator can
still see who minted the key.

### The contract for `services/data-plane`

The ingest path does **not** consult `scopes` today — `internal/ingest/handler.go`
authenticates on the key, its project and its environment — so nothing in Go has
to change now. When it does start consulting scopes, the rule is:

> **Never authorize on `api_keys.scopes`. Authorize on the intersection of
> `api_keys.scopes` with the permissions of the role held *right now* by
> `api_keys.created_by_membership_id`, and treat a NULL
> `created_by_membership_id` as the empty set.**

It is one join on the key lookup already being issued, and both columns are
indexed for it:

```sql
SELECT k.id,
       k.project_id,
       k.environment,
       k.scopes                              AS minted_scopes,
       m.role                                AS issuer_role   -- NULL ⇒ no authority
  FROM api_keys k
  LEFT JOIN organization_members m
         ON m.id = k.created_by_membership_id
 WHERE k.key_hash   = $1
   AND k.revoked_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at > now());
```

Rules the Go side must hold, which are the same ones `effective-scopes.ts` holds:

1. `issuer_role IS NULL` ⇒ **empty** effective scopes. Never fall back to
   `minted_scopes`; "we no longer know whose authority this was" must not mean
   "all of it".
2. The intersection is computed **per request**. Cache the role lookup within a
   request if you like, never across requests — the point is that a demotion
   takes effect immediately.
3. A stored scope that is not a permission the build knows is **dropped**, not
   passed through.
4. The role→permission matrix is `apps/control-api/src/authz/permissions.ts`. If
   Go grows its own copy it is a second source of truth for authorization; prefer
   having the control plane expose the effective list, or generate the table from
   the same source.
5. Ingest authentication itself is unaffected by all of this. A key whose issuer
   is gone still authenticates and still ingests; it simply carries no
   control-plane authority.

`ApiKeyDto.effective_scopes` is the same derivation over HTTP, so an operator and
the data plane read one answer.

---

# Onboarding state, resend-verification, and the headers a browser could not read

Three gaps the dashboard work surfaced. All three are in `src/auth` and
`src/config`; nothing outside auth changed.

## `users.onboarding_completed_at`

The dashboard's product tour kept "has this person seen it?" in `localStorage`
(`hookubit.tour.v1`). That is per-browser, so the tour replayed on a second
device, in a private window and after a site-data clear — including for someone
who had deliberately *skipped* it — and support could not answer "was this user
ever onboarded?" at all.

**One nullable timestamp on `users`**, added by
`prisma/migrations/20260908000000_user_onboarding_completed_at`. Nullable with
no default and no backfill, so the migration writes a catalog row and does not
rewrite the table, and `DROP COLUMN` is a complete rollback. NULL means "has not
seen it", which is the safe direction: the tour is skippable and re-openable, so
showing it once more costs a keystroke while wrongly suppressing it leaves a new
user with no orientation. Backfilling `now()` over existing rows would have done
exactly that.

Deliberately **not** a boolean — a boolean cannot answer *when*, which is the
question asked when a cohort churns — and **not** a per-step progress blob,
which would make the tour's own layout a schema migration.

**Read it** on `user.onboarding_completed_at`, an ISO-8601 string or `null`,
carried on **every** response that returns a user: `GET /v1/auth/session`,
`POST /v1/auth/login`, `POST /v1/auth/verify-email`. The client decides whether
to show the tour without a second request.

**Write it** with:

```
POST /v1/auth/onboarding-completed   →  204 No Content
```

Exactly the shape `apps/dashboard/HANDOFF.md` asked for, and it is right.

- **Idempotent by SQL, not by read-then-write.** A conditional
  `UPDATE ... WHERE id = $1 AND onboarding_completed_at IS NULL`. Two tabs, or
  a retried request, race inside PostgreSQL and exactly one writes — so the
  recorded instant is the **first** completion and never drifts forward on a
  replay. A second call is 204, not 409: the client's question is "is this
  person onboarded", and after either call the answer is yes.
- **The user id comes off the verified session and from nowhere else.** No
  body, no path parameter, no field naming a user — so one account cannot
  complete another's, and that is a property of the signature as much as of the
  query. `auth.http.spec.ts` pins it by posting `{ user_id: <someone else> }`
  and asserting the other row is untouched (the validation pipe's
  `forbidNonWhitelisted` makes it a 400, which is also fine — what must never
  happen is the other row moving).
- **Audited once**, on the transition only (`user.onboarding_completed`), so a
  retrying client cannot flood `audit_logs`. It uses `AuthService.audit()`, not
  `AuditService.recordFor` — `recordFor` derives the organization from a
  resolved tenant context and an auth route has no tenant in its path;
  `audit()` resolves the user's own first membership, which is what every other
  user-level event in this class already does.

## `POST /v1/auth/resend-verification`

Registration ended on "check your email" with no way to ask for another link.

**Always 202, with an identical body**, whether or not the address is
registered, whether or not it is already verified, whether or not the account is
disabled, and **whether or not the mail transport is up**. That last clause is
the one that costs something: a failure escaping from here would answer 500 for
an unverified registered address and 202 for an unknown one — an enumeration
oracle assembled out of an error handler, which is precisely the bug that was
found and fixed in forgot-password. The try/catch covers the token writes either
side of the send, not just the mailer, because a transient database error on the
token write leaks the same bit.

Reuses the existing machinery rather than inventing any: `UserToken` of type
`email_verification` (hashed, single-use, 24h) via `TokenService`, and
`@Throttle` on the existing `ThrottleGuard`. Requesting a link **revokes the
previous one**, so the newest email is the one that works.

Throttled at **5/hour per IP and 5/hour per address, both enforced** — the same
numbers as forgot-password, the other mail-sending route reachable without
credentials. Unlike `verify-email`, the per-IP bucket here *refuses*: this route
sends mail to an address the caller typed, so an unlimited version is a
mail-bomb relay pointed at any unverified account and a way to burn the
deployment's sending reputation.

## `Access-Control-Expose-Headers`

`main.ts` set `origin` and `credentials` and nothing else, so a cross-origin
browser could read neither header this API relies on. Nothing errored — a
browser drops every response header that is not CORS-safelisted or on that list,
silently — which is why it went unnoticed.

CORS config moved to `src/config/cors.ts` (`corsOptions`, with `cors.spec.ts`)
and now exposes:

- **`Retry-After`**, set by `ThrottleGuard` on every 429. Without it the
  dashboard could only read `details.retry_after_seconds` out of the error body,
  so a 429 raised by anything that is *not* this guard — an ingress limit, a
  WAF, a load balancer — arrived with no usable "try again in N" at all.
- **`x-request-id`**, minted or accepted per request in `app.module.ts` and
  repeated in every error body as `request_id`. The header is the only way to
  get it off a **successful** response, which is what an operator needs when a
  request went through and did the wrong thing.

Nothing else is missing. The only other header this API sets is `Set-Cookie`,
which browsers refuse to expose to script whatever the list says. `origin` still
fails **closed** (`false`, never a reflected origin) when `CORS_ORIGINS` is
unset — this API is credentialed.

## Correction to `apps/dashboard/HANDOFF.md`

That document's "Still needed from the control API" list, item 2, says
**"Endpoints (`endpoints.service.ts:401`) and organizations
(`organizations.service.ts:134`) attach nothing but prose"**. That was true when
it was written and **is not true now**. All four ceilings — organizations per
user, projects per organization, API keys per project, endpoints per project —
raise `limit_exceeded` with `details: { limit, current, resource }`. See
`endpoints.service.ts:407` and `organizations.service.ts:140`. Items 1 and 2 of
that list are both closed; item 3 (`Retry-After` reachable from the browser) is
closed by the section above; item 4 (`resend-verification`) is closed by the
section above that.

## `EndpointDto.has_live_secret`

The dashboard added a "Resume deliveries" action on paused endpoints. `EndpointDto`
exposed nothing about signing secrets, and `POST /enable` refuses with 409 when
there is no live one — so the button was offered where it was **guaranteed to
fail**, and the operator found out by clicking.

That is not an edge case. `endpoints.write` is a `developer` permission and
`endpoint-secrets.*` is owner/admin, so an endpoint a developer creates is
deliberately left **paused with `secret_pending`** — the common path, and exactly
where the button 409s.

**The field means what `enable` checks**, because it is now literally the same
query: `active = true AND (expires_at IS NULL OR expires_at > now())`, the pair
the data plane's secret loader uses (`isEffectivelyActive`).
`EndpointSecretsService.hasLiveSecret` is one case of the new
`liveSecretEndpointIds`, so the answer the dashboard reads and the answer
`enable` refuses on cannot drift.

**Not `active` alone.** The control plane flips `active` off lazily after a
rotation, so between a secret expiring and the sweep running, `active` says
signable and the data plane has already stopped emitting it — the window an
operator is most likely to be staring at.

**No N+1.** `ScopedRepository.groupBy` (`by: ['endpointId']`, the live predicate,
`endpointId IN (<page>)`) answers the whole page in ONE statement, on the
existing `@@index([endpointId, active])`. The count is asserted constant across
page sizes rather than merely small, so it cannot decay back into a loop. The
scope needed nothing new — `groupBy` was already there, and `PrismaService` (which
is eslint-banned here) was never reached for.

**It is a boolean and nothing else.** No id, version, prefix or expiry:
`endpoints.read` includes `viewer`, `endpoint-secrets.read` is owner/admin. A
test pins the DTO's complete key set so a future secret-derived field fails
there rather than shipping quietly.

## Analytics (2026-09-08) — `src/analytics`

Read-only operator analytics. Nothing in this module writes, and nothing caches:
every number is read from the delivery ledger at request time through
`ScopedRepository`, so it cannot disagree with `GET /deliveries`. That is the
property that matters at 2am, when someone reads a failure count here and then
goes looking for the rows behind it.

### Module registration — the line I could not add myself

`src/app.module.ts`:

```ts
import { AnalyticsModule } from './analytics';
// ...
imports: [ /* ... */, AnalyticsModule ],
```

It imports nothing and provides one service. `AuthzModule` is `@Global`, so
`TenantScopeFactory` is already injectable; there is no transaction runner
(nothing is written) and no audit call (reading an aggregate of rows the caller
may already list one by one is not an auditable event).

### Routes

All under `/v1/projects/:projectId/analytics`, all `GET`, all taking
`window_hours` (integer, 1..720, default 24).

| Route | Permission | Answers |
|---|---|---|
| `/deliveries` | `deliveries.read` | Outcome mix over the window **and the window before it** |
| `/endpoints` | `deliveries.read` | Which endpoints are failing, ranked worst first (`limit`, 1..50, default 10) |
| `/latency` | `deliveries.read` | p50/p95/p99 of `delivery_attempts.duration_ms` |
| `/events` | `events.read` | Event volume and the busiest event types (`limit`, 1..50, default 10) |

Shapes are in `src/analytics/dto/analytics-response.dto.ts` and every field
carries an `@ApiProperty` description, because the dashboard client is generated
from that document. The three that are worth knowing before reading a response:

- **`success_rate` is `null`, never `0`, when nothing settled.** Zero is a real
  and alarming value — everything we tried failed — and using it for "we have
  not tried anything" is the difference between a quiet night and a pager. Same
  rule for `success_rate_delta`: a change from unknown is not a change.
- **`by_status` always carries all nine statuses.** `GROUP BY` returns no row
  for a status with no deliveries, and a response that omitted `exhausted`
  because there were none is indistinguishable, to a client, from one that
  omitted it because this build does not report it.
- **`latency.exact`.** See "the one dishonest number, made honest" below.

### The permission choice: `deliveries.read` and `events.read`, no new row

No permission was added to the matrix. Three reasons, in order of weight:

1. **An aggregate is strictly weaker than the rows it aggregates.** Everything
   `/analytics/deliveries` returns is derivable by a caller who can already page
   `GET /deliveries`. A new permission would gate a summary of data the holder
   of `deliveries.read` can already read one row at a time, which is theatre.
2. **Per-TABLE, not per-module.** `/events` uses `events.read` and the other
   three use `deliveries.read`, even though the two grants are identical in
   today's matrix. That is the point: the day they diverge, each route moves
   with the table it reads rather than with the module it happens to live in.
3. The matrix's own comment about `billing` — "sees no events and no
   deliveries" — settles the interesting case. `billing` gets a **403** on all
   four routes: it is in the tenant, so the answer is forbidden, not not-found.
   `viewer` gets **200** on all four.

`TENANT_SCOPE_PERMISSIONS` needed no change; this module adds no `TenantScope`
accessor.

### The window: refused, never clamped

`window_hours` is `1..720` (30 days), default 24. Above the ceiling is a **400**,
not a shortened window. This is the one design decision in the module I would
argue for hardest: a clamp answers a question the caller did not ask and labels
the answer with the period they asked for. "Deliveries in the last 90 days:
4,102" as a 30-day number wearing a 90-day label is worse than an error,
because the person reading it is deciding whether something is getting worse.

The ceiling is enforced twice, deliberately: `@Max` on the DTO (the HTTP edge)
and again inside `resolveWindow` (the function another module would call). A
validation rule that only exists on a decorator is one non-HTTP caller away from
being absent.

`ValidationPipe` runs with `forbidNonWhitelisted`, so `?window=30d` — the
dashboard's current shorthand — is a **400** rather than a silently ignored
parameter that returns the 24h default under a 30-day label.

### EXPLAIN — run against live PostgreSQL 16.2, not guessed

Plans were captured on a copy of the real migrated schema seeded to **1,000,000
deliveries (800,000 in the project under test, over 90 days), 800,000
delivery_attempts, 600,000 events, 3 projects across 2 organizations**. The dev
database has ten deliveries in it; every plan there is a sequential scan of one
page and proves nothing, so a scratch database (`hookubit_explain`) built from
the same four migration files was used instead. `EXPLAIN (ANALYZE, BUFFERS)`
output for each query is summarised in the docblock above the method that issues
it.

| Query | Window | Plan | Time |
|---|---|---|---|
| status roll-up | 24h | Nested Loop over the project's endpoints → Bitmap Index Scan `deliveries_endpoint_id_created_at_idx` → HashAggregate, 8,874 rows | 13.7 ms |
| status roll-up | 168h | Bitmap Index Scan `deliveries_project_id_created_at_idx`, 62k rows | 22.7 ms |
| status roll-up | 720h | **Parallel Seq Scan**, 266k rows (33% of the table) | 207 ms |
| endpoint ranking | 24h | Bitmap Index Scan `deliveries_project_id_status_created_at_idx` → GroupAggregate → top-N | 9.8 ms |
| latency: delivery sample | 720h | Index Scan `deliveries_project_id_created_at_idx`, 201 tuples, stops | **0.35 ms** |
| latency: attempts | 24h | 200 × Index Scan `delivery_attempts_delivery_id_idx` | 37 ms |
| event count | 24h | Index Scan `events_organization_id_created_at_idx`, 4,431 rows | 24.5 ms |
| event count | 720h | Parallel Bitmap Heap Scan `events_project_id_created_at_idx`, 133k rows | 209 ms |
| events by type | 24h | same index → HashAggregate | 2.9 ms |

Three findings worth carrying forward:

**1. One index was missing and is now added.**
`20260908010000_analytics_delivery_window_index` creates
`deliveries (project_id, created_at DESC)`. `deliveries_project_id_status_created_at_idx`
cannot serve "everything in this project over this window" — `status` sits
*between* the two constrained columns, so `created_at` can never be a boundary
condition and rows never come back in `created_at` order. Measured, the latency
sample at the 720h ceiling is **226.6 ms (Parallel Seq Scan + top-N heapsort)
without it and 0.35 ms with it**, and — the part that actually matters — without
it the cost grows with the *window*, so the response gets slower every day the
table grows; with it the cost is fixed at the LIMIT and does not grow at all.
`INCLUDE (status, endpoint_id)` was tried and rejected: no index-only scan
resulted and the covering variant was *slower* on the 168h roll-up (48.4 ms vs
22.7 ms) for a larger index. Cost: 27 MB against a 118 MB table at 1M rows, plus
one more btree write on the hottest INSERT path in the product. **On a large
populated `deliveries` table, build it `CONCURRENTLY` by hand first** — the
migration is `IF NOT EXISTS` and will then skip it; the exact statement is in the
migration's header comment. It is also in `schema.prisma`, so unlike the partial
indexes it is **not** drift and needs no entry in
`deployments/ci/expected-schema-drift.txt`.

**2. The 720h ceiling is a sequential scan, and that is the correct plan.**
A third of the table matches; no index beats a scan at that selectivity. This is
why 720h is a hard ceiling with a 24h default rather than an open parameter, and
why the routes are throttled.

**3. `events` may not use the index you expect.** The `projectAndOrganization`
scope puts *both* columns in the predicate, and at 24h the planner chose
`events_organization_id_created_at_idx` and filtered by project (1,108 rows
removed, ~20% waste). Cheap for an organization with a handful of projects; it
degrades linearly with the number of sibling projects. Not "fixed" with a hint,
because the fix is a planner-statistics question, not a code one.

### The one dishonest number, made honest

**p50/p95/p99 are computed over a bounded SAMPLE, and the response says so.**

An exact percentile is `percentile_cont`, which is raw SQL, which is
`PrismaService` — banned outside the allowlist, for the reason that makes this
whole layer worth having. `ScopedRepository` exposes `aggregate` and `groupBy`;
neither can express an ordered-set aggregate, and grouping by `duration_ms`
itself would produce thousands of groups and be refused by the repository's own
ceiling, correctly.

So: the most recent 200 deliveries in the window, and up to 200 of their measured
attempts. `exact` is `true` only when neither bound was reached — the common case
for a normal project on a 24h window, always the case for a quiet one. When it is
`false`, **the percentiles describe the most recent traffic in the window rather
than the whole of it**, and `sample_size` / `sampled_deliveries` say how much was
measured. That recency bias is real. Hiding it would be worse than having it.

Nearest-rank, not linear interpolation: every value returned is a duration that
was actually observed. An interpolated p95 of 412.5 ms is a number no request
ever took, and someone will go looking for the attempt that produced it.

The fix, when it is worth doing, is one of: a `percentile_cont` escape hatch on
`ScopedRepository` (a `rawAggregate` that still builds the tenant predicate); a
`duration_bucket` column on `delivery_attempts` written by the data plane, which
makes an exact histogram a plain `groupBy`; or the rollup below.

### Where this stops scaling, and what comes next

Stated as row counts, because "it depends" is not an answer anyone can act on.

| Table | Comfortable | Degraded | Unusable |
|---|---|---|---|
| `deliveries` (per project) | < 1M in the window | 1M–5M — the 720h roll-up is already a 200 ms+ parallel scan at 266k | > 5M: every wide-window request occupies a worker for seconds; concurrent dashboards exhaust the pool |
| `delivery_attempts` | any, while the sample stays at 200 | — | the sample is O(1); this table never becomes the bottleneck for *this* module |
| `events` (per project) | < 500k in the window | 500k–2M | > 2M |

The first thing to break is **not** latency — it is the 720h status roll-up
under concurrency. One 200 ms parallel scan is fine; ten dashboards refreshing
on a 30-second timer is a third of the connection pool permanently occupied
scanning the same 266k rows.

Three steps, in the order I would take them:

1. **Cache the wide windows, not the narrow ones.** 168h and 720h roll-ups
   change by fractions of a percent per minute. A 60-second cache keyed by
   (project, window) removes the whole problem for a year, and the honesty cost
   is bounded and expressible: return the timestamp the numbers were computed
   at. 24h stays live — that is the window someone is staring at during an
   incident.
2. **Write `usage_records`.** The table exists, is organization-scoped, is
   already mapped in `TenantScope` (`billing.read`), and **nothing writes to
   it**. An hourly rollup of (project, hour, status) → count is exactly what a
   time series needs and what this module could not build, and it makes the
   90-day question a hundred-row read instead of a million-row scan. It also
   gives the dashboard back the hourly chart this module declined to fake.
3. **Only then, a materialised view.** It is the tempting first move and it is
   the wrong one: `REFRESH MATERIALIZED VIEW CONCURRENTLY` over a table this
   size is its own operational problem, and it buys nothing that (2) does not,
   at the cost of a refresh schedule nobody owns.

### Divergence from the dashboard's speculative shape — and what it needs to change

`apps/dashboard/src/features/analytics/AnalyticsPage.tsx` was built against a
mock `GET /v1/projects/:id/analytics` returning
`{ window: '24h'|'7d'|'30d', points: AnalyticsPoint[], totals, p95_latency_ms,
success_rate }`. It says on itself that it is provisional. It was read as a hint,
not a specification, and it diverges in three places:

1. **Four routes, not one payload.** The four questions cost different amounts.
   One combined route makes the cheapest tile on the page wait for the dearest
   query and blanks the whole panel when one is slow. Four requests render as
   they land, are throttled separately, and can be cached separately (see step 1
   above). Call all four in parallel.
2. **No hourly `points[]`.** Bucketing a timestamp needs `date_trunc` → raw SQL
   → `PrismaService`. The alternative, one grouped query per bucket, is 24 index
   range scans of the same range to answer one question. **What replaced it is
   better for the actual question:** every count is returned for the window *and*
   the immediately preceding window of equal length, with the delta. "Is it
   getting worse?" is a comparison, and this answers it in a number rather than
   asking a human to eyeball the slope of a bar chart — for the cost of two index
   range scans instead of twenty-four. The chart comes back with `usage_records`.
3. **`window: '24h'` → `window_hours: 24`.** An enum cannot express a ceiling,
   and the ceiling is the interesting part. Map the shorthands 24 / 168 / 720.
   Note that `?window=30d` is now a **400**, not an ignored parameter.

Also: `totals.pending` on the page is labelled "In retry". Those are different
things and the new response separates them — `in_flight` is the roll-up (pending,
scheduled, queued, processing, retrying), `by_status.retrying` is the real one.

### Verified

`prisma:generate`, `lint`, `build`, `test` all pass — **1497 tests, 64 suites**
(was 1417/62). Two new suites:

- `analytics.service.spec.ts` (27) — every count asserted as an **exact
  integer** against a fixture whose numbers are written down by hand in
  `EXPECTED`, with decoys one step outside every boundary: the previous window,
  rows older than both, a sibling project in the same organization, and another
  organization entirely. A shape assertion would pass on a response carrying the
  whole platform's totals. Also: the window ceiling refused rather than clamped,
  an empty project returning zeroes and `null` rather than erroring, an
  unmeasured (`duration_ms IS NULL`) attempt not counting as zero milliseconds.
- `analytics.http.spec.ts` (53) — a real Nest app on a real port with the real
  guards. Cross-tenant is **404 with `CROSS_TENANT_MESSAGE`** on all four routes,
  identical for an absent project id and a foreign one, and the 404 body is
  asserted to carry none of the other tenant's numbers. `viewer` 200, `billing`
  403 (in the tenant, so forbidden, not not-found), `developer` 200. The ceiling
  is 200 at exactly 720 and 400 at 721, with no `window` in the failed body.
  Every route asserted to carry `@Throttle`.

Both run against `FakeTenantPrisma` like every other module, wrapped by
`src/analytics/testing/aggregate-fake.ts`. That wrapper exists for one honest
reason: the shared fake **ignores `orderBy` and `take` on `groupBy`** — nothing
before this module passed either. The endpoint ranking is `ORDER BY count DESC
LIMIT n` *in PostgreSQL*, and against a fake that ignored both, "the worst
endpoint is first" would pass because the fixture happened to be inserted
worst-first. The wrapper applies exactly the two argument shapes this service
sends and **throws on anything else**, so a query it cannot model faithfully
fails the suite rather than being quietly mis-answered.

**Not covered by the suite**, and worth knowing: the fake's `findMany` sorts
dates as strings, so the *recency* of the latency sample (`ORDER BY created_at
DESC LIMIT 200`) is not asserted — the fixture is small enough that the sample is
the whole window. The ordering itself is what the new index makes cheap and is
verified by the EXPLAIN above, not by a test.
