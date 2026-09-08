/**
 * The single data seam.
 *
 * Everything above this file — hooks, features, pages — calls `api.get/post/…`
 * with a path from docs/API.md and never knows which transport served it.
 * Today that is the in-memory mock, because @webhook/control-api is being
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

async function httpTransport<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // Sessions are HTTP-only cookies; no token is kept in localStorage
    // (ARCHITECTURE.md 9).
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiRequestError(
      response.status,
      normaliseApiError(payload?.error ?? { code: 'internal_error', message: response.statusText }),
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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
