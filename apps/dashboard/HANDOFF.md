# Dashboard — handoff

> **Status, 2026-09-10.** Every section below this note is history: the notes
> of the sessions that built the dashboard against a mock while the control
> API was being written. They are kept for the reasoning. The current facts:
>
> - Every page reads the real control API. The last mock-only routes
>   (`/analytics`, `/usage`) are gone; `src/lib/mock/` mirrors the API for
>   `vitest` and for `VITE_API_TRANSPORT` unset, and its contract tests pin it
>   to the OpenAPI document.
> - Every control the dashboard offers is exercised against the running stack
>   by `e2e/` (Playwright): `pnpm test:e2e`, prerequisites in
>   `docs/LOCAL_SETUP.md` section 9. Twenty-eight steps from registration to
>   deleting the project, with the HMAC on each delivery verified at a local
>   receiver.
> - Things the e2e run found and fixed in the product, for the record: a
>   dialog's submit button bound to the wrong form when the same dialog was
>   mounted twice (`Dialog` now unmounts when closed and forms use `useId`);
>   the account menu opened below the fold; sign-out left the shell on screen;
>   deleting a project sent you back into it (cached list); the pause dialog
>   said queued deliveries wait when the data plane cancels them.

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
VITE_API_TRANSPORT=http pnpm --filter @hookubit/dashboard build
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

> **Superseded, and kept for the reasoning rather than the findings.** This
> section was written by reading `apps/control-api/src/**/dto/**` by hand. The
> control API now publishes `/docs-json` and the types are generated from it —
> see **"The types are generated now, and here is everything that was wrong"** at
> the end of this file, which corrects several claims below (there is one list
> envelope, not three; `SessionResponseDto` carries no organizations).

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

### Rate limits and ceilings are both refusals, and the API DOES tell them apart

*This section said the opposite until the routes were checked again. It was
accurate when written and is corrected here rather than deleted, because the
old behaviour is why the dashboard has a classifier at all.*

Every write route carries `@Throttle`. Separately, creates can fail on a
resource ceiling (organizations per user, projects per org, endpoints, API keys
and subscriptions per project).

**`limit_exceeded` exists.** It is in `ERROR_CODES` (`common/errors.ts:37`), it
is a 409 like `conflict`, and **every ceiling raises it with
`details: { limit, current, resource }`** — including the two this document
previously said "attach nothing but prose": endpoints
(`endpoints.service.ts` `requireHeadroom`, line ~407) and organizations
(`organizations.service.ts` `create`, line ~140). Both were verified by reading
the services.

So `src/lib/api-errors.ts` **no longer matches prose**, and the old rule 2 —
`/which is (its limit|the limit|the maximum)/` — is gone. Keeping it would now
do harm rather than good: a genuine `conflict` worded like a ceiling would be
classified as one, and the user told to delete something to fix a name
collision. `api-errors.test.ts` pins exactly that case.

    1. 429 / `rate_limited`   → throttled, transient, with `retry_after_seconds`
    2. `limit_exceeded`       → ceiling, with `{ limit, current, resource }`
    3. any other 409          → an ordinary conflict (duplicate slug, deleted row)
    4. 400 / `invalid_request`→ invalid, split into per-field issues (below)

The distinction matters because the remedies are opposites: a 429 clears itself
and the panel says how long, a ceiling never does and its copy must never say
"try again". `WriteErrorNotice` renders them differently and
`WriteErrorNotice.test.tsx` pins that they cannot converge.

### A 400 carries an ARRAY at `error.message`, and it is the only field map there is

`AppExceptionFilter` passes a non-`AppError` `HttpException` body straight
through (`common/errors.ts:82`), and the global `ValidationPipe` puts the array
of per-property messages there. So a validation failure arrives as:

```json
{ "error": { "code": "invalid_request",
             "message": ["url: loopback address", "timeout_ms: must not be less than 1000"] } }
```

Each entry is `"<property>: <reason>"`, produced by class-validator's
`defaultMessage`. **That array is the only place the API says which field it
refused.** Flattened into a sentence — which is what the dashboard used to do,
because `ApiError.message` was typed `string` — a form can do nothing but show a
paragraph next to the submit button.

