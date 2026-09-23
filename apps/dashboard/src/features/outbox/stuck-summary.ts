import type { Paged } from '../../lib/pagination';
import type { OutboxEntry } from '../../types/api';

/**
 * What, if anything, to say about events stuck before routing.
 *
 * Pure, and separate from the component, because the decisions worth pinning
 * are decisions rather than markup. This workspace renders with
 * `renderToStaticMarkup` and the component needs a query client and a router,
 * so the judgement lives here where it can be exercised directly.
 *
 * ## Three states, not two
 *
 * `unknown` exists because this notice is now the main way in: the screen it
 * points at was removed from the navigation, on the grounds that a permanent
 * entry spends a slot on a condition that is almost always absent.
 *
 * That makes a failed request dangerous in a way it was not before. Silence on
 * error reads as "nothing is stuck", and the one moment a request to this
 * project is failing is exactly the moment something might be. While the rail
 * carried an entry, that conflation cost nothing; as the main door it would
 * close precisely when it is needed.
 */
export type StuckState =
  /** Nothing to say: still loading, or genuinely nothing stuck. */
  | { kind: 'silent' }
  /** The request failed. We cannot say either way, and must not imply we can. */
  | { kind: 'unknown' }
  | {
      kind: 'stuck';
      count: number;
      /**
       * The list is one page, so the count is a FLOOR, not a total. Saying
       * "3 events" when there are eighty is worse than saying nothing: it
       * turns an outage into a rounding error.
       */
      atLeast: boolean;
      noun: 'event' | 'events';
      verb: 'was' | 'were';
      pronoun: 'It has' | 'They have';
    };

export function stuckEventsState(
  page: Paged<OutboxEntry> | undefined,
  failed: boolean,
): StuckState {
  // Data wins over the error flag: a background refetch can fail while the
  // rows on screen are still perfectly good, and reporting "cannot tell" over
  // a list we are holding would be a lie in the cautious direction.
  if (page) {
    const count = page.rows.length;
    if (count === 0) return { kind: 'silent' };
    const one = count === 1;
    return {
      kind: 'stuck',
      count,
      atLeast: page.hasMore,
      noun: one ? 'event' : 'events',
      verb: one ? 'was' : 'were',
      pronoun: one ? 'It has' : 'They have',
    };
  }
  return failed ? { kind: 'unknown' } : { kind: 'silent' };
}
