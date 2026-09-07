# Dashboard — handoff

## The build serves mock data by default, and now says so

`resolveTransport()` in `src/lib/api.ts` uses the in-memory mock in
`src/lib/mock/` unless `VITE_API_TRANSPORT=http`, and
`deployments/docker/dashboard.Dockerfile` does not set it. The production image
therefore ships a page that looks like a working, signed-in product while every
value on it is fabricated. A security review flagged exactly that: someone will
deploy it, demo it, and believe it.

`src/components/DemoDataBanner.tsx` now renders a red, full-width
**"Demo data — not connected to an API"** bar. It is mounted in `src/main.tsx`
*above* `<RouterProvider>`, so it is present on the auth pages as well as the
app shell, and it has no dismiss control — the condition it reports does not go
away by being acknowledged. The quieter `MockBanner` that used to live inside
`AppLayout` is gone; there is one banner, in one place.

**To turn it off:** build with the real transport.

```sh
VITE_API_TRANSPORT=http pnpm --filter @webhook/dashboard build
```

`usingMockApi` in `src/lib/api.ts` is the single source of that signal — the
transport choice is derived once and exported. Do not re-derive it from
`import.meta.env` anywhere else; the banner disappearing while the app still
talks to the mock is the failure mode worth designing against.

**Still open:** the Dockerfile should pass `VITE_API_TRANSPORT=http` as a build
arg (`ARG`/`ENV` before `pnpm build`) once the control API is deployed
alongside it. That file is owned by the deployments side — until it changes, the
image is honestly labelled rather than silently wrong. Tests in
`src/components/DemoDataBanner.test.tsx` pin both directions.

## Login handles `email_not_verified`

The control plane's auth hardening returns `403` with
`{ error: { code: "email_not_verified", … } }` when a registered user signs in
before following the verification link. The dashboard showed the generic
credential-failure panel for it, which sends a user with a perfectly good
password round the password-reset loop.

`LoginError` in `src/features/auth/LoginPage.tsx` now branches on that code and
renders a "Check your email to verify this address" panel, worded to match the
confirmation state `RegisterPage` already ends on. Everything else still falls
through to the shared `FormError`. The code was added to `ApiErrorCode` in
`src/types/api.ts` — that file is the temporary hand-written stand-in and goes
away with the generated OpenAPI client, so the code needs to exist in the
control API's published schema too.

### Follow-up: no way to resend a verification email

There is deliberately **no "resend verification link" button**, because there is
no endpoint behind it. The user's only recovery today is to find the original
email or register again.

Needed from the control API, then a button on that panel:

- `POST /v1/auth/resend-verification` with `{ email }`.
- Unconditional `202` for a known and an unknown address, matching the
  registration response, or it becomes the account-enumeration oracle that the
  `202` on `/v1/auth/register` exists to close.
- Rate limited per address and per IP — this endpoint sends mail on demand.

## Contract drift found against the six mounted control-plane modules

`src/types/api.ts` was hand-written against `docs/API.md` and had silently
drifted from the DTO classes that actually exist. **TypeScript could not catch
any of this** — the compiler believes whatever the hand-written type says, which
is the same class of failure that broke the register flow. Everything below was
verified by reading `apps/control-api/src/**/dto/**` and the controllers, not
from the prose.

### List routes are a breaking wire change, and there are THREE envelopes

Not one. They are modelled separately in `src/types/api.ts` on purpose:
collapsing them into one optional-everything type is exactly how a missing
`has_more` becomes `undefined` and a truncated list renders as complete.

| Module | Envelope | Type |
| --- | --- | --- |
| projects, api-keys | `{ data, count, has_more, next_offset }` | `CountedOffsetPage<T>` |
| endpoints, endpoint-secrets | `{ data, has_more, next_offset }` — no `count` | `OffsetPage<T>` |
| organizations, members | `{ data, total, limit, offset }` — **no `has_more`, no `next_offset`** | `TotalPage<T>` |

The dashboard had a single cursor-based `Page<T>` (`{ data, has_more,
next_cursor }`). **The API pages by offset and `next_cursor` does not exist
anywhere.** `CursorPage<T>` survives only for the mock-only routes below.

