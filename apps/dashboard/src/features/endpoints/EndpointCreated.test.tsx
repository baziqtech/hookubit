import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CreatedEndpoint } from '../../types/api';
import { EndpointCreatedNotice } from './EndpointsPage';

const base: CreatedEndpoint = {
  id: 'ep_test',
  project_id: 'proj_test',
  name: 'warehouse-sync',
  url: 'https://example.com/hooks',
  description: null,
  health: null,
  status: 'active',
  enabled: true,
  disabled_reason: null,
  disabled_at: null,
  timeout_ms: 30_000,
  max_concurrency: 16,
  rate_limit: null,
  rate_limit_window_seconds: 1,
  retry_policy_id: null,
  custom_headers: null,
  // The caller received the plaintext below, so a secret is signing right now.
  has_live_secret: true,
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
  secret: 'whsec_plaintext',
  secret_pending: false,
  secret_version: 1,
};

const render = (endpoint: CreatedEndpoint) =>
  renderToStaticMarkup(<EndpointCreatedNotice endpoint={endpoint} />);

describe('EndpointCreatedNotice', () => {
  /**
   * The failure this guards against: a developer creates an endpoint, sees a
   * success dialog, wires up a consumer, and waits for deliveries that will
   * never arrive because the endpoint is paused with no signing secret.
   */
  it('does NOT present a secret_pending endpoint as working', () => {
    const html = render({
      ...base,
      status: 'paused',
      enabled: false,
      secret: null,
      secret_pending: true,
      // Nothing to sign with: this is the state `has_live_secret` reports, and
      // the reason `POST /enable` would refuse this endpoint with a 409.
      has_live_secret: false,
      disabled_reason: 'Awaiting a signing secret.',
    });

    expect(html).toContain('secret-pending-notice');
    expect(html).toContain('will not receive deliveries');
    expect(html).toContain('paused');
    // Says who has to act, and what they have to do.
    expect(html).toContain('owner or admin');
    expect(html).toContain('rotate');
    // There is no plaintext to reveal, so no copy affordance may appear.
    expect(html).not.toContain('secret-plaintext');
    expect(html).not.toContain('you will not see it again');
  });

  it('shows the plaintext exactly once when the caller may receive it', () => {
    const html = render(base);

    expect(html).not.toContain('secret-pending-notice');
    expect(html).toContain('secret-plaintext');
    expect(html).toContain('whsec_plaintext');
    expect(html).toContain('is active');
    // The one-time warning is part of the contract, not a nicety.
    expect(html).toContain('will not see it again');
  });

  it('treats a null secret as pending even if the flag disagrees', () => {
    // Defensive: there is nothing to show, so it must not claim success.
    const html = render({ ...base, secret: null, secret_pending: false, has_live_secret: false });
    expect(html).toContain('secret-pending-notice');
  });
});
