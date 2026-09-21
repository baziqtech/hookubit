import { describe, expect, it } from 'vitest';
import type { DeliverySeries, SeriesBucket } from '../../types/api';
import { layoutSeries, niceMax, settledRate } from './series-layout';

function bucket(start: string, counts: Partial<SeriesBucket> = {}): SeriesBucket {
  return {
    start,
    end: new Date(new Date(start).getTime() + 3_600_000).toISOString(),
    delivered_first_try: 0,
    delivered_after_retry: 0,
    failed: 0,
    in_flight: 0,
    cancelled: 0,
    ...counts,
  } as SeriesBucket;
}

function series(buckets: SeriesBucket[], bucketMs = 3_600_000): DeliverySeries {
  return {
    window: { hours: 24, from: buckets[0]?.start ?? '', to: '', previous_from: '', previous_to: '' },
    bucket: '1h',
    bucket_ms: bucketMs,
    leading_partial: false,
    buckets,
  } as unknown as DeliverySeries;
}

describe('niceMax', () => {
  it.each([
    [1, 1],
    [3, 5],
    [37, 50],
    [210, 500],
    [1000, 1000],
    [1001, 2000],
  ])('rounds %p up to %p', (input, expected) => {
    expect(niceMax(input)).toBe(expected);
  });

  it('never returns zero, so a bar can never be divided by nothing', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });
});

describe('layoutSeries', () => {
  it('stacks the three bands plus in-flight, and keeps them disjoint', () => {
    const chart = layoutSeries(
      series([
        bucket('2026-09-21T10:00:00.000Z', {
          delivered_first_try: 80,
          delivered_after_retry: 15,
          failed: 5,
          in_flight: 0,
        }),
      ]),
    );

    expect(chart.bars[0].total).toBe(100);
    expect(chart.bars[0].segments.map((s) => s.key)).toEqual([
      'delivered_first_try',
      'delivered_after_retry',
      'failed',
    ]);
    // The fractions are shares of the AXIS, not of the bar, so they sum to
    // total/max rather than to 1 — that is what makes two bars comparable.
    const summed = chart.bars[0].segments.reduce((total, s) => total + s.fraction, 0);
    expect(summed).toBeCloseTo(100 / chart.max);
  });

  it('counts in_flight into the bar so the newest bucket is not a cliff', () => {
    const chart = layoutSeries(
      series([bucket('2026-09-21T10:00:00.000Z', { delivered_first_try: 10, in_flight: 90 })]),
    );
    expect(chart.bars[0].total).toBe(100);
    expect(chart.totals.in_flight).toBe(90);
  });

  it('an empty window is a flat chart with a readable axis, not a blank one', () => {
    // "Nothing was delivered" and "the chart failed to load" must not look the
    // same, so the axis still exists and still reads 0 at the bottom.
    const chart = layoutSeries(series([bucket('2026-09-21T10:00:00.000Z')]));
    expect(chart.max).toBe(1);
    expect(chart.bars[0].empty).toBe(true);
    expect(chart.bars[0].segments).toEqual([]);
    expect(chart.ticks[chart.ticks.length - 1]).toBe(0);
  });

  it('rounds the axis up rather than fitting it to the tallest bar', () => {
    const chart = layoutSeries(
      series([
        bucket('2026-09-21T10:00:00.000Z', { delivered_first_try: 37 }),
        bucket('2026-09-21T11:00:00.000Z', { delivered_first_try: 12 }),
      ]),
    );
    // Two screenshots an hour apart have to be drawn to the same scale, or the
    // only comparison anyone actually makes is a wrong one.
    expect(chart.max).toBe(50);
    expect(chart.ticks).toEqual([50, 33, 17, 0]);
  });

  it('always labels the newest bucket, and thins the rest', () => {
    const buckets = Array.from({ length: 24 }, (_, index) =>
      bucket(new Date(Date.UTC(2026, 8, 21, index)).toISOString()),
    );
    const chart = layoutSeries(series(buckets));

    expect(chart.xLabels.has(23)).toBe(true);
    expect(chart.xLabels.size).toBeLessThanOrEqual(8);
  });

  it('ignores a negative or missing count rather than drawing it upwards', () => {
    const chart = layoutSeries(
      series([
        bucket('2026-09-21T10:00:00.000Z', {
          delivered_first_try: 10,
          failed: -3 as unknown as number,
        }),
      ]),
    );
    expect(chart.bars[0].total).toBe(10);
    expect(chart.bars[0].segments).toHaveLength(1);
  });
});

describe('settledRate', () => {
  it('is null when nothing settled, never zero', () => {
    // 0% means everything we tried failed — the loudest thing this chart can
    // say. An idle project must never be rendered as one.
    expect(
      settledRate({
        delivered_first_try: 0,
        delivered_after_retry: 0,
        failed: 0,
        in_flight: 40,
      }),
    ).toBeNull();
  });

  it('counts a retried delivery as delivered', () => {
    expect(
      settledRate({
        delivered_first_try: 90,
        delivered_after_retry: 9,
        failed: 1,
        in_flight: 500,
      }),
    ).toBeCloseTo(0.99);
  });
});
