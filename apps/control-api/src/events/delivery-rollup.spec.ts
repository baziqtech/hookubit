import { DeliveryStatus, EventStatus } from '@prisma/client';
import { emptyCounts, rollUp } from './delivery-rollup';

const counts = (over: Partial<Record<DeliveryStatus, number>>) => ({ ...emptyCounts(), ...over });

describe('rollUp', () => {
  it('no deliveries and routing finished is DROPPED, not received', () => {
    // The single most confusing thing this product can do: a 202, and the
    // event goes nowhere because no subscription matched. It is invisible in
    // every other column because there is no delivery row to be absent from.
    const rollup = rollUp(EventStatus.processed, counts({}));
    expect(rollup.state).toBe('dropped');
    expect(rollup.total).toBe(0);
  });

  it('no deliveries and routing unfinished is RECEIVED', () => {
    expect(rollUp(EventStatus.received, counts({})).state).toBe('received');
    expect(rollUp(EventStatus.processing, counts({})).state).toBe('received');
  });

  it('anything still moving is IN PROGRESS, whatever else settled', () => {
    // An event with one success, one permanent failure and one still retrying
    // is not "partly delivered" yet — the retry may still land, and calling it
    // settled would have someone replay a delivery that was about to succeed.
    const rollup = rollUp(
      EventStatus.processed,
      counts({ succeeded: 1, exhausted: 1, retrying: 1 }),
    );
    expect(rollup.state).toBe('in_progress');
    expect(rollup.in_flight).toBe(1);
  });

  it('every delivery succeeded is DELIVERED', () => {
    expect(rollUp(EventStatus.processed, counts({ succeeded: 3 })).state).toBe('delivered');
  });

  it('a mix of settled outcomes is PARTLY DELIVERED', () => {
    const rollup = rollUp(EventStatus.processed, counts({ succeeded: 1, cancelled: 1 }));
    expect(rollup.state).toBe('partly_delivered');
    expect(rollup.cancelled).toBe(1);
  });

  it('nothing delivered and nothing moving is ALL FAILED, cancellations included', () => {
    // Not because a cancellation is a failure — it is usually a paused
    // endpoint — but because from the EVENT's point of view nothing arrived,
    // and "partly delivered" on an event where nothing was delivered is worse.
    const cancelledOnly = rollUp(EventStatus.processed, counts({ cancelled: 2 }));
    expect(cancelledOnly.state).toBe('all_failed');
    expect(cancelledOnly.succeeded).toBe(0);

    expect(rollUp(EventStatus.processed, counts({ exhausted: 2 })).state).toBe('all_failed');
  });

  it('counts `failed` and `exhausted` together, as every other rollup here does', () => {
    const rollup = rollUp(EventStatus.processed, counts({ failed: 1, exhausted: 2 }));
    expect(rollup.failed).toBe(3);
  });
});