`normaliseApiError` in `src/lib/api.ts` now runs on both transports and keeps
the array as `messages`; `classifyWriteError` splits it into
`{ field, reason }` issues; forms call `setError(field, …)` and focus the first.
`WriteErrorNotice` takes `claimedFields` and renders **nothing** when the form
placed every reason under its own input, so a rejection is never shown twice and
never silently dropped.

## Four routes that already existed and were only unwired

Checked against the controllers, not against this document:

| Route | Wired in |
| --- | --- |
| `PATCH /v1/projects/:projectId/endpoints/:endpointId` | `EndpointEditDialog` |
| `POST …/endpoints/:endpointId/enable` | `EndpointActions` |
| `POST …/endpoints/:endpointId/disable` | `EndpointActions` |
| `PATCH /v1/organizations/:orgId/projects/:projectId` | `ProjectSettingsPage` |
| `PATCH /v1/organizations/:orgId` | `OrganizationSettingsPage` |

### More route drift found while wiring them

Both of these would have 404'd the moment the transport flipped, and both are
fixed, in the hooks and in the mock:

- **`GET /v1/endpoints/:id` does not exist.** `EndpointsController` is mounted
  at `projects/:projectId/endpoints`, and the project id in the path is what
  `TenantResolver` reads the organization off — it is a lookup key, never an
  authorization claim. `useEndpoint` now takes a project id.
  `/v1/endpoints/:id/secrets` **is** top-level, because
  `EndpointSecretsController` is mounted separately. The asymmetry is real.
- **`GET /v1/projects/:id` does not exist** either; projects are nested under
  the organization for reads as well as for the list. `useProject` now takes an
  org id, and its three callers pass the one already in the URL.

### The breaker affordance says "Resume deliveries anyway"

`enabled` is operator intent, `status` is the breaker's verdict, and the pair is
the most easily misread thing in the product. The delivery page could already
say *"no retry will run — the circuit breaker has disabled this endpoint"*; that
is a diagnosis with no cure, and it sent the operator away to find the endpoint
by name in a paged table.

The rule, in `src/features/endpoints/breaker.ts` as pure data so it is testable
without a DOM:

- `enabled: true, status: 'disabled'` — the platform stopped it. Re-enabling
  changes nothing about the consumer whose failures opened the breaker, so the
  next run of failures opens it again, and the queued deliveries that resume in
  the meantime hit a still-broken consumer as a burst. The control is
  **"Resume deliveries anyway"** / **"Resume anyway"**: it offers the action and
  refuses to imply a repair. `breaker.test.ts` asserts the label never matches
  `/fix|restore|repair|re-?enable/`.
- Alongside it, **"Pause it instead"** — the honest option when the consumer is
  known broken. It converts a platform verdict into a recorded operator decision
  with a reason in the audit log, which is what makes the delivery gap
  explainable next week, and it stops the retry churn.
- `enabled: false` — a person paused it. Reversing your own decision reads as
  an ordinary action: **"Resume deliveries"**.

`POST …/enable` is refused with a 409 when the endpoint has no live signing
secret (the data plane fails closed rather than delivering unsigned). That
branch is reachable in the mock via `ep_01JQPENDING` and is surfaced, not
swallowed.

## Still needed from the control API

1. ~~A distinct error code for a resource ceiling.~~ **Done** — `limit_exceeded`.
2. ~~`details: { limit, current }` on every ceiling.~~ **Done**, on all four,
   plus `resource`, which is what lets the copy say *"delete one of your
   endpoints"* rather than *"delete something"*.
3. **`Retry-After` / `retry_after_seconds` reachable from the browser.** The
   guard sets both, but a cross-origin deploy needs `Retry-After` in
   `Access-Control-Expose-Headers`; the dashboard currently reads only
   `details.retry_after_seconds`.
4. **`POST /v1/auth/resend-verification`** — still open, unchanged from below.
5. **Publish `/docs-json`.** `src/types/api.ts` is a second source of truth and
   this whole document is the cost of it. `pnpm generate:api` deletes the
   problem.
