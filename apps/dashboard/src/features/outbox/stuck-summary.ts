import type { Paged } from '../../lib/pagination';
import type { OutboxEntry } from '../../types/api';

/**
 * What, if anything, to say about events stuck before fan-out.
 *
 * Pure, and separate from the component, because the decisions worth pinning
 * are decisions rather than markup: when to stay silent, and how to phrase a
 * count that is bounded by a page size. This workspace renders components with
 * `renderToStaticMarkup` and has no DOM, so a component that needs a query
 * client and a router is awkward to exercise; the judgement is here instead.
 */
export interface StuckSummary {
  count: number;
  /**
   * The list is one page, so the count is a FLOOR, not a total. Saying "3
   * events" when there are eighty is worse than saying nothing: it turns an
   * outage into a rounding error.
   */
  atLeast: boolean;
  noun: 'event' | 'events';
  verb: 'was' | 'were';
  pronoun: 'It has' | 'They have';
}

/**
 * `null` means render nothing — and that is the common case. Most projects have
 * nothing stuck most of the time, so an absent condition must cost no space and
 * produce no "all clear" to read past.
 *
 * `undefined` (still loading) is also silence: a late panel beats a wrong one.
 */
export function stuckEventsSummary(page: Paged<OutboxEntry> | undefined): StuckSummary | null {
  if (!page) return null;
  const count = page.rows.length;
  if (count === 0) return null;
  const one = count === 1;
  return {
    count,
    atLeast: page.hasMore,
    noun: one ? 'event' : 'events',
    verb: one ? 'was' : 'were',
    pronoun: one ? 'It has' : 'They have',
  };
}
