# HookuBit dashboard

React + Vite single-page app for the HookuBit control plane. It talks to
`@hookubit/control-api` through `src/lib/api.ts`, which is the only place in the
app that performs a request.

```
pnpm dev                 # Vite on :5173, /v1 proxied to localhost:3000
pnpm build               # tsc -b && vite build  ->  dist/  (needs VITE_API_TRANSPORT)
pnpm preview             # serves dist/ on :4173
pnpm test                # vitest
pnpm test:e2e            # Playwright, against a running stack
pnpm lint
```

No command here needs an API URL. The dashboard fetches **relative paths** —
`/v1/projects`, never `https://…/v1/projects` — so every one of them resolves
against whatever hostname served the page. `pnpm dev` makes that work with
Vite's proxy (`vite.config.ts`); in production nginx makes it work with a
`location /v1` proxy block on the same hostname.

## How it is deployed

**It is not deployed separately.** The Deployer recipe builds it on the server
as part of a release and nginx serves the output:

```
VITE_API_TRANSPORT=http pnpm --filter @hookubit/dashboard build   # on the box
```

That variable is **not optional**: the build refuses without it. See
"`VITE_API_TRANSPORT` must be set explicitly" below.

nginx then serves `<release>/apps/dashboard/dist/` as the document root for the
dashboard hostname, with two rules it must have:

| nginx must | Why |
| --- | --- |
| fall back to `index.html` for any unmatched path (`try_files $uri /index.html`) | `/orgs/:orgId/projects/:projectId/...` exists only in React Router; without the fallback a refresh or a pasted link is a 404 |
| proxy `/v1/*` to the control API on this same hostname | the only reason relative paths are correct — see above |

Nothing **deploys** the dashboard and there is no `wrangler`: no workflow
uploads it anywhere, and nothing ships it on push. It ships when a release
ships. CI does *build* it — `pnpm -r build` in the `control-plane` job, and the
container image from `deployments/docker/dashboard.Dockerfile` — so the
transport guard below applies to CI too. The nginx server block and the Cloudflare settings in front of it
live with the deployment config (`deployments/`), not here.

Cloudflare is still in front of the hostname as a **proxy** — TLS, caching,
DDoS — but it does not host anything. The dashboard and the API are one origin
on one box.

### Why there is no `VITE_API_BASE_URL`

There used to be one, for a dashboard hosted on Cloudflare at a different
hostname than the API. With one origin it has no correct value other than
"unset", and a build variable whose only correct value is unset is a variable
that can only be set *wrong*: point it at the right host and it is redundant,
point it anywhere else and every screen breaks. So it is gone, along with
`src/lib/api-base-url.ts` and the configuration panel that reported it missing.

`src/lib/api.ts` calls `fetch(path, …)` with the path as given. Relative is not
a default or a fallback here — it is correct by construction, on this hostname
and on any future one, with nothing to configure and nothing to keep in sync.

`credentials: 'include'` stays on every request. Same-origin it is redundant
(the default `'same-origin'` already sends the session cookie), and it is kept
because it states the intent and costs nothing.

## Build environment variables

Two. Both are **plain text, not secrets**, and Vite compiles them into the
bundle at build time — changing either one requires a new build, so a running
release cannot be reconfigured.

| Variable | Value | Wrong value does this |
| --- | --- | --- |
| `VITE_API_TRANSPORT` | `http` | **ships the in-memory mock** |
| `VITE_INGEST_BASE_URL` | `https://hooks.hookubit.com` | the Get-started `curl` cannot work |

### `VITE_API_TRANSPORT` must be set explicitly

This is the one build variable that can ruin a deploy. `src/lib/api.ts` selects
its transport with `=== 'http'`, so anything else — unset, blank, `HTTP`,
`https`, a typo — selects the in-memory mock in `src/lib/mock/`, and the bundle
then renders a complete, convincing product against data that does not exist:
projects you did not create, deliveries that never happened, writes that appear
to succeed and are gone on reload.

**`vite build` now refuses rather than shipping that by accident.** The guard
is an `apply: 'build'` plugin in `vite.config.ts`, and it distinguishes a
*forgotten* variable from a *chosen* one:

| Value | `vite build` |
| --- | --- |
| unset, empty, whitespace | **fails**, naming the variable and the consequence |
| `http` | builds silently — the normal path |
| `mock` | builds, with a boxed DEMO BUILD warning at the start and again at the end |
| anything else (`HTTP`, `htp`, `" http "`) | **fails**, naming the two valid values |

Comparison is exact on purpose: `HTTP` would not match the bundle's own
`=== 'http'`, so accepting it here would be the same trap in a different hat.
A deliberate demo or screenshot build stays possible — you just have to say
`mock` out loud, which is the whole point.

`pnpm dev` and `vitest` are **unaffected**: unset is the correct setting there,
and `apply: 'build'` keeps the plugin out of both. The decision table is pinned
by `vite-config-guard.test.ts`.

Two things still matter once a build is out:

- `src/components/DemoDataBanner.tsx` puts a permanent, undismissable red
  banner at the top of every page — including the auth pages, which render
  outside the app shell — reading *"Demo data — not connected to an API"*. With
  the guard in place a deployed dashboard showing it was built `=mock`
  deliberately, but it is still the first thing to check for any "the data
  looks wrong" report, including on bundles built before the guard existed.
