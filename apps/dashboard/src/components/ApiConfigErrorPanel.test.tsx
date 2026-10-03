import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL_VAR, resolveApiConfig } from '../lib/api-base-url';
import { ApiConfigErrorPanel, ApiConfigGate } from './ApiConfigErrorPanel';

/**
 * The real message, from the real validator, in the production branch — not a
 * fixture. A test that invents its own string would keep passing if
 * `resolveApiBaseUrl` stopped naming the variable.
 */
const PRODUCTION_FAILURE = resolveApiConfig(undefined, true).error!;

describe('ApiConfigErrorPanel', () => {
  it('names the variable, where to set it, and a usable example', () => {
    const html = renderToStaticMarkup(<ApiConfigErrorPanel message={PRODUCTION_FAILURE} />);

    expect(html).toContain(API_BASE_URL_VAR);
    expect(html).toContain('VITE_API_BASE_URL=https://api.hookubit.com');
    expect(html).toContain('Cloudflare');
    expect(html).toContain('Variables and secrets');
    // The validator's own sentence, so the panel and the console agree.
    expect(html).toContain('A production build of the dashboard has no dev');
  });

  it('is an alert, and carries palette tokens rather than one scheme’s colours', () => {
    const html = renderToStaticMarkup(<ApiConfigErrorPanel message={PRODUCTION_FAILURE} />);

    expect(html).toContain('role="alert"');
    // `bg-canvas`/`text-ink` resolve through the CSS variables index.css
    // redefines under [data-theme="dark"]. A hardcoded `bg-white` here would
    // render white-on-white for a dark operator.
    expect(html).toContain('bg-canvas');
    expect(html).toContain('text-ink');
    expect(html).not.toMatch(/bg-(white|black|slate-|gray-|zinc-)/);
    expect(html).not.toContain('dark:');
  });
});

describe('ApiConfigGate', () => {
  it('mounts the app when there is no configuration error', () => {
    const html = renderToStaticMarkup(
      <ApiConfigGate configError={null}>
        <p>__app-mounted__</p>
      </ApiConfigGate>,
    );

    expect(html).toBe('<p>__app-mounted__</p>');
    expect(html).not.toContain(API_BASE_URL_VAR);
  });

  it('shows the panel INSTEAD of the app when resolution failed', () => {
    const html = renderToStaticMarkup(
      <ApiConfigGate configError={PRODUCTION_FAILURE}>
        <p>__app-mounted__</p>
      </ApiConfigGate>,
    );

    expect(html).toContain(API_BASE_URL_VAR);
    // The half that matters: a deploy that cannot reach an API must not render
    // a dashboard that looks alive.
    expect(html).not.toContain('__app-mounted__');
  });

  it('takes the app branch for the bundle this test suite is built as', async () => {
    // Vitest resolves the base the same way `vite dev` does — unset is correct,
    // PROD is false — so `apiConfigError` is null and `main.tsx` mounts the app.
    const { apiConfigError } = await import('../lib/api-base-url');
    expect(apiConfigError).toBeNull();
  });
});
