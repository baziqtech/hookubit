import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  DELIVERY_STATUS_SENTENCE,
  diagnoseDelivery,
  explainFailure,
  failureKindLabel,
} from './delivery-status';
import type { Delivery, DeliveryStatus } from '../types/api';

/**
 * The delivery detail page is the product's crown jewel, and these are the
 * cases the fixtures were built to break: a failure with NO status code, and a
 * 4xx that will never be retried no matter how many attempts remain.
 */
type Diagnosable = Pick<
  Delivery,
  'status' | 'attempt_count' | 'max_attempts' | 'last_status_code' | 'last_error' | 'terminal'
>;

const delivery = (over: Partial<Diagnosable>): Diagnosable => ({
  status: 'retrying',
  attempt_count: 3,
  max_attempts: 8,
  last_status_code: 504,
  last_error: null,
  terminal: false,
  ...over,
});

describe('classifyFailure', () => {
  it('classifies a response-less failure as transport, not as an HTTP error', () => {
    expect(classifyFailure(null, 'lookup api.example.com: no such host')).toBe('transport');
    expect(classifyFailure(null, 'tls: handshake failure')).toBe('transport');
  });

  it('separates retryable from permanent HTTP failures', () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      expect(classifyFailure(code, null)).toBe('http_retryable');
    }
    // The signature-rejection case: a consumer that cannot verify us answers
    // 401/403 forever, so retrying is pure waste.
    for (const code of [400, 401, 403, 404, 422]) {
      expect(classifyFailure(code, null)).toBe('http_permanent');
    }
  });

  it('treats any 2xx as no failure', () => {
    expect(classifyFailure(200, null)).toBe('none');
    expect(classifyFailure(204, null)).toBe('none');
  });
});

describe('a transport failure never claims an HTTP status', () => {
  it('labels it as having no HTTP response', () => {
    expect(failureKindLabel('transport')).toBe('No HTTP response');
  });

  it('explains that there is no status code and points at the likely cause', () => {
    const text = explainFailure('transport', null);
    expect(text).toMatch(/no status code/i);
    expect(text).toMatch(/DNS/);
    expect(text).toMatch(/TLS|certificate/i);
    // It must never render a fabricated code.
    expect(text).not.toMatch(/HTTP null|HTTP undefined/);
  });

  it('carries the raw error through the diagnosis for a DNS failure', () => {
    const result = diagnoseDelivery(
      delivery({
        status: 'exhausted',
        terminal: true,
        attempt_count: 8,
        last_status_code: null,
        last_error: 'lookup api.partner-bank.example.com: no such host',
      }),
    );

    expect(result.kind).toBe('transport');
    expect(result.headline).toBe('Gave up after all 8 attempts.');
    expect(result.explanation).not.toMatch(/HTTP null/);
  });
});

describe('what happens next is stated definitively', () => {
  it('says an exhausted chain will not be retried, and that replay is per endpoint', () => {
    const result = diagnoseDelivery(
      delivery({ status: 'exhausted', terminal: true, attempt_count: 8 }),
    );
    expect(result.next).toMatch(/No further attempt/i);
    expect(result.next).toMatch(/only this endpoint/i);
    expect(result.tone).toBe('danger');
  });

  it('does NOT promise a retry for a permanent 4xx', () => {
    const result = diagnoseDelivery(
      delivery({ status: 'failed', last_status_code: 403, attempt_count: 1 }),
    );

    expect(result.kind).toBe('http_permanent');
    expect(result.next).toMatch(/not retried/i);
    expect(result.next).not.toMatch(/retry is expected/i);
    // And it names the likely cause, which is nearly always signing.
    expect(result.explanation).toMatch(/signature verification/i);
  });

  it('counts the attempts left on a retrying delivery', () => {
    const result = diagnoseDelivery(delivery({ status: 'retrying', attempt_count: 3, max_attempts: 8 }));
    expect(result.headline).toContain('5 attempts left');
    expect(result.tone).toBe('warn');
  });

  it('reports a success without inventing a failure', () => {
    const result = diagnoseDelivery(
      delivery({ status: 'succeeded', terminal: true, attempt_count: 1, last_status_code: 200 }),
    );
    expect(result.kind).toBe('none');
    expect(result.headline).toBe('Delivered after 1 attempt.');
    expect(result.next).toMatch(/Nothing further/i);
  });

  it('says a cancelled delivery stopped deliberately', () => {
    const result = diagnoseDelivery(delivery({ status: 'cancelled', terminal: true }));
    expect(result.next).toMatch(/No further attempt/i);
  });
});

/**
 * Every state needs a plain-English sentence somewhere, because `scheduled`
 * versus `retrying` versus `exhausted` versus `cancelled` is not guessable.
 */
describe('status glossary', () => {
  const ALL: DeliveryStatus[] = [
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

  it('has a sentence for every delivery state', () => {
    for (const status of ALL) {
      expect(DELIVERY_STATUS_SENTENCE[status]).toBeTypeOf('string');
      expect(DELIVERY_STATUS_SENTENCE[status].length).toBeGreaterThan(20);
    }
  });

  it('distinguishes failed (retries pending) from exhausted (dead)', () => {
    expect(DELIVERY_STATUS_SENTENCE.failed).toMatch(/more attempts remain/i);
    expect(DELIVERY_STATUS_SENTENCE.exhausted).toMatch(/Nothing further/i);
    expect(DELIVERY_STATUS_SENTENCE.failed).not.toBe(DELIVERY_STATUS_SENTENCE.exhausted);
  });
});
