/**
 * A three-function Prometheus text parser.
 *
 * The suite scrapes :9090 before and after a run and reports the DELTA, because
 * the counters are process-lifetime totals: `deliveries_completed_total` on a
 * data plane that has been up all afternoon says nothing about the last two
 * minutes. Only the difference does.
 *
 * The one that matters most here is queue_head_of_line_delay_seconds - how long
 * a delivery sat ready before a worker claimed it. internal/queue names it as
 * the measurement that decides whether the FIFO claim strategy should be
 * replaced by tenant_fair, so every run prints it.
 */

export function parsePrometheus(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = Number(line.slice(space + 1));
    if (!Number.isFinite(value)) continue;
    out.set(key, value);
  }
  return out;
}

export async function scrape(metricsUrl) {
  const res = await fetch(`${metricsUrl.replace(/\/$/, '')}/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`metrics endpoint answered ${res.status}`);
  return parsePrometheus(await res.text());
}

/** Sum every series whose name matches, optionally filtered by a label substring. */
export function sumSeries(sample, name, labelContains) {
  let total = 0;
  for (const [key, value] of sample) {
    if (!key.startsWith(name)) continue;
    if (key.length > name.length && key[name.length] !== '{') continue;
    if (labelContains && !key.includes(labelContains)) continue;
    total += value;
  }
  return total;
}

/** Per-label breakdown, e.g. deliveries_completed_total by outcome. */
export function byLabel(sample, name, label) {
  const out = {};
  const re = new RegExp(`${label}="([^"]*)"`);
  for (const [key, value] of sample) {
    if (!key.startsWith(`${name}{`)) continue;
    const m = re.exec(key);
    if (m) out[m[1]] = (out[m[1]] ?? 0) + value;
  }
  return out;
}

export function delta(before, after, name, labelContains) {
  return sumSeries(after, name, labelContains) - sumSeries(before, name, labelContains);
}

export function deltaByLabel(before, after, name, label) {
  const a = byLabel(after, name, label);
  const b = byLabel(before, name, label);
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (a[key] ?? 0) - (b[key] ?? 0);
    if (d !== 0) out[key] = d;
  }
  return out;
}

/** Mean of a histogram over the window: delta(sum) / delta(count). */
export function histogramMean(before, after, name) {
  const sumDelta = sumSeries(after, `${name}_sum`) - sumSeries(before, `${name}_sum`);
  const countDelta = sumSeries(after, `${name}_count`) - sumSeries(before, `${name}_count`);
  if (countDelta <= 0) return null;
  return sumDelta / countDelta;
}
