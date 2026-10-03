/**
 * The `curl` that publishes a first event.
 *
 * This is the payoff of the whole guided path, so it is built from the
 * operator's REAL project id rather than a `<your-project-id>` placeholder they
 * have to go and find. The only blank left is the API key, because the
 * plaintext is returned exactly once at creation and nothing — not this UI, not
 * the API, not psql — can recover it afterwards.
 *
 * Ingest is a SEPARATE surface from the control API this dashboard talks to
 * (docs/API.md: Go on :8080, versus NestJS on :3000). It is not behind the
 * dashboard's dev proxy and it is not the page's own origin, so its base URL is
 * configuration, not something to derive from `window.location`.
 */

/** Placeholder shown when the operator has not pasted a key. */
export const API_KEY_PLACEHOLDER = 'wk_live_your_key_here';

/**
 * Where the ingest API lives. `VITE_INGEST_BASE_URL` at build time, falling
 * back to the port docs/DEVELOPMENT.md uses locally.
 *
 * A wrong base URL here produces a `curl` that fails with connection refused,
 * which is annoying but honest. Deriving it from the dashboard's own origin
 * would produce one that 404s against the *control* API — a much more
 * confusing failure, because the request looks like it reached something.
 */
export function ingestBaseUrl(): string {
  return import.meta.env.VITE_INGEST_BASE_URL ?? 'http://localhost:8080';
}

export interface PublishRequestOptions {
  projectId: string;
  /** The plaintext key, if the operator pasted one. Never persisted anywhere. */
  apiKey?: string;
  eventType?: string;
  baseUrl?: string;
}

/**
 * `Idempotency-Key` is in the snippet on purpose, even though a first test
 * event does not need one. It is the single habit that makes a publisher safe
 * to retry, and the first request someone copies is the one they paste into
 * their own codebase.
 */
export function buildPublishCurl({
  projectId,
  apiKey,
  eventType = 'payment.settled',
  baseUrl = ingestBaseUrl(),
}: PublishRequestOptions): string {
  const key = apiKey?.trim() || API_KEY_PLACEHOLDER;
  const body = JSON.stringify(
    {
      event_type: eventType,
      data: { transaction_id: 'txn_test_001', amount: 120.5, currency: 'GHS' },
    },
    null,
    2,
  )
    .split('\n')
    .join('\n  ');

  return [
    `curl -X POST ${baseUrl}/v1/projects/${projectId}/events \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: first-test-event-1" \\`,
    `  -d '${body}'`,
  ].join('\n');
}

/** The `202` the ingest API answers with, so the reader knows what success looks like. */
export const PUBLISH_EXPECTED_RESPONSE = `HTTP/1.1 202 Accepted

{ "id": "evt_01J...", "status": "accepted" }`;
