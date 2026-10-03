import { AppError } from '../common/errors';
import { resolveWindow } from './analytics-window';
import { BUCKET_WIDTHS, MAX_BUCKETS, defaultBucket, planSeries } from './delivery-series';

const HOUR = 3_600_000;

/**
 * Bucketing, with no database anywhere near it.
 *
 * This is where the chart's correctness actually lives. Everything the service
 * does afterwards is counting rows inside ranges these functions produced, so a
 * bucket that is misaligned, overlapping or short is a wrong chart no amount of
 * correct counting can rescue.
 */
describe('delivery series buckets', () => {
  /** A clock deliberately NOT on a boundary: 14:37:22.481 UTC. */
  const NOW = new Date('2026-09-21T14:37:22.481Z');

  describe('choosing a width', () => {
    it.each([
      [1, '5m'],
      [24, '1h'],
      [168, '6h'],
      [720, '1d'],
    ])('a %p-hour window defaults to %p buckets', (hours, unit) => {
      expect(defaultBucket(hours)).toBe(unit);
    });

    it('never defaults to a width that would exceed the ceiling', () => {
      for (let hours = 1; hours <= 720; hours += 1) {
        const width = BUCKET_WIDTHS[defaultBucket(hours)];
        expect(Math.ceil((hours * HOUR) / width)).toBeLessThanOrEqual(MAX_BUCKETS);
      }
    });
  });

  describe('alignment', () => {
    it('cuts on the wall clock, not on the moment the page was opened', () => {
      const plan = planSeries(resolveWindow(24, NOW), '1h');
      for (const bucket of plan.buckets) {
        expect(bucket.start.getTime() % HOUR).toBe(0);
      }
      // The newest bucket is the one CONTAINING now, so the rightmost bar is
      // the one still filling rather than one that closed 37 minutes ago.
      const last = plan.buckets[plan.buckets.length - 1];
      expect(last.start).toEqual(new Date('2026-09-21T14:00:00.000Z'));
      expect(last.end).toEqual(new Date('2026-09-21T15:00:00.000Z'));
    });

    it('is contiguous: every bucket ends exactly where the next begins', () => {
      const plan = planSeries(resolveWindow(168, NOW), '6h');
      for (let index = 1; index < plan.buckets.length; index += 1) {
        expect(plan.buckets[index].start).toEqual(plan.buckets[index - 1].end);
      }
    });

    it('every bucket is exactly one width wide', () => {
      const plan = planSeries(resolveWindow(24, NOW), '1h');
      for (const bucket of plan.buckets) {
        expect(bucket.end.getTime() - bucket.start.getTime()).toBe(plan.widthMs);
      }
    });

    it('declares the leading partial rather than hiding it', () => {
      // 14:37 back 24 hours is 14:37 yesterday, which is inside the 14:00
      // bucket — so the oldest bar covers 23 minutes the window did not ask
      // for, and would otherwise read as a traffic dip that moves hourly.
      const plan = planSeries(resolveWindow(24, NOW), '1h');
      expect(plan.leadingPartial).toBe(true);

      const onBoundary = planSeries(
        resolveWindow(24, new Date('2026-09-21T14:00:00.000Z')),
        '1h',
      );
      expect(onBoundary.leadingPartial).toBe(false);
    });

    it('covers the whole window', () => {
      const window = resolveWindow(24, NOW);
      const plan = planSeries(window, '1h');
      expect(plan.buckets[0].start.getTime()).toBeLessThanOrEqual(window.from.getTime());
      expect(plan.buckets[plan.buckets.length - 1].end.getTime()).toBeGreaterThanOrEqual(
        window.to.getTime(),
      );
    });
  });

  describe('the ceiling', () => {
    it('accepts the widest chart the product draws, unaligned clock and all', () => {
      // 30 daily bars across 30 days, plus the one an unaligned clock adds.
      expect(planSeries(resolveWindow(720, NOW), '1d').buckets).toHaveLength(31);
      expect(31).toBeLessThanOrEqual(MAX_BUCKETS);
    });

    it('REFUSES a finer bucket rather than silently coarsening it', () => {
      // 30 days of hourly buckets is 720 queries. Answering with 30 daily ones
      // would be a different chart wearing the requested chart's label, and the
      // person reading it is looking for a spike at 3am.
      expect(() => planSeries(resolveWindow(720, NOW), '1h')).toThrow(AppError);
      expect(() => planSeries(resolveWindow(720, NOW), '12h')).toThrow(AppError);
      try {
        planSeries(resolveWindow(720, NOW), '1h');
      } catch (err) {
        expect((err as AppError).code).toBe('invalid_request');
        // It names a bucket that WOULD fit, so the refusal is actionable.
        expect((err as AppError).message).toContain("'1d'");
      }
    });
  });
});
