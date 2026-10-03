import { describe, expect, it } from 'vitest';
import type { EventDeliveryRollup } from '../../types/api';
import { describeRollup } from './rollup';

const rollup = (over: Partial<EventDeliveryRollup>): EventDeliveryRollup =>
  ({
    state: 'delivered',
    total: 0,
    succeeded: 0,
    failed: 0,
    in_flight: 0,
    cancelled: 0,
    ...over,
  }) as EventDeliveryRollup;

describe('describeRollup', () => {
  it('says what happened to a dropped event, not how many of nothing', () => {
    // "0 deliveries" reads as a number that has not arrived yet. This is a
    // routing decision that has already been made.
    const summary = describeRollup(rollup({ state: 'dropped' }));
    expect(summary.tone).toBe('danger');
    expect(summary.detail).toBe('No subscription matched — nothing was created');
  });

  it('distinguishes cancelled from failed, because the next click differs', () => {
    // Cancelled means an endpoint was paused; failed means it was not. Both
    // roll up to "partly delivered" and they are not the same problem.
    expect(
      describeRollup(rollup({ state: 'partly_delivered', total: 2, succeeded: 1, cancelled: 1 }))
        .detail,
    ).toBe('1 delivered · 1 cancelled');

    expect(
      describeRollup(rollup({ state: 'partly_delivered', total: 2, succeeded: 1, failed: 1 }))
        .detail,
    ).toBe('1 delivered · 1 failed');
  });

  it('reduces a uniform outcome to its ratio', () => {
    expect(describeRollup(rollup({ state: 'delivered', total: 3, succeeded: 3 })).detail).toBe(
      '3 of 3 delivered',
    );
    expect(describeRollup(rollup({ state: 'all_failed', total: 1, failed: 1 })).detail).toBe(
      '0 of 1 delivered',
    );
  });

  it('spells out an all-failed mix that includes cancellations', () => {
    // The state is honest — nothing arrived — but "0 of 2 delivered" would
    // hide that one of them was never attempted.
    expect(
      describeRollup(rollup({ state: 'all_failed', total: 2, failed: 1, cancelled: 1 })).detail,
    ).toBe('1 failed · 1 cancelled');
  });

  it('a missing rollup is "not asked for", never "nothing happened"', () => {
    expect(describeRollup(null).detail).toBe('—');
    expect(describeRollup(undefined).tone).toBe('neutral');
  });
});
