import { describe, expect, it } from 'vitest';
import { describeRetryPolicy } from './api';
import type { RetryPolicy } from '../../types/api';

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  id: 'rp_1',
  project_id: 'proj_1',
  name: 'Standard backoff',
  is_default: true,
  strategy: 'exponential',
  max_attempts: 8,
  initial_delay_ms: 1_000,
  max_delay_ms: 3_600_000,
  multiplier: 2,
  jitter_ratio: 0.2,
  max_retry_duration_ms: 86_400_000,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

/**
 * The picker replaced a free-text id box, and it only earns that if the option
 * says what the policy DOES. `rp_01JQ…` is not a choice anyone can make.
 */
describe('describeRetryPolicy', () => {
  it('leads with the attempt count, which is what decides whether a delivery dies mid-incident', () => {
    expect(describeRetryPolicy(policy())).toBe(
      '8 attempts, exponential ×2 from 1s up to 60m',
    );
  });

  it('covers every strategy the schema declares', () => {
    expect(describeRetryPolicy(policy({ strategy: 'linear', max_delay_ms: 30_000 }))).toContain(
      'linear',
    );
    expect(describeRetryPolicy(policy({ strategy: 'constant' }))).toBe('8 attempts, every 1s');
  });

  it('gets the singular right — "1 attempt", not "1 attempts"', () => {
    expect(describeRetryPolicy(policy({ max_attempts: 1 }))).toContain('1 attempt,');
  });
});