`count` is the rows in *this page*, not a total. `src/lib/pagination.ts` ignores
it deliberately and reads `has_more`; `totalPage()` is the only place that
derives `has_more` for the organizations/members shape, from
`offset + data.length < total` — note **rows returned, not `limit`**, so a short
final page reads as complete instead of promising one more empty page.

### Field-level drift (every one of these would have rendered `undefined`)

- **`Endpoint`**: `circuit_state`, `rate_limit_per_second` and
  `success_rate_24h` **do not exist on the wire.** They were invented. The
  breaker reports through `status` + `disabled_reason` + `disabled_at`
  ("Operator intent. The circuit breaker uses `status`"), and the token bucket
  is `rate_limit` per `rate_limit_window_seconds`. Also missing locally:
  `description`, `enabled`, `max_concurrency`, `retry_policy_id`,
  `custom_headers`, `updated_at`, and `status: 'deleted'`.
- **`ApiKey`**: `masked_key` does not exist — the field is `key_prefix` (first
  12 chars). `status`, `environment`, `scopes` and `expires_at` were missing.
  `status` is derived server-side from the two timestamps, revoked outranking
  expired, exactly as the ingest path derives it; the dashboard no longer
  guesses it from `revoked_at`, which disagreed on an expired key.
- **`Member`**: identity is **flat and nullable** (`user_id`, `email | null`,
  `name | null`, `disabled`), not a nested `user` object. There is no `status`
  and no `joined_at`. An invitation creates **no member row at all**, so
  "invited" was never a state this list could return.
- **`Organization`**: no `plan`. It has `status` and `updated_at`.
- **`Project`**: `environment` is **`test | live`** — not
  `production | staging | development`. Every comparison against `'production'`
  in `Switchers.tsx` was dead code. `status` and `updated_at` were missing.
- **`EndpointSecret`**: no `masked_secret`. The read DTO has no field a
  plaintext could occupy, which is the point.
- **`ApiErrorBody`**: was missing `details`, which is load-bearing — see below.

### Route drift

`GET /v1/projects?organization_id=` **does not exist**. Projects are nested:
`GET /v1/organizations/:orgId/projects`. A request to the old path would have
404'd against the real API the moment the transport flipped.

### Rate limits and ceilings are both refusals, and the API cannot tell them apart

Every write route now carries `@Throttle`. Separately, creates can fail on a
resource ceiling (organizations per user, projects per org, endpoints and API
keys per project).

**There is no `limit_exceeded` error code.** A ceiling is thrown as
`AppError('conflict', …)`, so on the wire it is a 409 that is
*indistinguishable from a duplicate-slug conflict on `code` alone*. The
dashboard therefore classifies rather than switches, in `src/lib/api-errors.ts`:

1. `details.limit` present on a 409 → ceiling, with numbers. Exact.
2. otherwise a 409 whose message matches `/which is (its limit|the limit|the maximum)/`
   → ceiling, without numbers. **Fragile — it breaks if anyone rewords a message.**
3. anything else 409 → an ordinary conflict.

The distinction matters because the remedies are opposites: a 429 clears itself
and the panel says how long, a ceiling never does and its copy must never say
"try again". `WriteErrorNotice` renders them differently and
`WriteErrorNotice.test.tsx` pins that they cannot converge.

## Still needed from the control API

1. **A distinct error code for a resource ceiling** — `limit_exceeded`, or a
   stable `details.reason`. Rule 2 above is prose-matching in a UI, which is not
   a contract. This is the single most valuable thing to add.
2. **`details: { limit, current }` on every ceiling.** Projects
   (`projects.service.ts:217`) and API keys (`api-keys.service.ts:212`) attach
   it. **Endpoints (`endpoints.service.ts:401`) and organizations
   (`organizations.service.ts:134`) attach nothing but prose**, so the UI cannot
   tell the user how close they are for two of the four ceilings.
3. **`Retry-After` / `retry_after_seconds` reachable from the browser.** The
   guard sets both, but a cross-origin deploy needs `Retry-After` in
   `Access-Control-Expose-Headers`; the dashboard currently reads only
   `details.retry_after_seconds`.
4. **`POST /v1/auth/resend-verification`** — still open, unchanged from below.
5. **Publish `/docs-json`.** `src/types/api.ts` is a second source of truth and
   this whole document is the cost of it. `pnpm generate:api` deletes the
   problem.
