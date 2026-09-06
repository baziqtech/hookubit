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

## Testing

There is no jsdom or Testing Library in this workspace, and adding one was out
of scope for these fixes. Component tests render through
`react-dom/server`'s `renderToStaticMarkup` and assert on the markup, which
covers presence/absence and copy but not interaction. `DemoDataBanner.test.tsx`
resets the module graph and stubs `VITE_API_TRANSPORT` per case, because
`usingMockApi` is evaluated once at import time. If interaction coverage becomes
necessary, add `jsdom` + `@testing-library/react` and a `test.environment` block
in `vite.config.ts` — the existing tests keep working either way.
