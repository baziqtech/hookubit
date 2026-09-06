import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `usingMockApi` is read once at module load, so the transport has to be set
 * before the module graph is imported — hence the reset-and-dynamic-import.
 */
async function renderBanner(transport: string | undefined): Promise<string> {
  vi.resetModules();
  if (transport === undefined) vi.stubEnv('VITE_API_TRANSPORT', '');
  else vi.stubEnv('VITE_API_TRANSPORT', transport);
  const { DemoDataBanner } = await import('./DemoDataBanner');
  return renderToStaticMarkup(<DemoDataBanner />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('DemoDataBanner', () => {
  it('warns loudly when the mock transport is serving the page', async () => {
    const html = await renderBanner('mock');
    expect(html).toContain('Demo data');
    expect(html).toContain('not connected to an API');
    // Not dismissible: nothing in the banner may close it.
    expect(html).not.toContain('<button');
  });

  it('warns when the transport is unset, which is the deployed default', async () => {
    expect(await renderBanner(undefined)).toContain('Demo data');
  });

  it('renders nothing once the real transport is selected', async () => {
    expect(await renderBanner('http')).toBe('');
  });
});