6. **Whether `secret_pending` is derivable after creation.** Still open, and it
   is now the sharpest gap on this page rather than a cosmetic one. `EndpointDto`
   carries no signing-secret state, so the Endpoints table cannot distinguish
   "paused by an operator" from "paused because it has no secret" — and it is
   the second of those for which `POST …/enable` answers 409. The dashboard
   therefore offers "Resume deliveries" on an endpoint that cannot be resumed,
   and only learns better from the conflict. A `has_live_secret` boolean on
   `EndpointDto` (or the active-secret count) would let the button be disabled
   with the real reason instead.
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

---

# First-run experience, the product tour, and what the backend owed them

> **Delivered, both sides.** `users.onboarding_completed_at` exists, the API
> exposes it on the session and accepts `POST /v1/auth/onboarding-completed`
> (idempotent by conditional UPDATE, user id from the session only), and the
> dashboard now decides from the server value first with `localStorage` as the
> fallback for the window between the click and the response. The ask below is
> kept as the record of why the field has the shape it has.

This pass added a guided setup path, an orientation tour, a real Analytics
page, and a rewritten delivery-detail screen. Everything below is either a
decision worth not re-litigating or a concrete ask on the control API.

## The single most important backend ask: `onboarding_completed_at` (delivered)

**The product tour's "has this person seen it?" flag is in `localStorage`, and
that is a stand-in, not the design.**

`src/features/onboarding/tour-storage.ts` writes `hookubit.tour.v1` with a value
of `completed` or `skipped`. Every access is wrapped in try/catch, because
`localStorage` does not merely return empty in a private window or with site
data blocked — **the accessor itself throws**, and an unguarded read there would
take down the whole app shell. A throw and a cleared store both read as "never
seen", which is the safe direction: the tour is skippable and re-openable, so
showing it once more costs a keystroke, while wrongly suppressing it leaves a
new user with no orientation at all.

What it costs today:

- The same person gets the tour again on a second device or browser.
- Clearing site data replays it.
- Support cannot see whether a user was ever onboarded.

**What is wanted on the control API**, on the user record, exposed on
`GET /v1/auth/session` inside `user`:

```jsonc
{
  "user": {
    "id": "usr_…",
    // ISO-8601 when the user finished OR skipped the tour; null if neither.
    "onboarding_completed_at": "2026-09-08T14:20:00.000Z"
  }
}
```

plus a write route:

```
POST /v1/auth/onboarding-completed   →  204, idempotent
```

One nullable timestamp, not a boolean and not a JSON blob of per-step progress.
A boolean cannot answer "when", which is what you want when someone asks why a
cohort churned; per-step progress is state the tour would then have to
reconcile against the server mid-session for no benefit. Skipping and finishing
deliberately collapse to the same field — the product question is "has this
person been oriented", and someone who skipped has decided they have.

Until that exists, `readTourRecord()` is the only reader and
`writeTourRecord()` the only writer, so the swap is those two functions plus a
mutation. Nothing else in the app touches the key.

## Why the tour is non-modal, and why it has no focus trap

`src/features/onboarding/ProductTour.tsx` is `role="dialog"` **without**
`aria-modal`, with no backdrop and no focus trap. That is deliberate on both
UX and accessibility grounds, and it should not be "fixed" into a normal modal:

- A tour that dims the page and swallows clicks teaches a new user that the
  product gets in the way. The app behind it stays fully interactive, so someone
  reading the fan-out step can click into Deliveries and look at a real one.
- **Trapping focus in a non-modal dialog is precisely the keyboard trap WCAG
  2.1.2 forbids.** Focus still moves in on open and returns to the invoking
  control on close, which is the part users actually need; it is simply not
  fenced in between.
- Step changes are announced through a `role="status" aria-atomic` region rather
  than by moving focus, so a screen-reader user hears the new step without being
  yanked out of wherever they were reading.
- It is mounted in `AppLayout`, not on a route, so it survives navigation.
- `Skip tour` is a labelled control in the header on **every** step, and Escape
  closes from anywhere. Both record `skipped`.

The tour and the setup checklist are **different things and must stay that
way**: the tour answers "what is this product", is static prose, and ends by
handing off to the checklist; the checklist answers "what do I do next" and is
derived entirely from live queries. Someone who skips the tour still lands on
the checklist and can finish unaided.

