import { describe, expect, it } from 'vitest';
import type { Paged } from '../../lib/pagination';
import type { OutboxEntry } from '../../types/api';
import { stuckEventsSummary } from './stuck-summary';

const page = (count: number, hasMore = false): Paged<OutboxEntry> => ({
  rows: Array.from({ length: count }, () => ({}) as OutboxEntry),
  hasMore,
  nextOffset: hasMore ? count : null,
});

describe('stuckEventsSummary', () => {
  it('is silent while the query is still loading', () => {
    // A wrong panel is worse than a late one: this renders on the two screens
    // an operator stares at, and a flash of "0 events" reads as an all-clear.
    expect(stuckEventsSummary(undefined)).toBeNull();
  });

  it('is silent when nothing is stuck, which is the normal case', () => {
    expect(stuckEventsSummary(page(0))).toBeNull();
  });

  it('speaks as soon as one event is stuck', () => {
    const s = stuckEventsSummary(page(1));
    expect(s).toMatchObject({ count: 1, atLeast: false, noun: 'event', verb: 'was' });
  });

  it('marks the count as a FLOOR when the page is not the whole set', () => {
    // The list is one page. Stating 50 when the outage is 4000 turns an
    // incident into a rounding error, so the phrasing has to hedge.
    expect(stuckEventsSummary(page(50, true))?.atLeast).toBe(true);
    expect(stuckEventsSummary(page(50, false))?.atLeast).toBe(false);
  });

  it('agrees with itself grammatically', () => {
    expect(stuckEventsSummary(page(1))).toMatchObject({ verb: 'was', pronoun: 'It has' });
    expect(stuckEventsSummary(page(2))).toMatchObject({ verb: 'were', pronoun: 'They have' });
  });
});
