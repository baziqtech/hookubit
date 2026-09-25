import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/query-keys';
import type {
  DeliveryAttempt,
  DeliveryDetail,
  EventDetail,
  EventPayload,
} from '../../types/api';
import { EventPayloadView } from '../events/EventPayloadView';
import { RequestTab } from './DeliveryDetailPage';

const ORG = 'org_1';
const PROJECT = 'proj_1';
const EVENT = 'evt_1';

function payload(overrides: Partial<EventPayload> = {}): EventPayload {
  return {
    source: 'inline',
    body: '{"order_id":"ord_9","amount":1250}',
    encoding: 'utf-8',
    location: null,
    size_bytes: 34,
    sha256: 'ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890',
    normalised_json: { order_id: 'ord_9', amount: 1250 },
    notice: 'The bytes below are the payload as delivered.',
    ...overrides,
  };
}

function event(payloadOverrides: Partial<EventPayload> = {}): EventDetail {
  return {
    id: EVENT,
    project_id: PROJECT,
    event_type: 'payment.settled',
    idempotency_key: null,
    ordering_key: null,
    status: 'processed',
    payload_size: 34,
    payload_hash: 'ab12cd34',
    payload_inline: true,
    payload_location: null,
    headers: null,
    created_at: '2026-06-01T00:00:00.000Z',
    processed_at: '2026-06-01T00:00:01.000Z',
    deliveries: null,
    payload: payload(payloadOverrides),
  };
}

const attempt: DeliveryAttempt = {
  id: 'att_1',
  delivery_id: 'del_1',
  attempt_number: 3,
  status: 'failure',
  http_status: 503,
  request_headers: { 'Webhook-Signature': 'v1=deadbeef', 'Content-Type': 'application/json' },
  response_headers: null,
  response_body: null,
  response_body_location: null,
  response_size: null,
  error_code: null,
  error_message: 'HTTP 503',
  trace_id: null,
  duration_ms: 120,
  worker_id: 'worker-1',
  started_at: '2026-06-01T00:00:00.000Z',
  completed_at: '2026-06-01T00:00:01.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
};

function delivery(overrides: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    id: 'del_1',
    event_id: EVENT,
    endpoint_id: 'ep_1',
    subscription_id: 'sub_1',
    project_id: PROJECT,
    status: 'retrying',
    terminal: false,
    attempt_count: 3,
    max_attempts: 8,
    next_attempt_at: '2026-06-01T00:05:00.000Z',
    last_attempt_at: '2026-06-01T00:00:01.000Z',
    completed_at: null,
    ordering_key: null,
    last_error: 'HTTP 503',
    locked_by: null,
    locked_until: null,
    replay_of_delivery_id: null,
    replayed_by: null,
    is_replay: false,
    attempts_pruned_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:01.000Z',
    event: {
      id: EVENT,
      event_type: 'payment.settled',
      idempotency_key: null,
      created_at: '2026-06-01T00:00:00.000Z',
    },
    endpoint: {
      id: 'ep_1',
      name: 'Finance',
      url: 'https://finance.example/hooks',
      status: 'active',
      disabled_reason: null,
    },
    attempts: [attempt],
    attempts_truncated: false,
    ...overrides,
  };
}

/**
 * The tab through its real hook, against a query cache seeded with the event —
 * the same harness `OutboxPage.test.tsx` uses. `seed: false` leaves the cache
 * empty, which is the PENDING render: exactly what the operator sees for the
 * first paint after clicking Request.
 */
function renderTab({
  seed = event(),
  row = delivery(),
}: { seed?: EventDetail | false; row?: DeliveryDetail } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(queryKeys.event(PROJECT, EVENT), seed);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RequestTab delivery={row} orgId={ORG} projectId={PROJECT} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the Request tab', () => {
  it('shows the payload body, fetched from the event', () => {
    const html = renderTab();

    expect(html).toContain('ord_9');
    expect(html).toContain('1250');
    // Still says WHOSE bytes these are: one publish, stored once.
    expect(html).toContain('published once on the event');
    expect(html).toContain('does not carry its own copy of the payload');
    expect(html).toContain(`/orgs/${ORG}/projects/${PROJECT}/events/${EVENT}`);
  });

  it('renders the attempt headers first, and does not wait on the payload to do it', () => {
    const html = renderTab({ seed: false });

    // The headers are in hand on the delivery; nothing about them is fetched.
    expect(html).toContain('Webhook-Signature');
    expect(html).toContain('Headers sent on attempt #3');
    expect(html.indexOf('request headers')).toBeLessThan(html.indexOf('Request body'));

    // And the body says it is still coming rather than showing an empty block.
    expect(html).toContain('Loading');
    expect(html).not.toContain('ord_9');
  });

  it('keeps the headers even when the attempt detail was reclaimed', () => {
    const html = renderTab({
      row: delivery({ attempts: [], attempts_pruned_at: '2026-08-01T00:00:00.000Z' }),
    });

    expect(html).toContain('reclaimed with the attempt detail on 1 Aug 2026');
    // The body is on the EVENT, so retention on the attempts does not take it.
    expect(html).toContain('ord_9');
  });
});

describe('EventPayloadView', () => {
  it('renders inline bytes as the code block', () => {
    const html = renderToStaticMarkup(<EventPayloadView payload={payload()} />);
    expect(html).toContain('ord_9');
    expect(html).toContain('inline');
    expect(html).toContain('sha256:');
  });

  /*
   * The bug this component exists to prevent: an offloaded payload has no
   * `body` and no `normalised_json`, and reading it as the body renders an
   * empty code block that looks like an event published with nothing in it.
   */
  it('names the location instead of rendering an empty block when the payload is offloaded', () => {
    const html = renderToStaticMarkup(
      <EventPayloadView
        payload={payload({
          source: 'object_storage',
          body: null,
          encoding: null,
          normalised_json: null,
          location: 's3://payloads/evt_1',
          notice: 'This payload was too large to store inline.',
        })}
      />,
    );

    expect(html).toContain('not available to read here');
    expect(html).toContain('s3://payloads/evt_1');
    expect(html).toContain('This payload was too large to store inline.');
    expect(html).not.toContain('<code');
  });

  it('says the payload is gone when it is unavailable with no location', () => {
    const html = renderToStaticMarkup(
      <EventPayloadView
        payload={payload({
          source: 'unavailable',
          body: null,
          encoding: null,
          normalised_json: null,
          location: null,
          notice: 'The raw bytes are no longer held.',
        })}
      />,
    );

    expect(html).toContain('not available to read here');
    expect(html).not.toContain('it is held at');
  });

  it('shows a base64 body as text rather than pretending it is JSON', () => {
    const html = renderToStaticMarkup(
      <EventPayloadView
        payload={payload({
          body: 'AAECAwQ=',
          encoding: 'base64',
          normalised_json: null,
          notice: 'The payload is not valid UTF-8, so it is shown base64-encoded.',
        })}
      />,
    );

    expect(html).toContain('AAECAwQ=');
    expect(html).toContain('not valid UTF-8');
  });
});
