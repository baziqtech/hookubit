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
import { apiUrl } from './api-base-url';
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
 * THE HOP TERM IS UNCHANGED AT 750 ms, and the path it covers did change: the
 * deleted Worker measured Worker→nginx→API, where this measures
 * browser→(Cloudflare, where the API hostname is proxied)→nginx→API, which adds
 * the client's own leg over a possibly-mobile network. 750 ms is thin for that
 * leg on a cold connection. It is kept anyway, because of WHEN the extra leg
 * can matter: it only costs us accuracy in the case where the API spends its
 * full 15 s and then answers, and a handler that has exhausted both Prisma
 * ceilings answers with a 500, not with data. So widening the term would buy a
 * better error MESSAGE in a case that is already an error, at the price of
 * every real timeout holding the spinner longer. The term is a margin, not a
 * measurement; if operators report timeouts on paths the API logs as having
 * succeeded, raise it — that is the signal, not a latency percentile.
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
 * pool, "your API is unreachable" is DNS, TLS, a dead process or CORS. One
 * message covering both is one message that helps with neither.
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
 * ~3 s of backoff and genuinely recover a dropped connection on a phone. A CORS
 * misconfiguration is retried pointlessly, but just as cheaply.
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

function unreachableMessage(url: string): string {
  // `location` is absent under vitest (no DOM environment), so the sentence has
  // to work without naming this page's origin.
  const origin = typeof location === 'undefined' ? 'this page’s origin' : location.origin;
  return (
    `The browser could not reach the control API at ${url}. fetch() does not report a reason ` +
    `for this, by design, so it is one of: the API is down, its hostname does not resolve, ` +
    `TLS failed, or the browser blocked the response because the API's CORS_ORIGINS does not ` +
    `list ${origin}. A CORS rejection is indistinguishable from an outage from here — the ` +
    `browser console names which one it was, and this message cannot.`
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
  // `apiUrl` prepends the control API's origin (`VITE_API_BASE_URL`). It is
  // empty in development, where Vite proxies `/v1` and the path stays
  // relative; in a production build it is a different hostname under the same
  // registrable domain, which is why `credentials: 'include'` below is enough
  // to carry the `SameSite=Lax` session cookie. See ./api-base-url.ts.
  const url = apiUrl(path);

  try {
    const response = await fetch(url, {
      method,
      // Sessions are HTTP-only cookies; no token is kept in localStorage
      // (ARCHITECTURE.md 9).
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
     * once: DNS, a refused connection, a TLS failure, and a CORS rejection,
     * which is deliberately opaque so a page cannot probe another origin.
     *
     * Anything else is not a transport failure — a `SyntaxError` from
     * `response.json()` on a body that is not JSON is the one that happens, and
     * calling that "could not reach the API" would send an operator to look at
     * DNS for a 200 that arrived. It propagates raw, as it did before.
     */
    if (error instanceof TypeError) {
      throw new ApiTransportError('unreachable', UNREACHABLE_STATUS, unreachableMessage(url));
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
