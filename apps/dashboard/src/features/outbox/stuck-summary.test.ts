import { describe, expect, it } from 'vitest';
import type { Paged } from '../../lib/pagination';
import type { OutboxEntry } from '../../types/api';
import { stuckEventsState } from './stuck-summary';

const page = (count: number, hasMore = false): Paged<OutboxEntry> => ({
  rows: Array.from({ length: count }, () => ({}) as OutboxEntry),
  hasMore,
  nextOffset: hasMore ? count : null,
});

describe('stuckEventsState', () => {
  it('stays silent while loading', () => {
    // A wrong panel is worse than a late one on the two screens an operator
    // stares at; a flash of "0 events" reads as an all-clear.
    expect(stuckEventsState(undefined, false)).toEqual({ kind: 'silent' });
  });

  it('stays silent when nothing is stuck, which is the normal case', () => {
    expect(stuckEventsState(page(0), false)).toEqual({ kind: 'silent' });
  });

  it('says it CANNOT TELL when the request failed', () => {
    // This is the whole reason the state exists. Silence on error reads as
    // "nothing is stuck", and this notice is now the main way to the screen —
    // so it must not close at the one moment the project is misbehaving.
    expect(stuckEventsState(undefined, true)).toEqual({ kind: 'unknown' });
  });

  it('keeps reporting rows it already has when a refetch fails', () => {
    // Holding good rows and claiming "cannot tell" would be a lie, even a
    // cautious one.
    expect(stuckEventsState(page(2), true)).toMatchObject({ kind: 'stuck', count: 2 });
  });

  it('speaks as soon as one event is stuck', () => {
    expect(stuckEventsState(page(1), false)).toMatchObject({
      kind: 'stuck', count: 1, atLeast: false, noun: 'event', verb: 'was',
    });
  });

  it('marks the count as a FLOOR when the page is not the whole set', () => {
    expect(stuckEventsState(page(50, true), false)).toMatchObject({ atLeast: true });
    expect(stuckEventsState(page(50, false), false)).toMatchObject({ atLeast: false });
  });

  it('agrees with itself grammatically', () => {
    expect(stuckEventsState(page(1), false)).toMatchObject({ verb: 'was', pronoun: 'It has' });
    expect(stuckEventsState(page(2), false)).toMatchObject({ verb: 'were', pronoun: 'They have' });
  });
});
