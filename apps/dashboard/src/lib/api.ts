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
 * else in the app changes. Request and response types come from the generated
 * OpenAPI client at that point (ARCHITECTURE.md 7); `src/types/api.ts` is the
 * temporary hand-written stand-in and goes with it.
 */
import { mockRequest, MockHttpError } from './mock/server';
import type { ApiErrorCode } from '../types/api';

export interface ApiError {
  code: ApiErrorCode | string;
  message: string;
  /**
   * Structured context the error envelope carries. This is where the throttle
   * guard puts `retry_after_seconds` and where a resource ceiling puts
   * `limit`/`current` — the two facts that let the UI tell "slow down" apart
   * from "you have hit a limit". See `src/lib/api-errors.ts`.
   */
  details?: Record<string, unknown>;
  request_id?: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
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
    const payload = (await response.json().catch(() => null)) as { error?: ApiError } | null;
    throw new ApiRequestError(
      response.status,
      payload?.error ?? { code: 'internal_error', message: response.statusText },
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
      throw new ApiRequestError(error.status, error.body.error);
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
