/**
 * Where the control API lives, from the point of view of the built bundle.
 *
 * The dashboard and the control API are different hostnames under one
 * registrable domain — `hookubit.com` serves this app, `api.hookubit.com` the
 * API. That makes every call cross-ORIGIN but same-SITE, which is why the
 * session cookie (`httpOnly; sameSite=lax`, host-only) is still sent: a `Lax`
 * cookie is withheld from cross-SITE requests, not from same-site ones. The
 * only thing the dashboard needed in order to stop proxying through its own
 * origin was a base URL to prepend, and that is this file.
 *
 * Two things the API side must hold up, or none of this works:
 *  - the dashboard's origin is listed in the API's `CORS_ORIGINS`, which is
 *    configured with `credentials: true` and fails closed when unset;
 *  - the API keeps issuing the cookie without a `Domain` — host-only is fine,
 *    because the browser decides whether to SEND a `Lax` cookie from the site
 *    relationship, not from the cookie's host.
 *
 * WHY THIS IS VALIDATED AND NOT JUST READ
 * `VITE_API_TRANSPORT` is the cautionary tale: get it wrong and the dashboard
 * boots happily against an in-memory mock, so the mistake looks like a working
 * product. A base URL has the same shape of risk — an empty value in a
 * production bundle means `fetch('/v1/projects')` against the Cloudflare
 * hostname, which, with `not_found_handling: "single-page-application"`,
 * answers `index.html` with a 200. The dashboard would then fail on
 * `JSON.parse` of an HTML page, screen by screen, with nothing naming the
 * cause. So the value is checked once, at module load, and a build that cannot
 * possibly work refuses to boot with a message that names the variable —
 * rendered on the page by `ApiConfigErrorPanel`, not only logged. See
 * `resolveApiConfig` at the foot of this file for why the throw is caught.
 */

/** The variable's name, in one place, so error text and docs cannot drift. */
export const API_BASE_URL_VAR = 'VITE_API_BASE_URL';

/**
 * Normalises and validates a configured base URL.
 *
 * Pure, and takes `production` rather than reading `import.meta.env`, so the
 * rules are testable without stubbing the build mode.
 *
 * @param raw        the configured value, as Vite hands it over
 * @param production true for a `vite build` bundle; false for `vite dev`/tests
 * @returns          an origin (plus optional path prefix) with no trailing
 *                   slash, or `''` meaning "fetch relative paths"
 * @throws           if the value is missing in a production build, or present
 *                   and unusable in any build
 */
export function resolveApiBaseUrl(raw: string | undefined, production: boolean): string {
  const value = (raw ?? '').trim();

  if (value === '') {
    // Development and tests: `vite.config.ts` proxies `/v1` to
    // localhost:3000, so a relative path is not a fallback, it is the correct
    // answer — it keeps the dev server same-origin and CORS out of the loop.
    if (!production) return '';

    throw new Error(
      `${API_BASE_URL_VAR} is not set. A production build of the dashboard has no dev ` +
        `proxy, so a relative API path resolves to the hostname serving index.html and ` +
        `returns the SPA shell with a 200 instead of JSON. Set ${API_BASE_URL_VAR} to the ` +
        `control API's origin, e.g. https://api.hookubit.com.`,
    );
  }

  let url: URL;
  try {
    // Absolute on purpose. A bare host ("api.hookubit.com") or a path
    // ("/api") would both parse as something under the dashboard's own
    // origin once prepended, which is the failure this file exists to stop.
    url = new URL(value);
  } catch {
    throw new Error(
      `${API_BASE_URL_VAR} must be an absolute URL including the scheme, e.g. ` +
        `https://api.hookubit.com — got ${JSON.stringify(value)}.`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `${API_BASE_URL_VAR} must use http or https — got ${JSON.stringify(url.protocol)}.`,
    );
  }

  if (url.search !== '' || url.hash !== '') {
    // Appending `/v1/projects` after `?x=1` produces a path inside the query
    // string, which the API would never route.
    throw new Error(
      `${API_BASE_URL_VAR} must not carry a query string or fragment — got ` +
        `${JSON.stringify(value)}.`,
    );
  }

  // `new URL('https://api.hookubit.com')` already normalises the pathname to
  // '/', and a configured trailing slash lands here too. Strip them all: every
  // path this file is asked to join starts with its own '/'.
  const normalised = `${url.origin}${url.pathname}`.replace(/\/+$/, '');

  if (/\/v1$/.test(normalised)) {
    // The likeliest operator mistake, because `https://api.hookubit.com/v1` is
    // what the API docs show as a base. Every call site passes a `/v1/...`
    // path, so accepting this would request `/v1/v1/projects` and 404 on
    // every screen. Rejecting is better than silently stripping: silent
    // stripping would also "fix" a genuinely `/v1`-mounted prefix someone
    // meant.
    throw new Error(
      `${API_BASE_URL_VAR} must not include the /v1 prefix — the dashboard adds it to every ` +
        `path. Use ${JSON.stringify(normalised.replace(/\/v1$/, '') || url.origin)} instead of ` +
        `${JSON.stringify(value)}.`,
    );
  }

  return normalised;
}