- Grepping the bundle is **not** a check. The banner's code ships either way,
  and so do parts of the mock's fixture data even with `http` set — the mock
  modules have import-time side effects, so Rollup cannot drop all of them
  (the bundle is ~61 kB smaller with `http` set, not mock-free). The honest
  check is to load the page and look for the banner.

### `VITE_INGEST_BASE_URL` is compiled in and unchangeable after the build

It is the base URL in the `curl` the Get-started page hands an operator to
publish their first event (`src/features/onboarding/publish-request.ts`).
Ingest is the Go data plane — a different service from the control API, on
`hooks.hookubit.com`, which is why it is a variable at all while the control
API's own base is not. Unset, it falls back to `http://localhost:8080`, so a
production build without it hands every operator a snippet that cannot work.

## The request deadline — 15.75 s

`src/lib/api.ts` gives every control-API call an `AbortSignal.timeout()`.
`fetch` has none of its own, so without it an API that accepts the connection
and then goes quiet leaves the request open for as long as the browser allows —
minutes — and the operator watches a spinner that never resolves.

The number is arithmetic over the API's own ceilings, not a round guess:
10,000 ms Prisma pool acquisition + 5,000 ms interactive transaction + 750 ms
for the hops either side. Past that the API is not going to answer.

Two failures, deliberately told apart, because they send you to different
places:

| On screen | What it means | Where to look |
| --- | --- | --- |
| **The API did not answer in time** | the connection was accepted; nothing came back within 15.8 s | the API's logs, and whether its Postgres connection pool is exhausted |
| **Could not reach the API** | no response at all | nginx on this box, the control API unit, the `location /v1` proxy block, or the browser's own network |

**`CORS_ORIGINS` is not on that list, and must not be put back on it.** It was,
when the dashboard was served from a different origin than the API. One origin
means the browser runs no CORS check on these requests at all — no preflight,
no `Access-Control-Allow-Origin` to get wrong — so that variable cannot produce
this failure, and naming it would send an operator to spend an outage editing
something uninvolved. `src/lib/api.test.ts` asserts the message does not
mention it.

A timeout is a **408**, so React Query does not retry it: three attempts would
hold the spinner for ~50 s and then show the same sentence. An unreachable host
is a **503** and is retried, because it fails in milliseconds — which also
rides out the few seconds of refused connections that restarting the API unit
during a release produces. "Try again" is always offered for a human who wants
to spend the time deliberately.

**The caveat, which the on-screen copy repeats:** aborting is a client-side
act. It closes a socket; it does not roll anything back. A write the API had
already begun can commit after the user has been told it failed.

`src/lib/api.test.ts` covers what a stubbed `fetch` can cover honestly — which
error the caller is handed, and whether it is retried. It cannot prove the
deadline *fires*, because `AbortSignal.timeout` schedules on a timer the suite
does not own. That is verified by pointing the transport at a server that
accepts the connection and never answers; the last run aborted after 15,759 ms
with `kind: 'timeout'`, status 408, `retryable: false`.

## No sourcemap in a production build

`vite.config.ts` sets `build.sourcemap: false`. `dist/` is now served by nginx
straight off the release, so every file `vite build` writes there is a public
URL on the dashboard hostname — and `index-<hash>.js.map` is ~2.9 MB containing
the complete frontend source: every comment, every internal name, every route
the UI knows about.

Not emitting it is the fix that does not depend on a second file staying
correct. An nginx `location ~ \.map$ { return 404; }` works right up until
someone rewrites the server block, and a leak there is silent — nothing in the
app or the build would notice. Keeping the rule as well is cheap and worth it,
but as defence in depth, not as the mechanism.

This affects `vite build` only. `vite dev` serves its own sourcemaps through
the transform pipeline, so day-to-day debugging is unchanged. To debug a
production bundle locally, ask for the map on the command line for that one
build rather than editing the config:

```
pnpm build --sourcemap     # writes dist/assets/index-<hash>.js.map for this build only
```

A clean `pnpm build` produces 12 files in `dist/` and no `.map` among them;
`find dist -name '*.map'` coming back empty is the check.

`public/.assetsignore` is gone with the rest of the Cloudflare setup. It was a
wrangler mechanism — wrangler read it from the root of the assets directory and
left the matches out of the upload — and it means nothing to nginx, which
serves whatever is on disk. The file it was hiding no longer exists.

## Caching

Do not let `index.html` be cached for long. Vite fingerprints every asset
(`assets/index-<hash>.js`), so a stale `index.html` asks for filenames the new
release no longer has, and the page fails to boot until that viewer's cache
expires — for that viewer only, which makes it hard to reproduce.

The hashed assets under `/assets/` are the opposite case: their names change
whenever their contents do, so they can be cached immutably and for a long
time.

Both are enforced in the deployment config, not here — the nginx server block
and any Cloudflare Cache Rule over the same hostname (`deployments/`). The
dashboard's side of the contract is just the fingerprinting, which Vite does by
default. After a release, `curl -I` the hostname and confirm `index.html` comes
back with an `ETag` and a short or zero `max-age`, and that a hashed asset does
not.
