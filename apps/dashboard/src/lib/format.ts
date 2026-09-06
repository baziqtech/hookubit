/** Display formatting. Pure, so it is testable and never touches the clock implicitly. */

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.348],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago" / "in 42 seconds". `now` is injected so tests are deterministic. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  let delta = (then - now.getTime()) / 1000;
  for (const [unit, step] of RELATIVE_UNITS) {
    if (Math.abs(delta) < step) return relative.format(Math.round(delta), unit);
    delta /= step;
  }
  return relative.format(Math.round(delta), 'year');
}

const absolute = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

/** Absolute UTC timestamp — what you paste into a support thread. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${absolute.format(date)} UTC`;
}

/** Latency, at the precision the number actually deserves. */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plainNumber = new Intl.NumberFormat('en');

export function formatCount(value: number): string {
  return value < 10_000 ? plainNumber.format(value) : compact.format(value);
}

/** 0–1 → "99.4%". Percentages in an ops surface should not round away a bad number. */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Long opaque IDs are unreadable in a table; keep the discriminating tail. */
export function truncateId(id: string, tail = 8): string {
  const [prefix, rest] = splitPrefix(id);
  if (!rest || rest.length <= tail) return id;
  return `${prefix}…${rest.slice(-tail)}`;
}

function splitPrefix(id: string): [string, string] {
  const index = id.indexOf('_');
  return index === -1 ? ['', id] : [id.slice(0, index + 1), id.slice(index + 1)];
}
