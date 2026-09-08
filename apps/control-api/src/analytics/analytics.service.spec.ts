import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import {
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  resolveWindow,
} from './analytics-window';
import { ANALYTICS, EXPECTED, NOW, analyticsHarness } from './testing/harness';

const HOUR = 3_600_000;

/**
 * The numbers, asserted as exact integers against a fixture whose counts are
 * written down by hand in `EXPECTED`.
 *
 * A shape assertion would pass on a response that returned the whole
 * platform's totals. Every count here has decoys sitting one step outside it -
 * the previous window, rows older than both, a sibling project, another
 * organization - so an off-by-a-predicate is a failed assertion with a number
 * attached, not a green test.
 */
describe('AnalyticsService', () => {
  describe('the window', () => {
    it('defaults to 24 hours and ends now', () => {
      const window = resolveWindow(undefined, NOW);
      expect(window.hours).toBe(DEFAULT_WINDOW_HOURS);
      expect(window.to).toEqual(NOW);
      expect(window.from).toEqual(new Date(NOW.getTime() - 24 * HOUR));
    });

    it('puts the comparison window immediately before, same length, no overlap', () => {
      const window = resolveWindow(24, NOW);
      expect(window.previousTo).toEqual(window.from);
      expect(window.previousFrom).toEqual(new Date(NOW.getTime() - 48 * HOUR));
      expect(window.to.getTime() - window.from.getTime()).toBe(
        window.previousTo.getTime() - window.previousFrom.getTime(),
      );
    });

    it('accepts the ceiling exactly', () => {
      expect(resolveWindow(MAX_WINDOW_HOURS, NOW).hours).toBe(MAX_WINDOW_HOURS);
    });

    it('REFUSES one hour past the ceiling rather than clamping', () => {
      // The whole point: a clamped response would be labelled with a period the
      // caller did not ask about.
      expect(() => resolveWindow(MAX_WINDOW_HOURS + 1, NOW)).toThrow(AppError);
      try {
        resolveWindow(MAX_WINDOW_HOURS + 1, NOW);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('invalid_request');
        expect((err as AppError).message).toContain(String(MAX_WINDOW_HOURS));
      }
    });

    it.each([0, -1, 1.5])('refuses %p', (hours) => {
      expect(() => resolveWindow(hours, NOW)).toThrow(AppError);
    });
  });

  describe('delivery outcomes', () => {
    it('counts every status exactly, and nothing outside the window', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.deliveryOutcomes(context, {}, NOW);

      expect(result.current.by_status).toEqual({
        pending: 0,
        scheduled: 0,
        queued: 0,
        processing: 0,
        succeeded: EXPECTED.window.succeeded,
        failed: EXPECTED.window.failed,
        retrying: EXPECTED.window.retrying,
        exhausted: EXPECTED.window.exhausted,
        cancelled: 0,
      });
      expect(result.current.total).toBe(EXPECTED.window.total);
      expect(result.current.failing).toBe(EXPECTED.window.failing);
      expect(result.current.in_flight).toBe(EXPECTED.window.inFlight);
      expect(result.current.success_rate).toBe(EXPECTED.window.successRate);
    });

    it('reports the preceding window and the deltas, so "worse?" is answerable', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.deliveryOutcomes(context, {}, NOW);

      expect(result.previous.total).toBe(EXPECTED.previous.total);
      expect(result.previous.succeeded).toBe(EXPECTED.previous.succeeded);
      expect(result.previous.success_rate).toBe(EXPECTED.previous.successRate);
      expect(result.total_delta).toBe(EXPECTED.window.total - EXPECTED.previous.total);
      // 0.5 - 0.8. Negative means worse, which is the direction that matters.
      expect(result.success_rate_delta).toBe(-0.3);
    });

    it('echoes the window it actually used', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.deliveryOutcomes(context, { window_hours: 48 }, NOW);
      expect(result.window.hours).toBe(48);
      expect(result.window.to).toBe(NOW.toISOString());
      expect(result.window.from).toBe(new Date(NOW.getTime() - 48 * HOUR).toISOString());
    });

    it('a wider window picks up the rows the default excluded', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.deliveryOutcomes(context, { window_hours: 48 }, NOW);
      expect(result.current.total).toBe(EXPECTED.window.total + EXPECTED.previous.total);
    });

    it('a project with nothing in it is zeroes, not an error', async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerA, {
        orgId: IDS.orgA,
        projectId: ANALYTICS.projectEmpty,
      });
      const result = await analytics.deliveryOutcomes(context, {}, NOW);

      expect(result.current.total).toBe(0);
      expect(result.current.by_status.succeeded).toBe(0);
      // NULL, not 0. Zero would read as "everything failed".
      expect(result.current.success_rate).toBeNull();
      expect(result.success_rate_delta).toBeNull();
      expect(result.total_delta).toBe(0);
    });

    it("never counts another organization's deliveries", async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerB, {
        orgId: IDS.orgB,
        projectId: IDS.projectB1,
      });
      const result = await analytics.deliveryOutcomes(context, {}, NOW);

      // Organization B has exactly the nine exhausted deliveries the fixture
      // gave it, and none of A's twenty-one.
      expect(result.current.total).toBe(9);
      expect(result.current.by_status.exhausted).toBe(9);
      expect(result.current.by_status.succeeded).toBe(0);
    });

    it("never counts a sibling project's deliveries", async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerA, {
        orgId: IDS.orgA,
        projectId: IDS.projectA2,
      });
      const result = await analytics.deliveryOutcomes(context, {}, NOW);
      expect(result.current.total).toBe(6);
      expect(result.current.by_status.failed).toBe(6);
    });
  });

  describe('failing endpoints', () => {
    it('ranks worst first, with the per-status split and a rate', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.failingEndpoints(context, {}, NOW);

      expect(result.data.map((row) => row.endpoint_id)).toEqual([
        ANALYTICS.endpointPayments,
        ANALYTICS.endpointLedger,
        ANALYTICS.endpointQuiet,
      ]);

      const [worst] = result.data;
      expect(worst.failing).toBe(7);
      expect(worst.failed).toBe(4);
      expect(worst.exhausted).toBe(3);
      expect(worst.retrying).toBe(1);
      expect(worst.total).toBe(10);
      expect(worst.failure_rate).toBe(0.7);
      expect(worst.name).toBe(ANALYTICS.endpointPayments);
      expect(worst.url).toContain('https://');
      expect(worst.status).toBe('active');
      expect(worst.enabled).toBe(true);
    });

    it('honours the limit and says the list is not the whole set', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.failingEndpoints(context, { limit: 1 }, NOW);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].endpoint_id).toBe(ANALYTICS.endpointPayments);
      expect(result.has_more).toBe(true);
    });

    it('an empty project ranks nothing and does not error', async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerA, {
        orgId: IDS.orgA,
        projectId: ANALYTICS.projectEmpty,
      });
      const result = await analytics.failingEndpoints(context, {}, NOW);
      expect(result.data).toEqual([]);
      expect(result.has_more).toBe(false);
    });

    it("never ranks another tenant's endpoint, however badly it is failing", async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.failingEndpoints(context, {}, NOW);
      const ids = result.data.map((row) => row.endpoint_id);
      // Six failures in the window, on an endpoint in the sibling project. It
      // would rank second if the predicate were only on the window.
      expect(ids).not.toContain(ANALYTICS.endpointOtherProject);
      expect(ids).not.toContain(IDS.endpointB1);
    });
  });

  describe('attempt latency', () => {
    it('computes nearest-rank percentiles over the measured attempts', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.attemptLatency(context, {}, NOW);

      expect(result.sample_size).toBe(EXPECTED.latency.sampleSize);
      expect(result.p50_ms).toBe(EXPECTED.latency.p50);
      expect(result.p95_ms).toBe(EXPECTED.latency.p95);
      expect(result.p99_ms).toBe(EXPECTED.latency.p99);
      expect(result.min_ms).toBe(EXPECTED.latency.min);
      expect(result.max_ms).toBe(EXPECTED.latency.max);
      // Small fixture: the sample IS the window, so the numbers are exact.
      expect(result.exact).toBe(true);
      expect(result.sampled_deliveries).toBe(EXPECTED.window.total);
    });

    it('excludes attempts outside the window and attempts of other tenants', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.attemptLatency(context, {}, NOW);
      // The decoys are 5_000 (previous window), 7_000 (ancient), 8_888 (sibling
      // project), 9_999 (organization B) and 99_999 (seedWorld). Any of them
      // reaching the sample moves max_ms.
      expect(result.max_ms).toBe(EXPECTED.latency.max);
      expect(result.sample_size).toBe(EXPECTED.latency.sampleSize);
    });

    it('an unmeasured attempt is not a zero-millisecond attempt', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.attemptLatency(context, {}, NOW);
      // The fixture has one attempt with duration_ms NULL. Counting it as 0
      // would drag p50 down and make an outage look like an improvement.
      expect(result.min_ms).toBe(EXPECTED.latency.min);
      expect(result.sample_size).toBe(EXPECTED.latency.sampleSize);
    });

    it('an empty project is nulls and a zero sample, not an error', async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerA, {
        orgId: IDS.orgA,
        projectId: ANALYTICS.projectEmpty,
      });
      const result = await analytics.attemptLatency(context, {}, NOW);
      expect(result).toMatchObject({
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        min_ms: null,
        max_ms: null,
        sample_size: 0,
        sampled_deliveries: 0,
        exact: true,
      });
    });
  });

  describe('event volume', () => {
    it('counts events in the window and the one before it', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.eventVolume(context, {}, NOW);

      expect(result.total).toBe(EXPECTED.events.total);
      expect(result.previous_total).toBe(EXPECTED.events.previousTotal);
      expect(result.total_delta).toBe(
        EXPECTED.events.total - EXPECTED.events.previousTotal,
      );
    });

    it('ranks event types busiest first', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.eventVolume(context, {}, NOW);
      expect(result.by_type).toEqual(EXPECTED.events.byType);
      expect(result.has_more).toBe(false);
    });

    it('honours the limit', async () => {
      const { context, analytics } = await analyticsHarness();
      const result = await analytics.eventVolume(context, { limit: 2 }, NOW);
      expect(result.by_type).toEqual(EXPECTED.events.byType.slice(0, 2));
      expect(result.has_more).toBe(true);
    });

    it("never counts another tenant's events", async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerB, {
        orgId: IDS.orgB,
        projectId: IDS.projectB1,
      });
      const result = await analytics.eventVolume(context, {}, NOW);
      // Five, the number seeded for organization B - not the twelve in A.
      expect(result.total).toBe(5);
    });

    it('an empty project is zero, not an error', async () => {
      const { context, analytics } = await analyticsHarness(IDS.ownerA, {
        orgId: IDS.orgA,
        projectId: ANALYTICS.projectEmpty,
      });
      const result = await analytics.eventVolume(context, {}, NOW);
      expect(result).toMatchObject({ total: 0, previous_total: 0, total_delta: 0, by_type: [] });
    });
  });
});