## Setup state is derived, never stored

`useSetupState()` in `src/features/onboarding/api.ts` composes the queries the
product already runs — organizations, project, API keys, endpoints,
subscriptions, events — and feeds `deriveSetupSteps()` in `setup.ts`.

**Please do not add `GET /v1/projects/:id/setup-state`.** It would be a second
source of truth for "does this project have a live endpoint" and would drift
from the list that answers the same question one click away. The cost is five
parallel requests on the overview, all cached under the keys those screens
already use, so navigating onward is served from cache.

The rule the derivation exists to enforce, and the one a naive checklist gets
wrong: **a resource can exist and still not deliver.** An endpoint created by a
developer comes back paused with no signing secret; a subscription can be
disabled. Those are `attention` (amber), never `done` (green) — ticking them
green is how someone spends an afternoon wondering why nothing arrives.
`setup.test.ts` pins that they cannot converge.

## The `curl` needs the INGEST base URL, which is not this app's origin

The get-started page renders a ready-to-run publish request with the operator's
real project id. Ingest is a **separate service** from the control API this
dashboard talks to — Go on `:8080` versus NestJS on `:3000` (docs/API.md) — so
it is not behind the dev proxy and it is not `window.location.origin`.

`ingestBaseUrl()` reads `VITE_INGEST_BASE_URL` and falls back to
`http://localhost:8080`. **The deployment side needs to pass that build arg**,
alongside the `VITE_API_TRANSPORT=http` ask already recorded above. A wrong base
URL produces connection-refused, which is annoying but honest; deriving it from
the dashboard's origin would produce a request that 404s against the *control*
API, which looks like it reached something and is far more confusing.

## The mock now accepts writes, and they persist

`PATCH`, `enable` and `disable` mutate the fixtures in place — they have to, or
a query invalidated after a mutation would refetch the old row and the change
would look lost. That makes `src/lib/mock/data.ts` shared mutable state across a
test file, so `resetMockState()` (which also clears the throttle counters)
rewinds every write and is called from `beforeEach` in every mock suite.

The write-side validation lives in `src/lib/mock/writes.ts` and mirrors
`endpoint-url.ts`, `endpoint-headers.ts` and `endpoint-limits.ts` in the same
words. `writes.test.ts` covers the failures the UI has to render, not just the
200s: an SSRF-shaped URL (loopback, private, metadata, a bad scheme, embedded
credentials), a reserved `Webhook-*` header, `status` refused by
`forbidNonWhitelisted`, the numeric bounds, a 409 on a soft-deleted endpoint, a
409 on enabling an endpoint with no signing secret, a slug collision, and a 429
with `retry_after_seconds`.

## Mock changes that bring it closer to the real contract

Two changes to `src/lib/mock/`, both of which make the mock **more** faithful:

1. **Project scoping.** `GET /v1/projects/:id/{endpoints,api-keys,subscriptions,
   events,deliveries,analytics}` previously ignored `:id` entirely and returned
   the same rows for every project. That is not what a tenant-scoped API does,
   and it made the first-run experience impossible to see — a brand-new project
   appeared to already have 64 events. They now filter on `project_id`, and
   `analyticsFor()` returns zeroes for a project with no traffic rather than
   borrowing the busy project's numbers. `proj_01JQPAYSTG` is now genuinely
   empty and is the fixture to open when working on onboarding.
2. **`NOW` is anchored at module load** instead of being hard-coded to
   2026-09-06. The fixed date made fixtures reproducible across days but meant
   every relative timestamp drifted further into the past — the delivery detail
   page rendered a *scheduled future retry* as "2 days ago", which is exactly
   the fact that screen exists to state correctly. Anchoring at import keeps the
   property that mattered (stable for the life of a page) and the seeded RNG is
   untouched, so which endpoint is broken and which chains are exhausted is
   still identical every run.

## Still needed from the control API (additions to the list above)

7. **`onboarding_completed_at`** on the user, plus
   `POST /v1/auth/onboarding-completed`. Detailed above. Highest value of these.
