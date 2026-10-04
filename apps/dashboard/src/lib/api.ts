/**
 * The single data seam.
 *
 * Everything above this file — hooks, features, pages — calls `api.get/post/…`
 * with a path from docs/API.md and never knows which transport served it.
 * Today that is the in-memory mock, because @hookubit/control-api is being
 * built in parallel; tomorrow it is `fetch`.
 *
 * TO SWAP IN THE REAL CLIENT: set `VITE_API_TRANSPORT=http` (or flip the
 * default in `resolveTransport` below) and delete `src/lib/mock/`. Nothing
 * else in the app changes. Request and response types — the error envelope
 * included — come from the generated OpenAPI document (ARCHITECTURE.md 7);
 * `src/types/api.ts` only gives them domain names.
 */
import { mockRequest, MockHttpError } from './mock/server';
import { isApiErrorCode } from '../types/api';
import type { ApiErrorCode, ApiErrorDetails, ApiErrorPayload } from '../types/api';

export interface ApiError {
  /**
   * A CLOSED union, not `string`.
   *
   * It used to be `ApiErrorCode | string`, which collapses to `string` and made
   * every consumer's code check a comparison against a free-form value: a typo
   * compiled, and a code the API had added but the UI did not handle fell
   * through to a generic "Request failed" at runtime. Now the document declares
   * the enum, `normaliseApiError` narrows to it, and an unhandled code is a
   * compile error in `ErrorState`'s title map.
   */
  code: ApiErrorCode;
  message: string;
  /**
   * Every message the server sent, in order.
   *
   * A 400 from the global `ValidationPipe` carries an ARRAY at `error.message`
   * — one entry per rejected property, each reading `"<property>: <reason>"`.
   * That array is the only place the API says WHICH field it refused, and
   * joining it into one sentence throws that away: a form then has to show a
   * paragraph next to the submit button instead of an error under the input
   * that caused it. `message` stays a string so every existing caller keeps
   * working; `messages` is the structured original.
   */
  messages?: string[];
  /**
   * Structured context, as the document declares it: `retry_after_seconds` from
   * the throttle guard, `{ limit, current, resource }` from a resource ceiling
   * — the facts that let the UI tell "slow down" apart from "you have hit a
   * limit". Those four are typed; the schema stays open, so anything else is
   * `unknown`. See `src/lib/api-errors.ts`.
   */
  details?: ApiErrorDetails;
  request_id?: string;
}

/**
 * An error envelope as it arrives, before normalisation — `message` may still
 * be the ValidationPipe's array. `ApiError` is the form every caller sees.
 *
 * `request_id` is optional HERE ONLY, and that is not a disagreement with the
 * document, which requires it. This type also covers the envelope the client
 * SYNTHESISES when a response body could not be parsed at all — a proxy's HTML
 * 502 — where there is no id to quote because the API never answered.
 */
export type RawApiError = Omit<ApiErrorPayload, 'request_id'> &
  Partial<Pick<ApiErrorPayload, 'request_id'>>;

/**
 * One shape out, whatever the server sent in.
 *
 * Both transports run this, so no caller can accidentally depend on a
 * `message` that is sometimes an array — which would render as
 * `"url: loopback address,name: too long"` in a UI that assumed a sentence.
 */
export function normaliseApiError(raw: unknown): ApiError {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    request_id?: unknown;
  };

  const messages = Array.isArray(source.message)
    ? source.message.filter((entry): entry is string => typeof entry === 'string')
    : typeof source.message === 'string'
      ? [source.message]
      : [];

  return {
    // An unrecognised code becomes `internal_error`. Codes are additive on the
    // server, so a client one version behind WILL meet one it does not know;
    // folding it into the catch-all is honest, and `API_ERROR_CODES` makes
    // adding the real handling a compile error rather than a memory.
    code: isApiErrorCode(source.code) ? source.code : 'internal_error',
    message: messages.join(' ') || 'An unexpected error occurred.',
    messages,
    details:
      typeof source.details === 'object' && source.details !== null
        ? (source.details as ApiErrorDetails)
        : undefined,
    request_id: typeof source.request_id === 'string' ? source.request_id : undefined,
  };
}

export class ApiRequestError extends Error {
  readonly body: ApiError;

