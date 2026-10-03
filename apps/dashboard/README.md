# HookuBit dashboard

React + Vite single-page app for the HookuBit control plane. It talks to
`@hookubit/control-api` through `src/lib/api.ts`, which is the only place in the
app that performs a request.

```
pnpm dev                 # Vite on :5173, /v1 proxied to localhost:3000
pnpm build               # tsc -b && vite build  ->  dist/
pnpm preview             # serves dist/ — needs VITE_API_BASE_URL, see below
pnpm test                # vitest
pnpm test:e2e            # Playwright, against a running stack
pnpm lint
```

**`pnpm preview` and `pnpm preview:cf` both need `VITE_API_BASE_URL` set**, and
`preview:cf` needs it at *build* time because it builds first:

```
VITE_API_BASE_URL=http://localhost:3000 pnpm build && pnpm preview
VITE_API_BASE_URL=http://localhost:3000 pnpm preview:cf
```

`pnpm dev` does not — it is not a production build, and Vite proxies `/v1`.
This is the cost of making the requirement unconditional (it does not depend on
`VITE_API_TRANSPORT`), and the cost is paid deliberately: an operator who sets
*neither* variable would otherwise land on the in-memory mock and never meet
the base-URL error at all. Preview without it and you get the configuration
panel described below, which is exactly the behaviour being previewed.

## Deploying to Cloudflare

The dashboard ships as **static assets only** — no Worker, no proxy.
`wrangler.jsonc` declares `dist/` as the asset directory and
`not_found_handling: "single-page-application"` so React Router's client-side
paths return `index.html` instead of a 404.

Everything else is hostnames:

| Hostname | What it serves |
| --- | --- |
| `hookubit.com` | this dashboard, on Cloudflare |
| `api.hookubit.com` | the control API, on the bare-metal box |
| `hooks.hookubit.com` | the data plane's ingest |

Calls from the dashboard to the API are cross-**origin** but same-**site** —
both hostnames sit under the registrable domain `hookubit.com`. The session
cookie is `httpOnly; sameSite=lax` with no `Domain`, and a `Lax` cookie is
withheld only from *cross-site* requests, so it is sent on these. That is why
there is no reverse proxy: the browser's rule is about the site relationship,
not about one hostname serving both. `src/lib/api.ts` sets
`credentials: 'include'`, which is what makes the browser attach it at all on a
cross-origin request.

### Build settings to enter in the Cloudflare dashboard

Workers & Pages → the `hookubit-dashboard` Worker → Settings → Build:

| Setting | Value |
| --- | --- |
| Root directory | `/` (the repository root) |
| Build command | `pnpm --filter @hookubit/dashboard build` |
| Deploy command | `pnpm --filter @hookubit/dashboard exec wrangler deploy` |
| Output / assets directory | `apps/dashboard/dist` — already declared as `assets.directory` in `wrangler.jsonc`, so there is nothing to type here |

The root directory is the repository root, not `apps/dashboard`, because this is
a pnpm **workspace**: the lockfile Cloudflare installs from is
`/pnpm-lock.yaml`, and an install started inside a workspace member is not the
same operation. `pnpm --filter … exec` then runs *in* `apps/dashboard`, so
wrangler discovers `wrangler.jsonc` beside itself and needs no `-c`, and
`assets.directory` resolves relative to that file.

`wrangler` is a pinned `devDependency` (`4.138.0`), so the deploy runs the
binary the lockfile installed rather than whatever `pnpm dlx wrangler@4`
resolves to that morning. **The pin and `/pnpm-lock.yaml` must agree**: pnpm 9
defaults to `--frozen-lockfile` when `CI=true`, so a `package.json` that names
a version the lockfile does not know fails Cloudflare's install outright,
before any build output exists to debug.

Cloudflare is connected to this repository directly and **builds on push**;
there is no GitHub Actions workflow for the dashboard.

### Build environment variables

Three, all under Build → Variables and secrets, as **plain text** — none is a
secret. Vite compiles them into the bundle at build time, so changing any of
them requires a new build and a new deploy.