8. **`VITE_INGEST_BASE_URL`** passed as a build arg by the deployments side.
9. ~~Endpoint enable/pause/disable routes.~~ **They already existed** —
   `POST …/enable` and `POST …/disable`, plus `PATCH` for everything else — and
   are now wired. See the breaker section above for what the control says and
   why.
10. ~~`PATCH /v1/projects/:id` and `PATCH /v1/organizations/:id`.~~ **They
    already existed too** (nested under the organization), and both settings
    pages are now real forms. What each DTO refuses — `environment`, `status` —
    is rendered as a fact with the reason rather than as a disabled input, since
    a greyed-out dropdown reads as "ask an admin" when the truth is "create a
    second project".
11. **A retry-policy picker.** `EndpointEditDialog` accepts `retry_policy_id` as
    free text with the caveat spelled out, because `RetryPoliciesController` is
    mounted (`projects/:projectId/retry-policies`) but has no dashboard hook and
    no mock fixtures. Wiring that list turns the field into a select; until then
    an id from another project answers 404 through the tenant scope.
12. **An audit-log surface for these writes.** `POST …/disable` writes the
    operator's reason to the audit log, which is what makes a delivery gap
    explainable later — and `AuditPage` is still served only by the mock, so the
    reason cannot actually be read back yet.
13. **A billing surface, or a decision not to have one.** `BillingPage` is the
    only genuinely empty screen left. There is no route, no shape, not even a
    mock, so it renders an honest empty state pointing at Usage rather than a
    fabricated invoice table.
14. **Analytics, events, deliveries and subscriptions modules.** `AnalyticsPage`
    is now built against the mock's `GET /v1/projects/:id/analytics`, since a
    working shape existed and a dead route was the worse option. It is still
    SPECULATIVE and the page says so on itself. When the real module lands,
    expect an offset envelope rather than the cursor page the mock returns, and
    these screens will need the same treatment the other five got.

---

# The types are generated now, and here is everything that was wrong

`src/types/api.d.ts` is written by `pnpm --filter @hookubit/dashboard
generate:api` from the control API's live `/docs-json` — 42 paths, 68 schemas.
`src/types/api.ts` no longer states a single field name or field type by hand:
every domain type is `components['schemas'][…]`, so a rename on the wire is now
a compile error rather than an `undefined` on a page.

**Regenerate it whenever the control API changes.** It is checked in so a fresh
clone type-checks without a running API; it is not a source file.

## What survives by hand in `src/types/api.ts`, and why

Two groups, each of them something the document **cannot** carry. The other two
groups are gone: the error envelope is a declared schema now, and there are no
nullability repairs left at all.

1. **`OffsetPage<T>`** — a generic. The document declares thirteen concrete
   `*ListDto` schemas; a type parameterised over its row type is not expressible
   in OpenAPI. Its fields match the generated envelopes exactly
   (`{ data, has_more, next_offset: number | null }`).
2. **Client-side mirrors of server limits** — `ENDPOINT_LIMITS`, the slug rules,
   `RESERVED_HEADER_NAMES`, `MAX_PAGE_SIZE`. openapi-typescript does not emit
   `minLength`/`maximum`/`pattern` into the type at all, so these cannot be
   derived. A form uses them to refuse a value before spending a round trip; the
   server stays the authority, and a stale one costs a 400 rather than
   corruption.

Plus the mock-only view models at the foot of the file (`ProjectAnalytics`,
`UsageSummary`) — two screens the control API has no module for. Not drift: no
route, no schema.

`CountedOffsetPage`, `TotalPage` and `CursorPage` are **deleted**, along with
`totalPage()` in `src/lib/pagination.ts` and `Paged.total`.

## The drift the generated types exposed

Every item below was believed correct, was type-checked, and was wrong. Each one
would have broken the moment `VITE_API_TRANSPORT=http` was set.

### Routes that do not exist

The dashboard called five paths the control API does not serve. All five were
already the *correct-looking* shape, which is exactly why nothing caught them.

