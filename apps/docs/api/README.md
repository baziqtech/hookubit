# API reference

Everything you can call, and what it answers. This section is the contract; the
[guide](/guide/) is the narrative that explains why the contract looks the way
it does.

Every page here except this one and [Ingest](./01-ingest.md) is **generated on
every build** from the OpenAPI document the control plane emits from its own
source - the same document the dashboard's client is generated from. A route or
a field that is not in the product cannot appear here, and a committed copy
that has drifted fails the build. Where a description reads oddly, the fix is
in the product's own declarations, not in this site.

## Two surfaces

HookuBit is two processes with two jobs, and the API follows that split.

| Surface | What it is for | Where |
|---|---|---|
| **Ingest** | Publishing events. One endpoint, on the hot path, served by the data plane. Authenticates with an API key. | `POST /v1/projects/{project_id}/events` - [Ingest](./01-ingest.md) |
| **Control API** | Everything else: organizations, projects, endpoints, subscriptions, policies, keys, the event and delivery ledger, replay, audit, analytics, sign-in. Authenticates with a dashboard session. | `/v1/...` - the remaining pages |

The two are separable on purpose. The control API can be down and queued
deliveries still go out; the ingest endpoint can be saturated and the dashboard
still answers. Do not assume they share a hostname.

## Base URLs

HookuBit is self-hosted, so the base URLs are whatever your operator
configured: the ingest listener and the control API are separate processes,
usually behind separate hostnames, and nothing in this reference hard-codes
either. Every path here is relative to the base of the surface it belongs to.
Ask your operator, or read them off the dashboard's project page; for a local
run the defaults are the ingest listener on port 8080 and the control API on
port 3000 (see [Self-hosting](/self-hosting/)).

## Authentication

Two credentials, for two different callers. Each operation's **Auth** line says
which it takes.

### API keys - servers publishing events

An API key is a bearer token for the ingest endpoint:

```http
Authorization: Bearer wk_live_3xAmPl3S3cr3tK3yV4lu3Chars32Aa
```

