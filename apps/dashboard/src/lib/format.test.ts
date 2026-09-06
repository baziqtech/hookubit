import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
  truncateId,
} from './format';

const NOW = new Date('2026-09-06T14:00:00.000Z');

describe('formatRelativeTime', () => {
  it('is relative to the injected clock, not the wall clock', () => {
    expect(formatRelativeTime('2026-09-06T13:57:00.000Z', NOW)).toBe('3 minutes ago');
    expect(formatRelativeTime('2026-09-06T16:00:00.000Z', NOW)).toBe('in 2 hours');
  });

  it('does not throw on an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });
});

describe('formatTimestamp', () => {
  it('renders UTC so two people reading it agree', () => {
    expect(formatTimestamp('2026-09-06T14:00:00.000Z')).toContain('UTC');
  });

  it('handles a null completion time', () => {
    expect(formatTimestamp(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(0.4)).toBe('<1ms');
    expect(formatDuration(240)).toBe('240ms');
    expect(formatDuration(1_500)).toBe('1.50s');
    expect(formatDuration(30_000)).toBe('30.0s');
    expect(formatDuration(95_000)).toBe('1m 35s');
  });
});

describe('formatBytes', () => {
  it('formats payload sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatCount and formatPercent', () => {
  it('keeps small counts exact and compacts large ones', () => {
    expect(formatCount(942)).toBe('942');
    expect(formatCount(1_284_930)).toBe('1.3M');
  });

  it('does not round a bad success rate up to 100%', () => {
    expect(formatPercent(0.9994, 2)).toBe('99.94%');
  });
});

describe('truncateId', () => {
  it('keeps the prefix and the discriminating tail', () => {
    expect(truncateId('del_01JQABCDEFGHIJKLMNOP')).toBe('del_…IJKLMNOP');
  });

  it('leaves short ids alone', () => {
    expect(truncateId('evt_123')).toBe('evt_123');
  });
});