| Called | Actually |
| --- | --- |
| `GET /v1/events/:id` | `GET /v1/projects/:projectId/events/:eventId` |
| `GET /v1/events/:id/deliveries` | `…/projects/:projectId/events/:eventId/deliveries` |
| `POST /v1/events/:id/replay` | `…/projects/:projectId/events/:eventId/replay` |
| `GET /v1/deliveries/:id` | `GET /v1/projects/:projectId/deliveries/:deliveryId` |
| `GET /v1/deliveries/:id/attempts` | `…/projects/:projectId/deliveries/:deliveryId/attempts` |
| `POST /v1/deliveries/:id/replay` | `…/projects/:projectId/deliveries/:deliveryId/replay` |

`EventsController` and `DeliveriesController` are mounted under the project. The
project id in the path is what `TenantResolver` reads the organization off — a
lookup key, never an authorization claim. (`/v1/endpoints/:id/secrets` **is**
top-level; that asymmetry is real and unchanged.)

### The session does not carry organizations

`SessionResponseDto` is **`{ user }` and nothing else.** The hand-written
`Session` had `organizations: Organization[]`, and **two places read
`session.organizations[0]`** to decide where to land the user after login:
`LoginPage` and `RootRedirect`. Both would have thrown on the first real
response — on the first screen after signing in.

Both now read `GET /v1/organizations`. Login navigates to `/orgs` and lets
`RootRedirect` forward, which costs one request on a transition the user is
already waiting through.

`AuthUserDto` also disagreed: **`email_verified` is a boolean**, not
`email_verified_at: string | null`, and there is **no `created_at`** on it.

### There is ONE list envelope, not three

Every `*ListDto` in the document is `{ data, has_more, next_offset }`.

- **`count` is gone** from `ProjectListDto` and `ApiKeyListDto`.
- **`{ total, limit, offset }` is gone** from `OrganizationListDto` and
  `MemberListDto` — they use the same offset envelope as everything else.

The organizations and members pagers were reading `total` to render "1–3 of 7".
That property does not exist, so the range would have read **"1–3 of undefined"**
and `totalPage()` would have derived `hasMore` from `offset + rows < undefined`
— always `false`, so **the pager would have reported every truncated list as
complete.** That is precisely the failure the envelope was introduced to close.

`pageRange()` no longer shows a total for anything, because nothing carries one.

`next_cursor` **does not exist anywhere.** Events, deliveries and audit logs are
offset paged like the rest.

### `DeliveryDto` — four invented fields, one of them load-bearing

`event_type`, `endpoint_name`, `endpoint_url` and **`last_status_code`** are not
on a delivery row. The row carries ids; the identifying detail is on
`DeliveryDetailDto` as nested `event` and `endpoint` objects, and **the status
code only ever existed on an attempt, as `http_status`.**

`last_status_code` was read by `describeDelivery`, `diagnoseDelivery` and the
delivery detail page's "Last response" tile — the three things the operator
surface exists for. They now take an explicit `DeliveryOutcome`, built by
`deliveryOutcome(delivery, attempts)`: the code comes from the highest-numbered
attempt where there is one, and is `null` where there is not. A list row has no
attempts, so it degrades to "no HTTP response", which `classifyFailure` already
treats as a transport failure — the honest reading, not a fabricated code.

Names are joined client-side from the endpoint list the page already loads, with
the id as the fallback. New on the wire and now used: `is_replay`,
`replay_of_delivery_id`, `replayed_by`, `subscription_id`, `last_attempt_at`.

### `DeliveryAttemptDto` — every field name was different

`status_code` → **`http_status`**; `error` → **`error_message`** (plus a separate
`error_code`); `attempted_at` → **`started_at`**; `response_truncated` → gone, in
favour of `response_size` and `response_body_location`. `duration_ms` is
**nullable** — an attempt in flight has not got one, and `formatDuration(null)`
would have rendered "NaNms". New and now used: the attempt's own `status`
(`success | failure | timeout | error`) and per-attempt `request_headers`.

### The delivery detail page had no payload and no request headers

`DeliveryDetailDto` carries **neither**. The page rendered
`delivery.request_headers` and `delivery.payload`; both were the mock's
invention. The request headers are per **attempt** (the signature is recomputed
each time, so that is the more accurate place anyway) and the payload is on the
**event** — one copy, however many deliveries. The Request tab now shows the
latest attempt's headers and links to the event for the body.