6. **Whether `secret_pending` is derivable after creation.** It appears only on
   the create response. A dashboard listing endpoints cannot currently
   distinguish "paused by an operator" from "paused because it has no secret" —
   it infers it from `enabled` + `status`, which is a guess. A
   `has_live_secret` field on `EndpointDto`, or the secrets count, would settle
   it.
7. **Modules that do not exist yet.** Events, deliveries, subscriptions,
   analytics, usage and audit logs are still served only by the mock and are
   marked SPECULATIVE in `src/types/api.ts`. They currently use `CursorPage<T>`;
   when they land they will presumably use an offset envelope like everything
   else, and those screens will need the same treatment this pass gave the other
   five.

## Pagination is surfaced, not swallowed

`has_more` exists because the backend refuses to silently truncate, so the UI
refuses to as well. `src/components/Pager.tsx` is offset prev/next — chosen over
infinite scroll because the operator surface is read to answer "have I seen
every key that can authenticate as us?", and a scroll position is not an answer
to that. It renders **even on a single page**: a control that disappears when
there is nothing more is indistinguishable from one that failed to render, and
the point is that "complete" is stated rather than inferred. When `has_more` is
true it shows an explicit **"more not shown"** marker.

Wired on projects, endpoints, API keys, members and endpoint secrets. The
org/project switchers show a truncation note instead of a pager — a menu
silently listing the first page would have someone conclude a project had been
deleted.

Each page is cached under its own `offset` in `src/lib/query-keys.ts`, with a
`*Root` prefix key that mutations invalidate so page 2 cannot keep serving a key
that has since been revoked.

## Boolean query parameters

`?flag=false` was parsed as `true`, because `Boolean('false')` is `true` — which
had `?include_deleted=false` turning soft-deleted rows **on**, with a 200. The
API now compares the string. `booleanParam()` in `src/lib/pagination.ts` emits
the literal `'true'`/`'false'`, never `1`/`0` and never a bare flag name, and
omits the parameter entirely when unset so the server default applies. The mock
mirrors `BooleanQuery` exactly and `contract.test.ts` pins all three cases.

## One-time credentials

API key plaintext and endpoint signing secrets are returned exactly once and
cannot be recovered by anyone, including support — only a hash is stored.
`SecretReveal` states that before showing the value, gives an explicit copy
affordance, and uses a selectable `<code>` so it still works where
`navigator.clipboard` is unavailable (insecure origin).

**The plaintext is never written to the query cache.** The create mutations
invalidate the list rather than patching it with the create response: a cache
entry holding a live credential would survive navigation, be visible in the
React Query devtools, and be serialised by any future cache persister. It lives
in component state for as long as the dialog is open and nowhere else.

## `secret_pending` — a create that succeeds and does not work

A caller without `endpoint-secrets.write` (a developer) creates an endpoint that
comes back `secret: null`, `secret_pending: true`, **PAUSED and not
delivering**. `EndpointCreatedNotice` refuses to present that as success: it
says the endpoint will not receive deliveries, that an owner or admin must
rotate its secret and hand over the plaintext, and why going live instead would
cause two verification outages rather than none. Pinned in
`EndpointCreated.test.tsx`.

## Testing

There is no jsdom or Testing Library in this workspace, and adding one was out
of scope for these fixes. Component tests render through
`react-dom/server`'s `renderToStaticMarkup` and assert on the markup, which
covers presence/absence and copy but not interaction. The tests added for the
contract realignment follow the same pattern — `WriteErrorNotice.test.tsx` and
`EndpointCreated.test.tsx` render to markup, and the envelope, ceiling-vs-
throttle and `secret_pending` logic is tested as plain functions in
`src/lib/pagination.test.ts`, `src/lib/api-errors.test.ts` and
`src/lib/mock/contract.test.ts`, where it does not need a DOM at all.
`DemoDataBanner.test.tsx`
resets the module graph and stubs `VITE_API_TRANSPORT` per case, because
`usingMockApi` is evaluated once at import time. If interaction coverage becomes
necessary, add `jsdom` + `@testing-library/react` and a `test.environment` block
in `vite.config.ts` — the existing tests keep working either way.