| Variable | Value | Wrong value does this |
| --- | --- | --- |
| `VITE_API_TRANSPORT` | `http` | ships the in-memory mock |
| `VITE_API_BASE_URL` | `https://api.hookubit.com` | the build refuses to boot, or every call 404s |
| `VITE_INGEST_BASE_URL` | `https://hooks.hookubit.com` | the Get-started `curl` cannot work |

**`VITE_API_TRANSPORT` must be exactly `http`.** Anything else — unset, blank,
`HTTP`, `https`, a typo — ships the in-memory mock in `src/lib/mock/`, and the
dashboard then renders a complete, convincing product against data that does
not exist: projects you did not create, deliveries that never happened, writes
that appear to succeed and are gone on reload. `src/components/DemoDataBanner`
puts a permanent banner on the page in that state, which is the signal to check
this variable first.

**`VITE_API_BASE_URL` is the control API's origin** — scheme and host, nothing
more. It is prepended to every path `src/lib/api.ts` requests. The two ways to
get it wrong are both rejected rather than tolerated
(`src/lib/api-base-url.ts`, validated once at module load):

- **Unset in a production build → the app does not boot, and the page says so.**
  This is deliberate. Without the check, a relative `/v1/projects` would be
  requested from the Cloudflare hostname, and
  `not_found_handling: "single-page-application"` answers *any* unmatched path
  with `index.html` and a **200** — confirmed against `wrangler dev`, where
  `GET /v1/projects` returns the 1.3 kB HTML shell with a 200, not a 404. Every
  screen would then fail parsing HTML as JSON, and nothing would say why. A
  refusal naming the cause beats a dashboard that looks alive and lies; that is
  the `VITE_API_TRANSPORT` lesson applied. What you get instead of the
  dashboard is a panel (`src/components/ApiConfigErrorPanel.tsx`) naming the
  variable, where to set it, and an example value — because the person who
  meets this failure has just typed build variables into Cloudflare and is not
  holding devtools open. It renders with no providers, no router and no data
  layer, since those are what might be broken.
- **Including `/v1`, or a trailing slash.** A trailing slash is normalised away
  silently. `https://api.hookubit.com/v1` is *rejected* at boot with a message
  quoting the value to use instead, because the dashboard adds `/v1` itself and
  accepting it would request `/v1/v1/...` — a 404 on every screen that looks
  like a broken API rather than a broken setting. A bare host with no scheme, a
  non-http scheme, and a query string or fragment are rejected for the same
  reason: each would otherwise resolve against the dashboard's own origin or
  swallow the path.

Unset is the *correct* value in development: `vite.config.ts` proxies `/v1` to
`localhost:3000`, so `pnpm dev` stays same-origin and needs no CORS. The
variable only becomes mandatory in a `vite build` bundle, where there is no
proxy.

**`VITE_INGEST_BASE_URL` is compiled in and unchangeable after the build.** It
is the base URL in the `curl` the Get-started page hands an operator to publish
their first event (`src/features/onboarding/publish-request.ts`). Ingest is the
Go data plane — a different service from the control API, on
`hooks.hookubit.com`. Unset, it falls back to `http://localhost:8080`, so a
production build without it hands every operator a snippet that cannot work.

### The API must allow this origin — `CORS_ORIGINS`

Because the calls are cross-origin, the control API must list this dashboard's
origin (`https://hookubit.com`, scheme and host, no path, no trailing slash) in
its **`CORS_ORIGINS`** environment variable. The API's CORS layer
(`apps/control-api/src/config/cors.ts`) runs with `credentials: true`, which is
what permits a cookie to be sent at all, and browsers refuse
`credentials: 'include'` against a wildcard — so the origin has to be named
explicitly.

`CORS_ORIGINS` **fails closed when unset**: no origin is allowed, so the
symptom is not "some things work" but *nothing* works. Every request is blocked
at the preflight, the session cookie is never sent, and login itself fails. In
the browser it reads as a CORS error in the console and a generic network
failure in the UI — check `CORS_ORIGINS` on the API box before suspecting the
dashboard.