`attempts` is **embedded** in the detail response, with `attempts_truncated`
saying whether it is complete. The page reads the flag and only then fetches the
paged route. The mock caps the embedded array at 5 so the flag is reachable.

### `EventDto` — no `delivery_counts`, and a renamed size

`payload_size_bytes` → **`payload_size`**. **`delivery_counts` does not exist**;
the "3 ok / 1 exhausted" fan-out column on the events list was invented, and
there is no route returning per-event counts in a list. Deriving it would mean
one request per visible row — fifty requests to paint one page — so **the column
is gone** and the list shows the idempotency key instead. The detail page keeps
the roll-up, derived from the delivery rows via `summarizeDeliveries()`, which
is better anyway: a denormalised counter can disagree with the table printed
directly beneath it and a derived one cannot.

**`EventDetailDto.payload` is an envelope, not the body.** `EventPayloadDto` says
where the bytes came from (`inline | object_storage | unavailable`), carries a
`notice`, and may have no body at all. Reading it as the body would render an
offloaded payload as an empty code block. New: `payload_hash`, `payload_inline`,
`payload_location`, `processed_at`, `headers`.

### Filters the dashboard sent that do not exist

**Neither events nor deliveries accepts `search`.** Both pages had a free-text
box wired to `?search=`, which `forbidNonWhitelisted` refuses. What exists:

- Events: `event_type` (exact), `status`, `created_after`/`created_before`, and
  **`idempotency_key`** — a case-insensitive substring, 3-character minimum.
  That last one is what the box was really being used for.
- Deliveries: `status`, **`failing_now`**, `endpoint_id`, `event_id`,
  `event_type`, the date range, and **`origin`**.

The events page also had a **hard-coded list of five payment event types** in its
dropdown. No route enumerates the types a project has seen, so a project
publishing `shipment.dispatched` could not filter for it at all. It is a text
input now.

`failing_now` and `status` **cannot be combined** — the API refuses the pair
rather than picking one — so the status select is disabled while it is on, and
the mock refuses the combination too.

### `SubscriptionDto`

No `endpoint_name` (joined client-side). `filter` → **`payload_filter`**. `name`
is **nullable**. New `updated_at`. The list was read as a bare `{ data }` array
and is offset paged, so it was **silently truncating at the page size**.

### `AuditLogDto` — the actor is not an object

There is **no nested `actor: { id, email, type }`** and **no `target` string**;
the page rendered both. The actor is `user_id` **or** `api_key_id`, either of
which may be null (a platform action has neither — the circuit breaker
auto-disabling an endpoint is exactly that case). The target is `resource_type`
plus a nullable `resource_id`. `ip` → **`ip_address`**. New: `user_agent`.

## The two repairs are gone. What closed them

The dashboard carried **21 `Patch<>` types** re-declaring fields the document
described wrongly. All 21 are deleted; **none survived**. Both causes were fixed
at the source rather than worked around.

**1. Nullable properties had no type — fixed on the control API.** It wrote
`@ApiProperty({ nullable: true })` with no `type`, so the emitted schema was
`{ nullable: true }` and openapi-typescript rendered it, correctly, as
`Record<string, never> | null`: `rate_limit` was a type no number could be
assigned to and `expires_at` one no string could. The root cause is worth
recording — there is **no @nestjs/swagger CLI plugin**, so the schema comes from
TypeScript's `design:type` reflection, and reflection emits `Object` for *any*
union. `x!: string | null` was therefore indistinguishable from a free-form
object. Every nullable property now states its type explicitly and required-ness
is correct per field: **101 properties across 34 schemas.** The regenerated
document contains **zero** `Record<string, never>` properties.

**2. `default` implies required — fixed with a generator flag.** `generate:api`
now passes **`--default-non-nullable false`**. `CreateEndpointDto`'s `required`
array is `["name","url"]`, exactly right, but `timeout_ms`, `max_concurrency`
and `rate_limit_window_seconds` each carry a `default`, and openapi-typescript's
`defaultNonNullable` (on by default) renders any property with a default as
required — which would make the create dialog send three numbers the operator
never chose, overriding the server defaults that exist so it does not have to.
The flag's blast radius is 26 fields, **all of them in `Create*` / `Update*` /
`RotateSecretDto` request bodies and none in a response DTO**, so it is strictly
more correct rather than a loosening.