- Minted under a project with [`POST /v1/projects/{projectId}/api-keys`](./05-api-keys.md#post-v1-projects-projectid-api-keys).
  The plaintext is in that response and nowhere else; HookuBit stores a hash.
- The prefix encodes the environment: `wk_live_` for a live project, `wk_test_`
  for a test project. A key only authenticates against its own project, and
  only while the project is active and the environments agree.
- A key stops working the instant it is revoked or reaches its `expires_at`.
  Revocation is immediate and irreversible.
- Keys carry `scopes` - a list of control-plane permissions, capped at what the
  person minting the key holds. **Today the control API authenticates every
  route with a dashboard session and does not accept an API key as a
  credential**; scopes are stored against the key for when it does, and the
  ingest endpoint does not consult them at all (an ingest-only key has an empty
  list). Read `effective_scopes`, not `scopes`, for what a key may do now.

### Sessions - people using the dashboard

A browser signs in with [`POST /v1/auth/login`](./16-auth.md#post-v1-auth-login)
and receives an HTTP-only, `SameSite=Lax` cookie named `session`, valid for
seven days or until `POST /v1/auth/logout`, whichever is first. The cookie is
the credential for every control API operation; there is nothing to put in a
header. A disabled account is refused even with a cookie that has not expired,
and an account whose address was never verified is not issued one: login
answers `403 email_not_verified` until the address is confirmed.

### Authorization - what a signed-in user may do

Access is by **role in an organization**. The permission matrix is fixed, and
the `forbidden` error names the permission you lacked and the role you held.

| Permission | owner | admin | developer | viewer | billing |
|---|:-:|:-:|:-:|:-:|:-:|
| `projects.read` | yes | yes | yes | yes | yes |
| `projects.write` | yes | yes | | | |
| `endpoints.read` | yes | yes | yes | yes | |
| `endpoints.write` | yes | yes | yes | | |
| `endpoint-secrets.read` / `.write` | yes | yes | | | |
| `subscriptions.read` | yes | yes | yes | yes | |
| `subscriptions.write` | yes | yes | yes | | |
| `api-keys.read` / `.write` | yes | yes | yes | | |
| `events.read` | yes | yes | yes | yes | |
| `events.replay` | yes | yes | yes | | |
| `deliveries.read` | yes | yes | yes | yes | |
| `deliveries.replay` | yes | yes | yes | | |
| `policies.read` (retry and rate-limit policies) | yes | yes | yes | yes | |
| `policies.write` | yes | yes | yes | | |
| `members.read` | yes | yes | yes | yes | yes |
| `members.write` | yes | yes | | | |
| `audit.read` | yes | yes | | | |
| `billing.read` | yes | yes | | | yes |
| `billing.write` | yes | | | | yes |

Three rules sit beside the grid. Nobody may assign a role above their own, or
change their own role. An organization always keeps at least one owner. While
an organization or project is **suspended**, only reads and `billing.write`
are permitted.

Reading an endpoint's **signing secret** is `endpoint-secrets.read` - owner and
admin only - and is not implied by `endpoints.read`: whoever holds the secret
can forge a webhook into your own systems.

## Versioning

Every path is under `/v1`. Changes within `/v1` are **additive only**: new
fields, new optional parameters, new operations, new error codes. Nothing is
removed, renamed or given a different meaning; when that is ever needed it will
be `/v2`, alongside. Two consequences for your code:

- Decode responses tolerantly. A field you have not seen may appear.
- Branch on `error.code`, never on `error.message`. Codes are never removed or
  repurposed; messages are prose and may be reworded.

## Errors

Every non-2xx response from either surface has the same body:

```json
{
  "error": {
    "code": "limit_exceeded",
    "message": "This project has reached its endpoint limit.",
    "request_id": "req_01J9Z0H8M4Q1R6T7V8W9X0Y1Z2",
    "details": { "limit": 50, "current": 50, "resource": "endpoints" }
  }
}
```

- `code` is stable and machine-readable. [Errors](./errors.md) lists every one
  with its HTTP status and, where the contract fixes it, the shape of `details`.
- `message` is for a person. On a validation failure it is a **string array**,
  one entry per rejected field. Narrow the type before rendering it.
- `request_id` appears on every log line for that request. Quote it when you
  ask for help. The control API also returns it in an `x-request-id` response
  header and will echo one you send, if it matches `^[A-Za-z0-9_-]{1,64}$`; the
  ingest endpoint always mints its own and returns it as `X-Request-Id`.
- `details` is absent on most errors and is the contract where it is present:
  `limit_exceeded` always carries `{ limit, current, resource }`, `rate_limited`
  always carries `retry_after_seconds`, and `forbidden` carries
  `required_permissions` and `role`.

## Pagination

Every list operation pages the same way.

**Request:** `limit` (1 to 200; omitted means 50; anything above 200 is refused
with `400 invalid_request`, not clamped) and `offset` (0 or more; omitted means
0).

**Response:**

```json
{ "data": [ ... ], "has_more": true, "next_offset": 50 }
```

- `data` holds at most `limit` rows.
- `has_more` says whether rows remain beyond this page. It is the only way to
  know you have reached the end: there is no `total`, deliberately, because a
  count taken separately from the rows cannot be used to find the last page
  reliably.
- `next_offset` is the `offset` to send for the next page. It is `null` - never
  absent, never `0` - on the last page.

So the loop is: start at `offset=0`, request, process `data`, and while
`has_more` is true request again with `offset=next_offset`. Offsets are not
stable under concurrent writes; for an export of a busy table, pair the page
with a `created_before` bound where the operation offers one.

## Rate limiting

**Ingest** is rate limited per API key, per project and per organization as
nested budgets, with a platform default when you have configured none, plus a
per-source-address ceiling that runs before authentication. The limits are
yours to set with [rate-limit policies](./10-rate-limits.md); the behaviour is
specified on the [Ingest](./01-ingest.md#rate-limiting) page.

**The control API** throttles a handful of operations that are either
unauthenticated (sign-in, registration, password reset) or expensive or
side-effecting (creating an organization, requeuing the outbox, changing
rate-limit policies). The operations that can do so document a `429` response.

A refused request answers `429` with `error.code: "rate_limited"`, a
`Retry-After` header in whole seconds, and the same number as
`error.details.retry_after_seconds`. Wait that long; there are no
`X-RateLimit-*` headers to read ahead of time.

## Idempotency

**Ingest** accepts an `Idempotency-Key` header and guarantees that retrying the
same request creates at most one event. The rules - scope, window, what counts
as "the same" - are on the [Ingest](./01-ingest.md#idempotency) page.

**The control API** does not currently accept an `Idempotency-Key` header. A
write you retry after a timeout may have already happened; read the resource
back before repeating a create. Enable/disable, revoke and delete converge
naturally - repeating them changes nothing further - and creates are protected
by uniqueness where the resource has a natural key (a project slug, for
instance), in which case the repeat answers `409 conflict`.

## Identifiers and timestamps

Every id is a prefixed, lexicographically sortable ULID, so a glance at an id
tells you what it names and ids created later sort later:

| Prefix | Resource | Prefix | Resource |
|---|---|---|---|
| `org_` | organization | `evt_` | event |
| `usr_` | user | `del_` | delivery |
| `mem_` | membership | `att_` | delivery attempt |
| `proj_` | project | `obx_` | outbox entry |
| `key_` | API key | `aud_` | audit log entry |
| `ep_` | endpoint | `rp_` | retry policy |
| `eps_` | endpoint signing secret | `rl_` | rate-limit policy |
| `sub_` | subscription | | |

Timestamps are ISO 8601 strings in UTC with millisecond precision, for example
`2026-01-01T00:00:00.000Z`. Durations in request bodies are named with their
unit (`timeout_ms`, `overlap_seconds`).

## Reading order

| Page | Read it when |
|---|---|
| [Ingest](./01-ingest.md) | You are about to publish your first event. The one endpoint on the data plane, every header, every error. |
| [Organizations](./02-organizations.md), [Members](./03-members.md), [Projects](./04-projects.md) | You are setting up the tenancy: who is in the team, which projects exist, live versus test. |
| [API keys](./05-api-keys.md) | You need a credential for a publisher. |
| [Endpoints](./06-endpoints.md), [Endpoint signing secrets](./07-endpoint-secrets.md) | You are registering a receiver, or rotating the secret it verifies with. |
| [Subscriptions](./08-subscriptions.md) | You are deciding which events reach which endpoint. |
| [Retry policies](./09-retry-policies.md), [Rate-limit policies](./10-rate-limits.md) | You are tuning how failure and volume are handled. |
| [Events](./11-events.md), [Deliveries](./12-deliveries.md), [Outbox](./13-outbox.md) | Something did not arrive and you need to know what happened, then replay it. |
| [Audit log](./14-audit.md), [Analytics](./15-analytics.md) | Who changed what; which endpoints are failing; how latency looks. |
| [Authentication](./16-auth.md) | You are building on the dashboard's own sign-in flow. Most integrators never need this page. |
| [Errors](./errors.md), [Schemas](./schemas.md) | Reference: every error code; every request and response body by name. |