### The request deadline — 15.75 s

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
| **Could not reach the API** | no response at all | the API is down, DNS, TLS — **or `CORS_ORIGINS`**, which looks identical from JavaScript |

`fetch` reports a CORS rejection as a bare `TypeError` with no detail, by
design, so the dashboard genuinely cannot tell it from an outage. The browser
console does name it. On a first deploy, `CORS_ORIGINS` is the likeliest of the
four — see the section above.

A timeout is a **408**, so React Query does not retry it: three attempts would
hold the spinner for ~50 s and then show the same sentence. An unreachable host
is a **503** and is retried, because it fails in milliseconds and a dropped
connection often recovers. "Try again" is always offered for a human who wants
to spend the time deliberately.

**The caveat, which the on-screen copy repeats:** aborting is a client-side
act. It closes a socket; it does not roll anything back. A write the API had
already begun can commit after the user has been told it failed.

### Caching

Do not let `index.html` be cached for long. Vite fingerprints every asset
(`assets/index-<hash>.js`), so a stale `index.html` asks for filenames that the
new deploy no longer has, and the page fails to boot until the cache expires —
for that viewer only, which makes it hard to reproduce. Cloudflare's
static-asset serving sends an `ETag` and revalidates `index.html` rather than
giving it a long browser `max-age` — worth confirming with `curl -I` against the
hostname after the first deploy, and worth preserving if you ever add a Cache
Rule over it.

### The sourcemap is built but not published

`vite.config.ts` sets `build.sourcemap: true`, so `dist/assets/index-<hash>.js.map`
exists — 2.9 MB of it — and that is deliberate: it is wanted on disk for local
debugging and for the bundle checks the deploy recipe runs. Under the assets
binding, though, every file in `dist/` is served publicly from the dashboard
hostname, and that map contains the complete frontend source: every comment,
every internal name, every route the UI knows about.

`public/.assetsignore` (one pattern, `*.map`) is what keeps it off Cloudflare.
wrangler reads `.assetsignore` from the root of `assets.directory` and applies
the patterns with gitignore semantics, excluding the matches from the asset
manifest — so they are never uploaded — and excluding the file itself as well.
It lives in `public/` rather than `dist/` because `vite build` empties `dist/`
on every build and copies `public/` into it verbatim, dotfiles included; this
is also what wrangler's own framework autoconfig does for Astro and SvelteKit.

Verify it by *requesting* the map, not by reading the dry-run's file count.
`wrangler deploy --dry-run` prints "Read N files from the assets directory",
and that N is a pre-filter walk of `dist/` — it is unchanged by
`.assetsignore`, and it counts the `assets/` directory itself, so it reads one
higher than the number of files on disk (15 for the 14 files `pnpm build`
produces). The honest check is `pnpm preview:cf`, then
`curl -i /assets/index-<hash>.js.map`: a 200 of `text/html`, 1.3 kB, is the SPA
shell, which means the map is not in the manifest. The hashed `.js` beside it
must still come back as `text/javascript` at its full size. `/.assetsignore`
itself falls through to the shell the same way.

Do not "simplify" this by turning sourcemaps off, and do not add a pattern that
matches a hashed `.js` or `.css` — an asset the HTML references but the deploy
did not upload is a blank page.

### Local use and verification

```
pnpm preview:cf   # pnpm build, then `wrangler dev` serving dist/ as assets
pnpm cf:check     # `wrangler deploy --dry-run`: the config parses, the manifest is built
pnpm deploy       # manual deploy; normally Cloudflare does this on push
```

Both run the pinned local `wrangler` (4.138.0, in `devDependencies`), not a
`pnpm dlx` download. `pnpm dev` (Vite) is what you want for day-to-day work: it
proxies `/v1` to `localhost:3000`, so no base URL and no CORS configuration are
involved.

A `pnpm preview:cf` build needs `VITE_API_BASE_URL` set, like any production
build — `VITE_API_BASE_URL=http://localhost:3000 pnpm preview:cf`, with that
origin listed in the API's `CORS_ORIGINS`. Point it at nothing and the page is
blank with the reason in the console, which is the behaviour being verified.
