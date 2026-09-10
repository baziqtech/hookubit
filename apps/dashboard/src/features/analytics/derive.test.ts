import { describe, expect, it } from 'vitest';
import {
  fanOutRatio,
  formatCountDelta,
  formatRate,
  formatRateDelta,
  formatRatio,
  rateTone,
  share,
} from './derive';

/**
 * `success_rate` is NULL, never 0, when nothing settled. The DTO says so in
 * capitals; these tests are what stop a page from undoing it. If a null ever
 * renders as "0.00%", an idle project reads as a total outage.
 */
describe('formatRate', () => {
  it('never renders a null rate as 0%', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(null)).not.toMatch(/%/);
  });

  it('renders a real zero as the alarming number it is', () => {
    expect(formatRate(0)).toBe('0.00%');
  });

  it('keeps two decimals so a bad number is not rounded away', () => {
    expect(formatRate(0.9987)).toBe('99.87%');
  });
});

describe('formatRateDelta', () => {
  it('says "no comparison" for null rather than a signed zero', () => {
    expect(formatRateDelta(null)).toBe('no comparison');
  });

  it('is in percentage points, signed', () => {
    expect(formatRateDelta(0.0123)).toBe('+1.2 pts');
    expect(formatRateDelta(-0.05)).toBe('−5.0 pts');
    expect(formatRateDelta(0)).toBe('±0.0 pts');
  });
});

describe('formatCountDelta', () => {
  it('signs a change and names no change', () => {
    expect(formatCountDelta(12)).toBe('+12');
    expect(formatCountDelta(-1200)).toBe('−1,200');
    expect(formatCountDelta(0)).toBe('no change');
  });
});

describe('rateTone', () => {
  it('gives a null rate NO tone — an idle project is neither healthy nor broken', () => {
    expect(rateTone(null)).toBe('default');
  });

  it('is red below 90%, amber below 99%, green otherwise', () => {
    expect(rateTone(0.5)).toBe('danger');
    expect(rateTone(0.95)).toBe('warn');
    expect(rateTone(0.995)).toBe('ok');
    expect(rateTone(1)).toBe('ok');
  });
});

describe('fanOutRatio', () => {
  it('is deliveries per event', () => {
    expect(fanOutRatio(300, 100)).toBe(3);
    expect(formatRatio(fanOutRatio(300, 100))).toBe('3.00×');
  });

  it('is null with no events, and never divides by zero', () => {
    expect(fanOutRatio(0, 0)).toBeNull();
    expect(fanOutRatio(5, 0)).toBeNull();
    expect(formatRatio(null)).toBe('—');
  });

  it('is null until BOTH responses are in hand', () => {
    expect(fanOutRatio(undefined, 100)).toBeNull();
    expect(fanOutRatio(300, undefined)).toBeNull();
  });
});

describe('share', () => {
  it('is 0..1 and never NaN', () => {
    expect(share(0, 0)).toBe(0);
    expect(share(5, 0)).toBe(0);
    expect(share(1, 4)).toBe(0.25);
    expect(share(9, 4)).toBe(1);
  });
});