  constructor(
    readonly status: number,
    body: RawApiError,
  ) {
    const normalised = normaliseApiError(body);
    super(normalised.message);
    this.body = normalised;
    this.name = 'ApiRequestError';
  }

  /** Retrying a 4xx (other than 429) just burns the user's time. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

type Transport = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * THE DEADLINE EVERY CONTROL-API REQUEST GETS, in milliseconds.
 *
 * `fetch` has no timeout of its own. Without this, an API that accepts the TCP
 * connection and then goes quiet — an exhausted connection pool, a query that
 * never returns, a box that is swapping — leaves the request open until the
 * browser or the OS eventually gives up, which can be minutes. The user sees a
 * spinner that never resolves, and a spinner that never resolves is worse than
 * an error: there is nothing to read, nothing to retry, and nothing to report.
 *
 * The number is arithmetic over the API's own ceilings, not a round guess:
 *
 *     10_000   Prisma's `pool_timeout` default — the longest a handler can sit
 *              waiting for a connection out of the pool before Prisma itself
 *              gives up and raises.
 *      5_000   Prisma's interactive-transaction `timeout` default — the longest
 *              a handler can then HOLD that connection. No control-API request
 *              path overrides it (`endpoint-auto-disable.service.ts` passes
 *              `{ timeout: 60_000 }`, but that is a background sweep, not a
 *              route).
 *        750   one allowance for the hops either side of the API.
 *    -------
 *     15_750   past this point the API is not going to answer, so waiting
 *              longer only lengthens the spinner.
 *
 * THE HOP TERM, 750 ms, covers browser→(Cloudflare, proxying the one
 * hostname)→nginx→API — the client's own leg over a possibly-mobile network
 * included. 750 ms is thin for that leg on a cold connection, and it is kept
 * anyway, because of WHEN the extra leg can matter: it only costs us accuracy
 * in the case where the API spends its full 15 s and then answers, and a
 * handler that has exhausted both Prisma ceilings answers with a 500, not with
 * data. So widening the term would buy a better error MESSAGE in a case that is
 * already an error, at the price of every real timeout holding the spinner
 * longer. The term is a margin, not a measurement; if operators report timeouts
 * on paths the API logs as having succeeded, raise it — that is the signal, not
 * a latency percentile.
 *
 * NOT AN UPPER BOUND ON THE API. `TenantTransactionRunner.run` retries a
 * SERIALIZABLE transaction up to `MAX_TRANSACTION_ATTEMPTS` (4) times, so a
 * pathological write could exceed this in total. That is the caveat below, and
 * aborting is still the right call: the human gets a sentence and a button
 * instead of an indefinite wait.
 */
export const API_REQUEST_TIMEOUT_MS = 10_000 + 5_000 + 750;

/** `15.8 s`, for a sentence. Derived, so it cannot drift from the constant. */
const TIMEOUT_FOR_HUMANS = `${(API_REQUEST_TIMEOUT_MS / 1000).toFixed(1)} s`;

/**
 * Which of the two ways a request can fail WITHOUT the API ever answering.
 *
 * They have to be told apart, because they send an operator to different
 * places: "your API is slow" is a look at the API's logs and its connection
 * pool, "your API is unreachable" is nginx, the API unit, or the `/v1` proxy
 * block in between. One message covering both helps with neither.
 */
export type TransportFailureKind = 'timeout' | 'unreachable';

/**
 * A failure where there was no HTTP response at all.
 *
 * A SUBCLASS of `ApiRequestError` on purpose. Every consumer in the app —
 * `ErrorState`, `classifyWriteError`, React Query's `retry` predicate — already
 * branches on `ApiRequestError`, and a transport failure that arrived as a bare
 * `DOMException` or `TypeError` fell through all of them to "An unexpected
 * error occurred." Being one of them means the synthesised envelope flows
 * everywhere the real ones do; `kind` is the extra fact, for the one component
 * that wants a better headline than the code can give.
 *
 * `code` is `internal_error` because `ApiErrorCode` is a CLOSED union generated
 * from the control API's own enum (`src/types/api.ts`) and the API has no code
 * for "I never spoke to you" — it cannot have one. Inventing a twelfth value
 * client-side would make the union a lie and break the exhaustiveness checks
 * that are the reason it is closed.
 */
export class ApiTransportError extends ApiRequestError {
  constructor(
    readonly kind: TransportFailureKind,
    status: number,
    message: string,
  ) {
    super(status, { code: 'internal_error', message });
    this.name = 'ApiTransportError';
  }
}

/**
 * 408 for a timeout, 503 for an unreachable host — and the difference is
 * entirely about `ApiRequestError.retryable`, which React Query's `retry`
 * predicate in `main.tsx` keys off (`status >= 500 || status === 429`).
 *
 * A TIMEOUT MUST NOT BE RETRYABLE. The deadline exists to bound the wait; with
 * `failureCount < 2` and backoff, a retryable timeout would hold the spinner
 * for 15.75 + 1 + 15.75 + 2 + 15.75 ≈ 50 s and then show the same error. That
 * is the bug this file is fixing, three times over. 408 Request Timeout is both
 * semantically exact ("the client gave up waiting") and a 4xx, so it is not
 * retried — while `ErrorState` still offers "Try again" for a human who wants
 * to spend the time deliberately.
 *
 * AN UNREACHABLE HOST SHOULD BE. It fails in milliseconds, so two retries cost
 * ~3 s of backoff and genuinely recover a dropped connection on a phone. A dead
 * API unit is retried pointlessly, but just as cheaply — and the retries are
 * what ride out the few seconds of 502 that a release's API restart produces.
 */
const TIMEOUT_STATUS = 408;
const UNREACHABLE_STATUS = 503;

function timeoutMessage(): string {
  return (
    `The control API accepted the request but did not answer within ${TIMEOUT_FOR_HUMANS}, ` +
    `so the dashboard stopped waiting. It is reachable, so this is the API or its database ` +
    `being slow rather than a connection problem — check the API's logs and whether its ` +
    `database connection pool is exhausted. The request may still be running on the server.`
  );
}

/**
 * WHY CORS IS NOT IN THIS SENTENCE ANY MORE.
 *
 * The dashboard's assets and the control API are served from ONE origin: nginx
 * serves the built bundle out of the release and proxies `/v1` to the API on
 * the same hostname. `path` is therefore a same-origin request, and the browser
 * applies no CORS check to one — there is no preflight, no
 * `Access-Control-Allow-Origin` to get wrong, and `CORS_ORIGINS` on the API is
 * not consulted. Naming it here would send an operator to edit an environment
 * variable that cannot produce this failure, which is worse than saying
 * nothing: it is a plausible wrong answer, and they will find it in the docs
 * and believe it.
 *
 * What CAN produce it, all on the one box, in the order worth checking:
 *  - nginx is not running, or not listening on this hostname — then the page
 *    itself would not have loaded, so this is the case where it loaded a while
 *    ago and nginx has since died;
 *  - the control API unit is down or restarting, so nginx's proxy_pass gets a
 *    refused connection and answers 502 — which arrives here as an HTTP status,
 *    not as this error, UNLESS the body is not JSON and the response never
 *    completes;
 *  - the `location /v1` proxy block is missing or points at the wrong port,
 *    so `/v1/...` falls through to the SPA fallback and returns `index.html`;
 *  - the network between the browser and the box dropped — a phone changing
 *    cells, a laptop sleeping, a tunnel closing.
 *
 * The first three are one `systemctl status` and one `nginx -T` away, which is
 * why they are named and CORS is not.
 */
function unreachableMessage(path: string): string {
  return (
    `The browser could not reach the control API at ${path}, on this page's own origin. ` +
    `fetch() does not report a reason for this, by design, so it is one of: nginx is no ` +
    `longer answering on this hostname, the control API unit is down or restarting, the ` +
    `/v1 proxy block is misconfigured, or the browser lost its network connection. The ` +
    `dashboard and the API share one origin, so this is not a CORS problem — check ` +
    `nginx and the API unit on the box serving this page.`
  );
}

/**
 * `AbortSignal.timeout()` aborts with a `TimeoutError`, NOT an `AbortError`.
 *
 * Worth stating because the obvious guess is wrong and the consequence is
 * silent: a check for `AbortError` alone compiles, passes a mocked test, and
 * then classifies every real timeout as something else. `AbortError` is still
 * accepted here, for an engine that predates the distinction and for any future
 * caller-supplied signal.
 *
 * Matched on `name` rather than `instanceof DOMException`, because the
 * constructor is not the same object across the browser, jsdom and Node.
 */
function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function httpTransport<T>(method: string, path: string, body?: unknown): Promise<T> {
  /*
   * A BARE RELATIVE PATH, with nothing configurable in front of it.
   *
   * The dashboard is served from the same origin as the API — nginx serves
   * `dist/` off the release and proxies `/v1` to the control API on the same
   * hostname; `vite.config.ts` does the same job with its dev proxy. So
   * `/v1/projects` resolves against the hostname that served this page, which
   * is correct by construction in both. A configured API base URL used to be
   * prepended here, for a cross-origin dashboard on Cloudflare; with one origin
   * that variable had no right answer other than empty, and a build variable
   * whose only correct value is "unset" is a variable that can only be set
   * wrong.
   */
  try {
    const response = await fetch(path, {
      method,
      /*
       * Sessions are HTTP-only cookies; no token is kept in localStorage
       * (ARCHITECTURE.md 9). `'include'` is redundant same-origin — the
       * default `'same-origin'` already sends the cookie — and it is kept
       * because it is correct either way and states the intent: this request
       * carries credentials. It grants nothing extra; the server, not the
       * caller, decides whether a cross-origin request may read a response.
       */
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      /*
       * The deadline covers the WHOLE exchange, not just the headers. The
       * signal stays attached to the response body, so an API that sends 200
       * and then stalls mid-payload aborts here too — which is why the body
       * reads below are inside this `try` rather than after it.
       *
       * THE HONEST CAVEAT: aborting is a client-side act. It closes the socket;
       * it does not roll anything back. A write the API had already begun can
       * commit after we have told the user it failed. The dashboard cannot fix
       * that from here — only an idempotency key on the write, or a re-read
       * before the user retries, can — so the messages say "may still be
       * running" rather than "nothing was saved".
       */
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new ApiRequestError(
        response.status,
        normaliseApiError(
          payload?.error ?? { code: 'internal_error', message: response.statusText },
        ),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    // The API answered and we classified it already; re-wrapping would lose the
    // status, the code and the `request_id`.
    if (error instanceof ApiRequestError) throw error;
    if (isTimeoutAbort(error)) {
      throw new ApiTransportError('timeout', TIMEOUT_STATUS, timeoutMessage());
    }
    /*
     * A `TypeError` is how `fetch` reports "no response", for every reason at
     * once: a refused or reset connection, a dropped network, a response the
     * browser abandoned. Same-origin, a CORS rejection is not among them —
     * see `unreachableMessage` for why that matters to the copy.
     *
     * Anything else is not a transport failure — a `SyntaxError` from
     * `response.json()` on a body that is not JSON is the one that happens, and
     * calling that "could not reach the API" would send an operator to look at
     * DNS for a 200 that arrived. It propagates raw, as it did before.
     */
    if (error instanceof TypeError) {
      throw new ApiTransportError('unreachable', UNREACHABLE_STATUS, unreachableMessage(path));
    }
    throw error;
  }
}

async function mockTransport<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await mockRequest<T>(method, path, body);
  } catch (error) {
    // Normalise to the same error type the HTTP transport throws, so no caller
    // can accidentally depend on mock-specific failure shapes.
    if (error instanceof MockHttpError) {
      throw new ApiRequestError(error.status, normaliseApiError(error.body.error));
    }
    throw error;
  }
}

function resolveTransport(): Transport {
  return import.meta.env.VITE_API_TRANSPORT === 'http' ? httpTransport : mockTransport;
}

const transport = resolveTransport();

/** True while the mock is serving requests; the shell shows a banner for it. */
export const usingMockApi = import.meta.env.VITE_API_TRANSPORT !== 'http';

export const api = {
  get: <T>(path: string) => transport<T>('GET', path),
  post: <T>(path: string, body?: unknown) => transport<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => transport<T>('PATCH', path, body),
  delete: <T>(path: string) => transport<T>('DELETE', path),
};

/** Builds `?a=1&b=2`, dropping empty values so filter state stays tidy. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised ? `?${serialised}` : '';
}
