import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE_URL,
  API_BASE_URL_VAR,
  apiConfigError,
  apiUrl,
  joinApiUrl,
  resolveApiBaseUrl,
  resolveApiConfig,
} from './api-base-url';

const DEV = false;
const PROD = true;

describe('resolveApiBaseUrl — unset', () => {
  it('is empty in development, so Vite’s /v1 proxy keeps handling the call', () => {
    expect(resolveApiBaseUrl(undefined, DEV)).toBe('');
    expect(resolveApiBaseUrl('', DEV)).toBe('');
    expect(resolveApiBaseUrl('   ', DEV)).toBe('');
  });

  it('throws in a production build rather than letting a relative path hit the SPA shell', () => {
    // The failure it prevents: `/v1/projects` against the Cloudflare hostname
    // returns index.html with a 200, so every screen would fail parsing JSON
    // with nothing naming the cause.
    expect(() => resolveApiBaseUrl(undefined, PROD)).toThrow(API_BASE_URL_VAR);
    expect(() => resolveApiBaseUrl('', PROD)).toThrow(API_BASE_URL_VAR);
    expect(() => resolveApiBaseUrl('  ', PROD)).toThrow(/is not set/);
  });
});

describe('resolveApiBaseUrl — an absolute base', () => {
  it('keeps the origin and adds no trailing slash', () => {
    expect(resolveApiBaseUrl('https://api.hookubit.com', PROD)).toBe('https://api.hookubit.com');
    expect(resolveApiBaseUrl('http://localhost:3000', DEV)).toBe('http://localhost:3000');
  });

  it('strips trailing slashes, however many', () => {
    expect(resolveApiBaseUrl('https://api.hookubit.com/', PROD)).toBe('https://api.hookubit.com');
    expect(resolveApiBaseUrl('https://api.hookubit.com///', PROD)).toBe('https://api.hookubit.com');
    expect(resolveApiBaseUrl('https://edge.example.com/control/', PROD)).toBe(
      'https://edge.example.com/control',
    );
  });

  it('trims surrounding whitespace, which a pasted dashboard value carries', () => {
    expect(resolveApiBaseUrl('  https://api.hookubit.com \n', PROD)).toBe(
      'https://api.hookubit.com',
    );
  });

  it('keeps a non-default port', () => {
    expect(resolveApiBaseUrl('http://10.0.0.4:3000/', PROD)).toBe('http://10.0.0.4:3000');
  });
});

describe('resolveApiBaseUrl — rejections', () => {
  it('rejects a base that already includes /v1, which would request /v1/v1/...', () => {
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/v1', PROD)).toThrow(
      /must not include the \/v1 prefix/,
    );
    // The trailing slash must not smuggle it past the check.
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/v1/', PROD)).toThrow(
      /must not include the \/v1 prefix/,
    );
    // And the message says what to use instead.
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/v1', PROD)).toThrow(
      /"https:\/\/api\.hookubit\.com"/,
    );
    expect(() => resolveApiBaseUrl('https://edge.example.com/control/v1', PROD)).toThrow(
      /"https:\/\/edge\.example\.com\/control"/,
    );
  });

  it('does not mistake a path that merely contains v1 for the prefix', () => {
    expect(resolveApiBaseUrl('https://api.hookubit.com/v1x', PROD)).toBe(
      'https://api.hookubit.com/v1x',
    );
    expect(resolveApiBaseUrl('https://api.hookubit.com/v1/edge', PROD)).toBe(
      'https://api.hookubit.com/v1/edge',
    );
  });

  it('rejects a value that is not an absolute URL', () => {
    // Both of these would resolve against the dashboard's own origin once
    // prepended — the exact mistake this module exists to catch.
    expect(() => resolveApiBaseUrl('api.hookubit.com', PROD)).toThrow(/absolute URL/);
    expect(() => resolveApiBaseUrl('/api', PROD)).toThrow(/absolute URL/);
    expect(() => resolveApiBaseUrl('//api.hookubit.com', PROD)).toThrow(/absolute URL/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => resolveApiBaseUrl('ws://api.hookubit.com', PROD)).toThrow(/http or https/);
    expect(() => resolveApiBaseUrl('file:///tmp', PROD)).toThrow(/http or https/);
  });

  it('rejects a query string or fragment, which a joined path would land inside', () => {
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/?x=1', PROD)).toThrow(
      /query string or fragment/,
    );
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/#x', PROD)).toThrow(
      /query string or fragment/,
    );
  });

  it('rejects a bad value in development too — only ABSENCE is mode-dependent', () => {
    expect(() => resolveApiBaseUrl('https://api.hookubit.com/v1', DEV)).toThrow();
    expect(() => resolveApiBaseUrl('api.hookubit.com', DEV)).toThrow();
  });
});

