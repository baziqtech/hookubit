/**
 * The end-of-run report.
 *
 * k6's default summary is a wall of numbers a human has to interpret. This one
 * leads with the thresholds - the architectural claims the scenario was written
 * to test - says PASS or FAIL for each, and only then prints the numbers behind
 * them. It also writes the whole summary as JSON so the runner can hand it to
 * the verification step.
 */

const PAD = 46;

function fmt(n) {
  if (n === undefined || n === null) return '-';
  if (n >= 10000) return `${Math.round(n)}`;
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(3);
}

function line(label, value) {
  return `  ${String(label).padEnd(PAD)} ${value}`;
}

export function renderSummary(data, title) {
  const out = [];
  const failures = [];

  out.push('');
  out.push(`  ${title}`);
  out.push('  ' + '-'.repeat(PAD + 20));
  out.push('');
  out.push('  THRESHOLDS');

  const names = Object.keys(data.metrics).sort();
  let any = false;
  for (const name of names) {
    const m = data.metrics[name];
    if (!m.thresholds) continue;
    for (const [expr, result] of Object.entries(m.thresholds)) {
      any = true;
      const ok = result.ok !== false;
      if (!ok) failures.push(`${name} ${expr}`);
      out.push(line(`${ok ? 'PASS' : 'FAIL'}  ${name} ${expr}`, actual(m, expr)));
    }
  }
  if (!any) out.push('  (none declared)');

  out.push('');
  out.push('  INGEST');
  const il = data.metrics.ingest_latency_ms;
  if (il) {
    out.push(line('accepted', fmt(data.metrics.ingest_accepted?.values?.count)));
    out.push(line('rate limited (429)', fmt(data.metrics.ingest_rate_limited?.values?.count ?? 0)));
    out.push(line('error rate', fmt(data.metrics.ingest_errors?.values?.rate ?? 0)));
    out.push(
      line(
        'latency ms  p50 / p95 / p99 / max',
        `${fmt(il.values['p(50)'])} / ${fmt(il.values['p(95)'])} / ${fmt(il.values['p(99)'])} / ${fmt(il.values.max)}`,
      ),
    );
  }

  out.push('');
  out.push('  DELIVERY (measured at the sink, first attempts only)');
  const groups = new Set();
  for (const name of names) {
    const m = /^delivery_latency_ms\{group:([^}]+)\}$/.exec(name);
    if (m) groups.add(m[1]);
  }
  if (groups.size === 0) {
    const dl = data.metrics.delivery_latency_ms;
    if (dl && dl.values.count) {
      out.push(
        line(
          'all groups  p50 / p95 / p99 / max',
          `${fmt(dl.values['p(50)'])} / ${fmt(dl.values['p(95)'])} / ${fmt(dl.values['p(99)'])} / ${fmt(dl.values.max)}`,
        ),
      );
    } else {
      out.push('  NOTHING WAS DELIVERED. Ingest numbers above are meaningless.');
    }
  }
  for (const g of [...groups].sort()) {
    const m = data.metrics[`delivery_latency_ms{group:${g}}`];
    const c = data.metrics[`deliveries_received{group:${g}}`];
    out.push(
      line(
        `${g}  n / p50 / p95 / p99 / max`,
        `${fmt(c?.values?.count ?? 0)} / ${fmt(m.values['p(50)'])} / ${fmt(m.values['p(95)'])} / ${fmt(m.values['p(99)'])} / ${fmt(m.values.max)}`,
      ),
    );
  }

  out.push('');
  if (failures.length === 0) {
    out.push('  RESULT: all thresholds met.');
  } else {
    out.push(`  RESULT: ${failures.length} threshold(s) FAILED:`);
    for (const f of failures) out.push(`    - ${f}`);
  }
  out.push('');
  out.push('  Ingest is only half the test. The delivery ledger is checked next.');
  out.push('');
  return out.join('\n');
}

function actual(metric, expr) {
  const v = metric.values || {};
  const p = /p\((\d+(?:\.\d+)?)\)/.exec(expr);
  if (p) return fmt(v[`p(${p[1]})`]);
  if (expr.startsWith('rate')) return fmt(v.rate);
  if (expr.startsWith('count')) return fmt(v.count);
  if (expr.startsWith('avg')) return fmt(v.avg);
  if (expr.startsWith('max')) return fmt(v.max);
  if (expr.startsWith('min')) return fmt(v.min);
  return fmt(v.count ?? v.rate ?? v.value);
}

/** Use as: export function handleSummary(data) { return summary(data, 'title'); } */
export function summary(data, title) {
  const out = { stdout: renderSummary(data, title) };
  if (__ENV.LOAD_SUMMARY) out[__ENV.LOAD_SUMMARY] = JSON.stringify(data, null, 2);
  return out;
}