`offsetPage()` still type-guards `next_offset`, but for a different reason now:
all thirteen envelopes type it `number | null`, so the guard is no longer
repairing a type, it is repairing a **response** — an older deployment or a
proxy that rewrote the body would otherwise put `[object Object]` into a URL.

## What was wired

**Retry-policy picker.** `useRetryPolicies` reads
`GET /v1/projects/:projectId/retry-policies`. `EndpointEditDialog`'s free-text
`retry_policy_id` box is a `<select>` whose options say what the policy *does*
("8 attempts, exponential ×2 from 1s up to 60m") rather than showing an id. The
old box invited the obvious thing — paste the id from the project that already
retries the way you want — which answers **404**, because the id is resolved
through the tenant scope. Three states: the list, an **honest empty state** that
names `POST /v1/projects/:id/retry-policies` because there is no screen for
creating one either, and a **saved id not on the current page kept as an explicit
option** so saving cannot silently unset a policy nobody touched.

**Audit log.** `useAuditLogs` reads `GET /v1/organizations/:orgId/audit-logs`
with the real filters and offset paging. This matters because
`POST …/endpoints/:id/disable` writes the operator's reason here, and **until now
that reason could not be read back at all** — the whole point of asking for it
was unreachable. A `viewer` (who holds `members.read`, **not** `audit.read`) gets
`PermissionDenied` naming their actual role from `OrganizationDto.role`, not a
red "request failed" with a retry button that will fail identically forever.
`retry: false` is what makes that state appear promptly. Reachable in the mock
via `?as=viewer`.

## Honest gaps — screens with no backend at all

Not "a module whose shape drifted": **no route in the document**.

- **`GET /v1/projects/:projectId/analytics`** — no analytics module.
- **`GET /v1/organizations/:orgId/usage`** — no usage or billing module.

Both pages are finished and work against the mock. Under the real transport they
render `NoBackendRoute`, which names the missing route and what it would have to
return, and **does not run the query**. A 404 shown as an error reads as an
outage and invites a retry; fabricated overage figures shown to an operator are
worse than either.

## Still needed from the control API

Ordered by what costs most today.

1. **An `actor_email` (or a nested actor) on `AuditLogDto`.** The audit page's
   entire job is "who paused this endpoint and why", and it can currently answer
   *why* but only show a `usr_…` id for *who*. Every alternative — a member
   lookup per row, a client-side join against a paged member list — is worse
   than the API returning the string it already has.
2. **`last_status_code` on `DeliveryDto`.** The deliveries list can say "gave up
   after 8 attempts" but not "HTTP 504", because the code is only on an attempt.
   One denormalised column would put the cause back in the list, which is where
   an operator scanning for a pattern needs it.
3. **`delivery_counts` on `EventDto`.** Restores the fan-out column on the events
   list. Without it, "which of my events failed to reach somebody" needs one
   click per event.
4. **`POST /v1/auth/resend-verification`** and **`onboarding_completed_at`** —
   both unchanged from the sections above, both still open.

### Closed since the last handoff

- **The error envelope is in the document.** `ApiErrorResponse` is declared and
  attached to all 150 error responses, with an 11-value `code` enum, `message`
  as `string | string[]` and typed `details`. `ApiErrorBody` / `ApiErrorCode` /
  `ApiErrorDetails` are aliases of it now, not hand-written mirrors, and
  `ApiError.code` is a **closed union**: `ErrorState`'s title map is
  `Record<ApiErrorCode, string>`, so a code added on the server is a build
  failure here rather than a silent "Request failed".
- **`has_live_secret` is on `EndpointDto`.** The document served on :3000 now
  carries it, so the Endpoints table can tell "paused by an operator" from
  "paused because it has no secret".

  The general point outlived the field and is worth keeping: **`generate:api` is
  only as fresh as the process serving `/docs-json`.** A stale server silently
  produces stale types — the same failure mode as hand-writing them, just
  faster.