/**
 * Joins a validated base to an API path.
 *
 * Separate and pure so the absolute-base case can be tested without a build.
 * The leading slash is enforced rather than assumed: with an empty base a
 * missing one is harmless, but with `https://api.hookubit.com` it would
 * concatenate into `https://api.hookubit.comv1/projects`.
 */
export function joinApiUrl(base: string, path: string): string {
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** A usable base, or the reason there isn't one. Never both. */
export type ApiConfig = { base: string; error: null } | { base: ''; error: string };

/**
 * `resolveApiBaseUrl`, with the throw turned into a value.
 *
 * WHY THE THROW IS CAUGHT NOW, having been the whole design before. It still
 * throws — `resolveApiBaseUrl` above is untouched, and a build with no
 * `VITE_API_BASE_URL` still refuses to produce a base. What changed is who
 * hears about it. Throwing during module evaluation meant the entry chunk died
 * mid-import, which leaves the `<div id="root">` empty: a WHITE PAGE, with the
 * explanation in the console. The person who meets that failure is an operator
 * who has just typed build variables into Cloudflare, not a developer with
 * devtools open — so the only copy that names the cause was in the one place
 * they will not look.
 *
 * Catching it here lets `main.tsx` put the same sentence ON THE PAGE and still
 * refuse to mount the app. Same refusal, same unconditional rule, visible.
 *
 * Pure, and takes its inputs, so the production branch is testable without a
 * build — `import.meta.env.PROD` cannot be stubbed to a real boolean.
 */
export function resolveApiConfig(raw: string | undefined, production: boolean): ApiConfig {
  try {
    return { base: resolveApiBaseUrl(raw, production), error: null };
  } catch (error) {
    return { base: '', error: error instanceof Error ? error.message : String(error) };
  }
}

const config = resolveApiConfig(import.meta.env.VITE_API_BASE_URL, import.meta.env.PROD);

/**
 * The resolved base for this bundle. `''` in development, where Vite's proxy
 * handles `/v1`.
 */
export const API_BASE_URL = config.base;

/**
 * Why this bundle cannot talk to an API, or `null` when it can.
 *
 * `main.tsx` reads this BEFORE mounting anything and renders
 * `ApiConfigErrorPanel` instead of the app when it is set. It is a message
 * meant to be displayed: it names the variable and an example value and
 * nothing else — never a configured value read back, because the hostname
 * serving this page is public and so is anything printed on it.
 */
export const apiConfigError = config.error;

/**
 * Absolute (or relative, in development) URL for an API path.
 *
 * Throws when the base could not be resolved. Belt and braces — `main.tsx`
 * never mounts the app in that state, so nothing should reach this — but the
 * alternative is silently requesting a RELATIVE `/v1/projects` from the
 * Cloudflare hostname, which `not_found_handling: "single-page-application"`
 * answers with the SPA shell and a 200. That is precisely the lie this module
 * exists to prevent, and it must not become reachable just because the throw
 * above moved into a `catch`.
 */
export function apiUrl(path: string): string {
  if (config.error !== null) throw new Error(config.error);
  return joinApiUrl(config.base, path);
}