describe('joinApiUrl', () => {
  it('leaves a relative path relative when there is no base', () => {
    expect(joinApiUrl('', '/v1/projects')).toBe('/v1/projects');
    expect(joinApiUrl('', '/v1/deliveries?status=failed')).toBe('/v1/deliveries?status=failed');
  });

  it('prepends an absolute base without doubling the slash', () => {
    expect(joinApiUrl('https://api.hookubit.com', '/v1/projects')).toBe(
      'https://api.hookubit.com/v1/projects',
    );
    expect(joinApiUrl('https://edge.example.com/control', '/v1/projects')).toBe(
      'https://edge.example.com/control/v1/projects',
    );
  });

  it('inserts the slash a caller forgot, which only an absolute base would corrupt', () => {
    expect(joinApiUrl('https://api.hookubit.com', 'v1/projects')).toBe(
      'https://api.hookubit.com/v1/projects',
    );
  });

  it('round-trips with a normalised base, trailing slash and all', () => {
    const base = resolveApiBaseUrl('https://api.hookubit.com/', PROD);
    expect(joinApiUrl(base, '/v1/projects')).toBe('https://api.hookubit.com/v1/projects');
  });
});

describe('the bundle-level base', () => {
  it('is relative under vitest, as it is under vite dev', () => {
    // No VITE_API_BASE_URL and PROD false, so the module-load resolution is
    // the development one and `apiUrl` is a no-op.
    expect(API_BASE_URL).toBe('');
    expect(apiUrl('/v1/projects')).toBe('/v1/projects');
  });

  it('reports no configuration error, so main.tsx mounts the app', () => {
    expect(apiConfigError).toBeNull();
  });
});

/**
 * `resolveApiConfig` turns the throw into a value WITHOUT weakening it — the
 * same inputs are refused, the message is the same message. What it buys is a
 * reason `main.tsx` can put on the page instead of a white body plus a console
 * line that the operator who caused it will never read.
 */
describe('resolveApiConfig', () => {
  it('passes a usable base through with no error', () => {
    expect(resolveApiConfig('https://api.hookubit.com/', PROD)).toEqual({
      base: 'https://api.hookubit.com',
      error: null,
    });
    expect(resolveApiConfig(undefined, DEV)).toEqual({ base: '', error: null });
  });

  it('turns the missing-variable refusal into a displayable message', () => {
    const config = resolveApiConfig(undefined, PROD);

    expect(config.base).toBe('');
    expect(config.error).toContain(API_BASE_URL_VAR);
    expect(config.error).toMatch(/is not set/);
    // The example value, so the panel does not have to invent one.
    expect(config.error).toContain('https://api.hookubit.com');
  });

  it('captures the malformed-value refusals too, which fail in dev as well', () => {
    expect(resolveApiConfig('api.hookubit.com', DEV).error).toMatch(/absolute URL/);
    expect(resolveApiConfig('https://api.hookubit.com/v1', PROD).error).toMatch(
      /must not include the \/v1 prefix/,
    );
  });

  it('never carries a base and an error at the same time', () => {
    // The union makes this a type error; the assertion is for the runtime,
    // because a base alongside an error is how a broken build boots anyway.
    for (const raw of ['', '  ', 'api.hookubit.com', 'ws://x', 'https://x/v1']) {
      const config = resolveApiConfig(raw, PROD);
      expect(config.error === null || config.base === '').toBe(true);
    }
  });
});

describe('apiUrl when the base could not be resolved', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses rather than silently requesting a relative path', async () => {
    // A bare host is rejected in development too, so this reproduces a broken
    // bundle without stubbing `import.meta.env.PROD` (a boolean vi.stubEnv
    // would turn into the string "false", which is truthy).
    vi.stubEnv('VITE_API_BASE_URL', 'api.hookubit.com');
    vi.resetModules();
    const module = await import('./api-base-url');

    expect(module.apiConfigError).toMatch(/absolute URL/);
    expect(module.API_BASE_URL).toBe('');
    // The failure this guard exists to stop: `/v1/projects` against the
    // Cloudflare hostname is answered with the SPA shell and a 200.
    expect(() => module.apiUrl('/v1/projects')).toThrow(/absolute URL/);
  });
});
