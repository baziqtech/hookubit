import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The HTTP transport's failure classification.
 *
 * `resolveTransport` reads `VITE_API_TRANSPORT` once at module load, so every
 * case has to set it and then import the graph fresh — the same
 * reset-and-dynamic-import `DemoDataBanner.test.tsx` uses.
 *
 * WHAT THIS FILE CANNOT PROVE: that the deadline fires at the right moment.
 * `AbortSignal.timeout` schedules on a timer this suite does not own, and a
 * stubbed `fetch` never consults the signal at all. The timing is verified by
 * running the transport against a server that accepts and never answers — see
 * "The request deadline" in README.md. These tests cover the part a mock can
 * cover honestly: what the caller is handed.
 */
async function loadHttpApi() {
  vi.resetModules();
  vi.stubEnv('VITE_API_TRANSPORT', 'http');
  return import('./api');
}

/** What `fetch` throws when an `AbortSignal.timeout()` fires: NOT an AbortError. */
function timeoutAbort(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function stubFetch(rejection: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(rejection)),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('API_REQUEST_TIMEOUT_MS', () => {
  it('is the control API’s own ceilings plus a hop allowance', async () => {
    const { API_REQUEST_TIMEOUT_MS } = await loadHttpApi();
    // 10_000 Prisma pool acquisition + 5_000 interactive transaction + 750 hop.
    expect(API_REQUEST_TIMEOUT_MS).toBe(15_750);
  });
});

describe('a request that outlives the deadline', () => {
  it('surfaces as the dashboard’s own error type, not a bare DOMException', async () => {
    const { api, ApiRequestError, ApiTransportError } = await loadHttpApi();
    stubFetch(timeoutAbort());

    const error = await api.get('/v1/projects').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    // A subclass, so every consumer that already branches on ApiRequestError
    // keeps working: ErrorState, classifyWriteError, the retry predicate.
    expect(error).toBeInstanceOf(ApiRequestError);
  });

  it('is NOT retried, because retrying a deadline triples the wait it bounds', async () => {
    const { api } = await loadHttpApi();
    stubFetch(timeoutAbort());

    const error = (await api.get('/v1/projects').catch((caught: unknown) => caught)) as {
      status: number;
      retryable: boolean;
    };

    expect(error.status).toBe(408);
    expect(error.retryable).toBe(false);
  });

  it('says the API was reached but slow, and names the deadline', async () => {
    const { api } = await loadHttpApi();
    stubFetch(timeoutAbort());

    const error = (await api.get('/v1/projects').catch((caught: unknown) => caught)) as Error & {
      body: { code: string; message: string };
    };

    expect(error.body.message).toContain('did not answer within 15.8 s');
    expect(error.body.message).toContain('database connection pool');
    // The honest caveat: aborting closes a socket, it does not roll back.
    expect(error.body.message).toContain('may still be running on the server');
    expect(error.body.message).not.toContain('An unexpected error occurred');
    // From the CLOSED ApiErrorCode union — the API has no code for "never answered".
    expect(error.body.code).toBe('internal_error');
  });

  it('accepts a plain AbortError too, for an engine without TimeoutError', async () => {
    const { api, ApiTransportError } = await loadHttpApi();
    stubFetch(new DOMException('aborted', 'AbortError'));

    const error = await api.get('/v1/projects').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as { kind: string }).kind).toBe('timeout');
  });

  it('passes a signal to fetch, so the deadline is the browser’s and not advisory', async () => {
    const { api } = await loadHttpApi();
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return Promise.reject(timeoutAbort());
      }),
    );

    await api.get('/v1/projects').catch(() => undefined);

    expect(seen[0]?.url).toBe('/v1/projects');
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    // Not already aborted: a deadline that fires before the request leaves
    // would make every call fail, and would pass a weaker assertion.
    expect(seen[0]?.init?.signal?.aborted).toBe(false);
  });
});

describe('a host the browser could not reach', () => {
  it('is a DIFFERENT message from a timeout, and says CORS looks identical', async () => {
    const { api } = await loadHttpApi();
    stubFetch(new TypeError('Failed to fetch'));

    const error = (await api.get('/v1/projects').catch((caught: unknown) => caught)) as Error & {
      kind: string;
      status: number;
      retryable: boolean;
      body: { message: string };
    };

    expect(error.kind).toBe('unreachable');
    expect(error.body.message).toContain('could not reach the control API');
    expect(error.body.message).toContain('CORS_ORIGINS');
    expect(error.body.message).toContain('/v1/projects');
    // The two causes lead an operator to different places, so the copy must
    // not overlap: "slow" must not appear in the unreachable sentence.
    expect(error.body.message).not.toContain('did not answer within');
  });

  it('IS retried — it fails in milliseconds and a dropped connection recovers', async () => {
    const { api } = await loadHttpApi();
    stubFetch(new TypeError('Failed to fetch'));

    const error = (await api.get('/v1/projects').catch((caught: unknown) => caught)) as {
      status: number;
      retryable: boolean;
    };

    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe('what the classification must NOT swallow', () => {
  it('leaves an HTTP error envelope exactly as the API sent it', async () => {
    const { api, ApiRequestError, ApiTransportError } = await loadHttpApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () =>
            Promise.resolve({
              error: { code: 'forbidden', message: 'Nope.', request_id: 'req_1' },
            }),
        } as unknown as Response),
      ),
    );

    const error = (await api.get('/v1/projects').catch((caught: unknown) => caught)) as Error & {
      status: number;
      body: { code: string; request_id?: string };
    };

    expect(error).toBeInstanceOf(ApiRequestError);
    // Re-wrapping a real answer as a transport failure would lose the code,
    // the status and the request_id a support conversation needs.
    expect(error).not.toBeInstanceOf(ApiTransportError);
    expect(error.status).toBe(403);
    expect(error.body.code).toBe('forbidden');
    expect(error.body.request_id).toBe('req_1');
  });

  it('does not call a body that is not JSON "unreachable"', async () => {
    const { api, ApiTransportError } = await loadHttpApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        } as unknown as Response),
      ),
    );

    const error = await api.get('/v1/projects').catch((caught: unknown) => caught);

    // A 200 arrived. Telling the operator to check DNS would be a wrong turn.
    expect(error).not.toBeInstanceOf(ApiTransportError);
    expect(error).toBeInstanceOf(SyntaxError);
  });
});
