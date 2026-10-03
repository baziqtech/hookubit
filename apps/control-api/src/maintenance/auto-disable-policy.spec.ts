import {
  AUTO_DISABLE_ADVISORY_LOCK_KEY,
  AUTO_DISABLE_REASON_PREFIX,
  DEFAULT_AUTO_DISABLE_AFTER_HOURS,
  autoDisableReason,
  hasBeenOpenLongEnough,
} from './auto-disable-policy';
import { BOOTSTRAP_ADVISORY_LOCK_KEY } from '../cli/bootstrap';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function openedHoursAgo(hours: number) {
  return {
    openedAt: new Date(NOW.getTime() - hours * 3_600_000),
    consecutiveFailures: 5,
    lastSuccessAt: new Date('2026-09-06T04:00:00.000Z'),
  };
}

describe('hasBeenOpenLongEnough', () => {
  it('does not disable an endpoint that has been open for less than the window', () => {
    expect(hasBeenOpenLongEnough(openedHoursAgo(71), NOW, 72)).toBe(false);
  });

  it('disables one that has been open for exactly the window, and longer', () => {
    expect(hasBeenOpenLongEnough(openedHoursAgo(72), NOW, 72)).toBe(true);
    expect(hasBeenOpenLongEnough(openedHoursAgo(500), NOW, 72)).toBe(true);
  });

  /**
   * `opened_at` is cleared when the breaker closes, so a null here is a breaker
   * that is not open at all. Treating null as "infinitely old" would disable
   * every healthy endpoint whose health row exists, which is all of them.
   */
  it('never disables an endpoint whose breaker has no open timestamp', () => {
    expect(
      hasBeenOpenLongEnough(
        { openedAt: null, consecutiveFailures: 99, lastSuccessAt: null },
        NOW,
        72,
      ),
    ).toBe(false);
  });

  /**
   * The default has to sit above a delivery's own wall-clock budget
   * (`max_retry_duration`, 24h) or an endpoint gets switched off - and its
   * queued deliveries cancelled - while they are still legitimately being
   * retried. It also has to clear a weekend.
   */
  it('defaults to a window past the retry budget and past a weekend', () => {
    expect(DEFAULT_AUTO_DISABLE_AFTER_HOURS).toBeGreaterThan(24);
    expect(DEFAULT_AUTO_DISABLE_AFTER_HOURS).toBeGreaterThanOrEqual(64);
  });
});

describe('autoDisableReason', () => {
  it('starts with the stable prefix and carries the evidence and the remedy', () => {
    const reason = autoDisableReason(openedHoursAgo(75), NOW);
    expect(reason.startsWith(AUTO_DISABLE_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('3d 3h');
    expect(reason).toContain('5 consecutive failures');
    expect(reason).toContain('2026-09-06T04:00:00.000Z');
    // A customer reading this in the dashboard must be able to act on it
    // without opening a ticket.
    expect(reason).toContain('Re-enable');
  });

  it('says so plainly when the endpoint has never succeeded', () => {
    const reason = autoDisableReason(
      { openedAt: new Date(NOW.getTime() - 96 * 3_600_000), consecutiveFailures: 5, lastSuccessAt: null },
      NOW,
    );
    expect(reason).toContain('last successful delivery: never');
    expect(reason).toContain('4d');
  });
});

/**
 * Two advisory locks in one codebase that share a key would deadlock the
 * bootstrap behind a retention pass, or worse, let one proceed thinking it held
 * the other's.
 */
it('does not share an advisory lock key with the bootstrap guard', () => {
  expect(AUTO_DISABLE_ADVISORY_LOCK_KEY).not.toEqual(BOOTSTRAP_ADVISORY_LOCK_KEY);
});
