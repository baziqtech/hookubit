import { describe, expect, it } from 'vitest';
import { nextAttemptLabel } from './next-attempt';

const NOW = new Date('2026-09-09T12:00:00.000Z');

/**
 * `next_attempt_at` is going NOT NULL, and the data plane writes `now()` on
 * every terminal transition. The cell must therefore be gated on `terminal`
 * before it ever formats the timestamp — a succeeded delivery reading
 * "2 minutes ago" is a retry the page promised that will never happen.
 */
describe('nextAttemptLabel', () => {
  it('never renders a time for a terminal delivery, whatever the column holds', () => {
    const label = nextAttemptLabel(
      { terminal: true, next_attempt_at: '2026-09-09T11:58:00.000Z' },
      NOW,
    );
    expect(label).toBe('None');
    expect(label).not.toMatch(/ago/);
  });

  it('renders the schedule for a live delivery', () => {
    expect(
      nextAttemptLabel({ terminal: false, next_attempt_at: '2026-09-09T12:14:00.000Z' }, NOW),
    ).toBe('in 14 minutes');
  });

  it('reads a null on a live delivery as "as soon as a worker is free", per the DTO', () => {
    expect(nextAttemptLabel({ terminal: false, next_attempt_at: null }, NOW)).toBe(
      'When a worker is free',
    );
  });
});
