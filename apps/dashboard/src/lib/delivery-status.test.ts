import { describe, expect, it } from 'vitest';
import {
  attemptOutcome,
  attemptProgressLabel,
  attemptsRemaining,
  canReplay,
  deliveryStatusMeta,
  describeDelivery,
  isRetryableStatusCode,
  isTerminal,
  summarizeDeliveries,
  worstStatus,
} from './delivery-status';
import type { Delivery, DeliveryAttempt, DeliveryStatus } from '../types/api';

const ALL_STATUSES: DeliveryStatus[] = [
  'pending',
  'scheduled',
  'queued',
  'processing',
  'succeeded',
  'failed',
  'retrying',
  'exhausted',
  'cancelled',
];

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'del_1',
    project_id: 'proj_1',
    event_id: 'evt_1',
    event_type: 'payment.settled',
    endpoint_id: 'ep_1',
    endpoint_name: 'finance-api',
    endpoint_url: 'https://example.test/hook',
    status: 'succeeded',
    attempt_count: 1,
    max_attempts: 8,
    last_status_code: 200,
    last_error: null,
    next_attempt_at: null,
    created_at: '2026-09-06T12:00:00.000Z',
    completed_at: '2026-09-06T12:00:01.000Z',
    ...overrides,
  };
}

function attempt(overrides: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: 'att_1',
    delivery_id: 'del_1',
    attempt_number: 1,
    status_code: 200,
    duration_ms: 120,
    error: null,
    response_headers: null,
    response_body: null,
    response_truncated: false,
    attempted_at: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('deliveryStatusMeta', () => {
  it('covers every state in the machine', () => {
    for (const status of ALL_STATUSES) {
      const meta = deliveryStatusMeta(status);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tone).toBeDefined();
    }
  });

  it('distinguishes failed-with-retries-left from exhausted', () => {
    // The bug this guards: colouring both red and calling both "failed" hides
    // the only distinction an operator cares about — is it coming back?
    expect(deliveryStatusMeta('failed').terminal).toBe(false);
    expect(deliveryStatusMeta('failed').phase).toBe('failing');
    expect(deliveryStatusMeta('exhausted').terminal).toBe(true);
    expect(deliveryStatusMeta('exhausted').phase).toBe('dead');
  });

  it('treats only succeeded, exhausted and cancelled as terminal', () => {
    const terminal = ALL_STATUSES.filter(isTerminal);
    expect(terminal).toEqual(['succeeded', 'exhausted', 'cancelled']);
  });
});

describe('canReplay', () => {
  it('offers replay only once the chain has stopped without succeeding', () => {
    expect(canReplay(delivery({ status: 'exhausted' }))).toBe(true);
    expect(canReplay(delivery({ status: 'cancelled' }))).toBe(true);
    expect(canReplay(delivery({ status: 'succeeded' }))).toBe(false);
    // Still in flight: replaying would duplicate work the data plane is doing.
    expect(canReplay(delivery({ status: 'retrying' }))).toBe(false);
    expect(canReplay(delivery({ status: 'processing' }))).toBe(false);
  });
});

describe('attemptsRemaining', () => {
  it('counts what is left in a live chain', () => {
    expect(attemptsRemaining(delivery({ status: 'retrying', attempt_count: 3 }))).toBe(5);
  });

  it('is zero for terminal states regardless of the counters', () => {
    expect(attemptsRemaining(delivery({ status: 'exhausted', attempt_count: 8 }))).toBe(0);
    expect(attemptsRemaining(delivery({ status: 'succeeded', attempt_count: 1 }))).toBe(0);
  });

  it('never goes negative on inconsistent data', () => {
    expect(
      attemptsRemaining(delivery({ status: 'retrying', attempt_count: 12, max_attempts: 8 })),
    ).toBe(0);
  });
});

describe('describeDelivery', () => {
  it('explains a success', () => {
    expect(describeDelivery(delivery())).toBe('Delivered with HTTP 200 after 1 attempt');
  });

  it('explains an exhausted chain with its cause', () => {
    expect(
      describeDelivery(
        delivery({ status: 'exhausted', attempt_count: 8, last_status_code: 504 }),
      ),
    ).toBe('Gave up after 8 attempts — HTTP 504');
  });

  it('falls back to the transport error when there is no status code', () => {
    expect(
      describeDelivery(
        delivery({
          status: 'exhausted',
          attempt_count: 8,
          last_status_code: null,
          last_error: 'i/o timeout',
        }),
      ),
    ).toBe('Gave up after 8 attempts — i/o timeout');
  });

  it('says how many attempts are left while retrying', () => {
    expect(
      describeDelivery(
        delivery({ status: 'retrying', attempt_count: 7, last_status_code: 500 }),
      ),
    ).toBe('Retrying, 1 attempt left — HTTP 500');
  });

  it('has a sentence for every state', () => {
    for (const status of ALL_STATUSES) {
      expect(describeDelivery(delivery({ status }))).not.toBe('');
    }
  });
});

describe('isRetryableStatusCode', () => {
  it('mirrors the data plane rule: 408, 429 and 5xx retry', () => {
    expect(isRetryableStatusCode(500)).toBe(true);
    expect(isRetryableStatusCode(503)).toBe(true);
    expect(isRetryableStatusCode(408)).toBe(true);
    expect(isRetryableStatusCode(429)).toBe(true);
  });

  it('treats other 4xx as permanent', () => {
    expect(isRetryableStatusCode(400)).toBe(false);
    expect(isRetryableStatusCode(401)).toBe(false);
    expect(isRetryableStatusCode(403)).toBe(false);
    expect(isRetryableStatusCode(404)).toBe(false);
  });

  it('retries when no response arrived at all', () => {
    expect(isRetryableStatusCode(null)).toBe(true);
  });
});

describe('attemptOutcome', () => {
  it('marks 2xx as a success', () => {
    expect(attemptOutcome(attempt())).toEqual({ label: '200', tone: 'ok' });
  });

  it('warns on retryable codes and reddens permanent ones', () => {
    expect(attemptOutcome(attempt({ status_code: 429 })).tone).toBe('warn');
    expect(attemptOutcome(attempt({ status_code: 403 })).tone).toBe('danger');
  });

  it('surfaces the transport error when there was no response', () => {
    expect(attemptOutcome(attempt({ status_code: null, error: 'no such host' }))).toEqual({
      label: 'no such host',
      tone: 'danger',
    });
  });
});

describe('summarizeDeliveries', () => {
  it('separates exhausted from merely failing', () => {
    const summary = summarizeDeliveries([
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'retrying' },
      { status: 'failed' },
      { status: 'exhausted' },
      { status: 'queued' },
    ]);
    expect(summary).toEqual({ total: 6, succeeded: 2, failed: 2, pending: 1, exhausted: 1 });
  });

  it('handles an empty fan-out', () => {
    expect(summarizeDeliveries([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      pending: 0,
      exhausted: 0,
    });
  });
});

describe('worstStatus', () => {
  it('leads with the state that needs attention', () => {
    expect(worstStatus(['succeeded', 'retrying', 'exhausted'])).toBe('exhausted');
    expect(worstStatus(['succeeded', 'retrying'])).toBe('retrying');
    expect(worstStatus(['succeeded', 'succeeded'])).toBe('succeeded');
  });

  it('returns null with nothing to rank', () => {
    expect(worstStatus([])).toBeNull();
  });
});

describe('attemptProgressLabel', () => {
  it('reads the same everywhere', () => {
    expect(attemptProgressLabel({ attempt_count: 3, max_attempts: 8 })).toBe('Attempt 3 of 8');
  });
});
