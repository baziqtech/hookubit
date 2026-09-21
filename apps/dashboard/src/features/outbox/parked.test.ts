import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from '../../types/api';
import { explainParked, futileSummary, isParked, parkReasonOf } from './parked';

/**
 * `OutboxEntryDto`, field for field. The factory builds the STALE case — a row
 * the router understood every time and parked on the clock — because that is
 * the one a requeue actually fixes, and the tests then break it in each of the
 * other ways.
 */
function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'obx_1',
    event_id: 'evt_1',
    type: 'event.created',
    status: 'failed',
    attempts: 63,
    unaccounted_attempts: 0,
    last_error: 'retry_duration_exceeded: failing since 2026-03-03T10:00:00Z (1h2m0s, bound 1h0m0s)',
    failing_since: '2026-03-03T10:00:00.000Z',
    fan_out_cursor: null,
    available_at: '2026-03-03T11:02:00.000Z',
    locked_by: null,
    locked_until: null,
    processed_at: '2026-03-03T11:02:00.000Z',
    created_at: '2026-03-03T09:58:00.000Z',
    ...overrides,
  };
}

describe('parkReasonOf', () => {
  it('reads the reason the router wrote as the prefix of last_error', () => {
    expect(parkReasonOf(entry())).toBe('retry_duration_exceeded');
    expect(
      parkReasonOf(
        entry({
          last_error:
            'attempts_exhausted: claimed 11 times (11 of them leaving no recorded outcome, bound 10)',
        }),
      ),
    ).toBe('attempts_exhausted');
    expect(parkReasonOf(entry({ last_error: 'event_missing: event row no longer exists' }))).toBe(
      'event_missing',
    );
    expect(parkReasonOf(entry({ last_error: 'unknown_outbox_type: event.replay' }))).toBe(
      'unknown_outbox_type',
    );
  });

  it('falls back to the counters when the prefix is missing, in the router’s own order', () => {
    // Unaccounted claims outrank the clock, exactly as router.go checks them.
    expect(
      parkReasonOf(entry({ last_error: 'connection reset by peer', unaccounted_attempts: 11 })),
    ).toBe('attempts_exhausted');
    expect(parkReasonOf(entry({ last_error: 'connection reset by peer' }))).toBe(
      'retry_duration_exceeded',
    );
    expect(
      parkReasonOf(entry({ last_error: null, failing_since: null, unaccounted_attempts: 0 })),
    ).toBe('unknown');
  });

  it('does not mistake an arbitrary word-colon prefix for a reason', () => {
    expect(parkReasonOf(entry({ last_error: 'timeout: context deadline exceeded' }))).toBe(
      'retry_duration_exceeded',
    );
  });
});

describe('explainParked', () => {
  it('tells a poison row apart from an outage, and says which one a requeue helps', () => {
    const poison = explainParked(
      entry({
        attempts: 11,
        unaccounted_attempts: 11,
        failing_since: null,
        last_error:
          'attempts_exhausted: claimed 11 times (11 of them leaving no recorded outcome, bound 10)',
      }),
    );
    expect(poison.reason).toBe('attempts_exhausted');
    expect(poison.headline).toMatch(/router kept dying/i);
    expect(poison.outlook).toBe('caution');
    expect(poison.detail).toMatch(/park again/);

    const stale = explainParked(entry());
    expect(stale.reason).toBe('retry_duration_exceeded');
    expect(stale.headline).toMatch(/longer than the retry window/i);
    expect(stale.outlook).toBe('safe');
    // It names the thing that was actually failing, which was not the event.
    expect(stale.detail).toMatch(/not the event itself/);
  });

  it('always states both counters together, because the ratio is the diagnosis', () => {
    const explanation = explainParked(entry({ attempts: 14, unaccounted_attempts: 11 }));
    expect(explanation.evidence[0]).toBe(
      '14 claims in total, 11 of them ending with nothing recorded',
    );
    expect(explainParked(entry({ attempts: 1, unaccounted_attempts: 1 })).evidence[0]).toBe(
      '1 claim in total, 1 of them ending with nothing recorded',
    );
  });

  it('includes failing_since as evidence for the time-based bound', () => {
    expect(explainParked(entry()).evidence).toContain(
      'failing continuously since 2026-03-03T10:00:00.000Z',
    );
  });

  it('flags a partial fan-out from fan_out_cursor', () => {
    expect(explainParked(entry({ fan_out_cursor: 'sub_01HALFWAY' })).partial).toBe(true);
    expect(explainParked(entry()).partial).toBe(false);
  });

  it('calls a requeue futile when it cannot possibly help', () => {
    expect(
      explainParked(entry({ last_error: 'event_missing: event row no longer exists' })).outlook,
    ).toBe('futile');
    const unknownType = explainParked(
      entry({ type: 'event.replay', last_error: 'unknown_outbox_type: event.replay' }),
    );
    expect(unknownType.outlook).toBe('futile');
    expect(unknownType.headline).toContain('event.replay');
  });

  it('admits when it does not know', () => {
    const explanation = explainParked(
      entry({ last_error: null, failing_since: null, unaccounted_attempts: 0 }),
    );
    expect(explanation.reason).toBe('unknown');
    expect(explanation.headline).toMatch(/did not say why/);
    expect(explanation.outlook).toBe('caution');
  });
});

describe('isParked', () => {
  it('is true for failed and nothing else — the API 409s the rest', () => {
    expect(isParked(entry())).toBe(true);
    expect(isParked(entry({ status: 'pending' }))).toBe(false);
    expect(isParked(entry({ status: 'processing' }))).toBe(false);
    expect(isParked(entry({ status: 'processed' }))).toBe(false);
  });
});

describe('futileSummary', () => {
  const futile = () => entry({ last_error: 'unknown_outbox_type: no router handles \'ledger.synced\'' });

  it('says nothing when nothing is futile, so the common case costs no space', () => {
    expect(futileSummary([entry(), entry()])).toBeNull();
  });

  it('counts only the rows requeueing cannot move', () => {
    // `caution` rows may well work — a poison row can be fixed by a deploy
    // that did not change the router's registration. Counting them here would
    // make the warning cry wolf and get read past on the day it is right.
    const rows = [entry(), futile(), entry({ attempts: 14, unaccounted_attempts: 11 })];
    const summary = futileSummary(rows);
    expect(summary?.count).toBe(1);
    expect(summary?.total).toBe(3);
  });
});
