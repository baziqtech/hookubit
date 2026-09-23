#!/usr/bin/env node
/**
 * The ledger check. This is the half of the load test that matters.
 *
 * k6 measures ingest, and ingest is the easy half: a 202 means the event is
 * durably persisted, nothing more. The thing under test is DELIVERY, and the
 * only authority on delivery is the `deliveries` table - written before any
 * attempt is made, which is exactly what makes it the record of what should
 * have happened.
 *
 * So after every run this asks PostgreSQL:
 *   - did every accepted event get routed (outbox drained)?
 *   - did routing materialise the number of rows the subscriptions imply?
 *   - did those rows reach a terminal state, and which one?
 *   - what did delivery actually cost, per endpoint group?
 *   - is anything wedged - leased by a worker that never came back, or retrying
 *     with no next attempt scheduled?
 *
 * A run where ingest was fast and nothing was delivered exits non-zero here.
 *
 * Usage:
 *   node tests/load/scripts/verify.mjs <scenario> [--since <ISO8601>] [--json <file>]
 */

import fs from 'node:fs';
import { SCENARIOS, c, config, manifestPath } from './support/env.mjs';
import { disconnect, prisma } from './support/api.mjs';

const ID = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * What each scenario is entitled to claim afterwards.
 *
 * `terminal` is deliberately not 1.0 everywhere. A slow endpoint at 5 seconds
 * with a bounded per-endpoint concurrency is throughput-bound by design, and a
 * failing endpoint whose breaker has opened is CORRECTLY not being attempted.
 * Demanding 100% terminal from those would be demanding the platform ignore its
 * own protections.
 */
const EXPECTATIONS = {
  wide: {
    groups: {
      wide: { minTerminal: 0.99, minSucceeded: 0.99, maxLatencyP95Ms: 15000 },
    },
    exactDeliveryCount: true,
  },
  'slow-endpoints': {
    groups: {
      // The isolation claim, restated against the ledger rather than the sink.
      fast: { minTerminal: 0.99, minSucceeded: 0.99, maxLatencyP95Ms: 5000 },
      slow: { minTerminal: 0.2, minSucceeded: 0.2 },
    },
    exactDeliveryCount: true,
  },
  'failing-endpoints': {
    groups: {
      fast: { minTerminal: 0.99, minSucceeded: 0.99, maxLatencyP95Ms: 5000 },
      failing: { minAttemptsPerDelivery: 1, expectRetries: true, expectBreakerOpen: true },
      throttled: { minAttemptsPerDelivery: 1 },
      timeout: { minAttemptsPerDelivery: 1 },
    },
    exactDeliveryCount: true,
  },
  'many-tenants': {
    groups: {
      quiet: { minTerminal: 0.99, minSucceeded: 0.99, maxLatencyP95Ms: 5000 },
      noisy: { minTerminal: 0.2 },
    },
    exactDeliveryCount: true,
  },
  'large-payloads': {
    groups: {
      large: { minTerminal: 0.99, minSucceeded: 0.99, maxLatencyP95Ms: 20000 },
    },
    exactDeliveryCount: true,
    requireOffload: true,
  },
};

function idList(ids) {
  for (const id of ids) if (!ID.test(id)) throw new Error(`refusing to interpolate id: ${id}`);
  return ids.map((id) => `'${id}'`).join(',');
}

async function gather(scenario, since) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(scenario), 'utf8'));
  const db = prisma();
  const projectIds = manifest.projects.map((p) => p.id);
  const projects = idList(projectIds);
  const sinceIso = since.toISOString();

  const endpointGroup = new Map();
  for (const p of manifest.projects) for (const e of p.endpoints) endpointGroup.set(e.id, e.group);

  const events = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE payload_location IS NOT NULL)::int AS offloaded,
            coalesce(sum(payload_size), 0)::bigint AS bytes,
            min(created_at) AS first_at,
            max(created_at) AS last_at
       FROM events
      WHERE project_id IN (${projects}) AND created_at >= $1`,
    since,
  );

  const outbox = await db.$queryRawUnsafe(
    `SELECT o.status, count(*)::int AS n
       FROM event_outbox o JOIN events e ON e.id = o.event_id
      WHERE e.project_id IN (${projects}) AND e.created_at >= $1
      GROUP BY 1`,
    since,
  );

  const byStatus = await db.$queryRawUnsafe(
    `SELECT d.endpoint_id, d.status, count(*)::int AS n
       FROM deliveries d
      WHERE d.project_id IN (${projects}) AND d.created_at >= $1
      GROUP BY 1, 2`,
    since,
  );

  const latency = await db.$queryRawUnsafe(
    `SELECT d.endpoint_id,
            count(*)::int AS n,
            percentile_cont(0.50) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (d.completed_at - e.created_at)) * 1000) AS p50,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (d.completed_at - e.created_at)) * 1000) AS p95,
            max(EXTRACT(EPOCH FROM (d.completed_at - e.created_at)) * 1000) AS max
       FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.project_id IN (${projects}) AND d.created_at >= $1
        AND d.status = 'succeeded' AND d.completed_at IS NOT NULL
      GROUP BY 1`,
    since,
  );

  const attempts = await db.$queryRawUnsafe(
    `SELECT d.endpoint_id, a.status, count(*)::int AS n, max(a.attempt_number)::int AS max_attempt
       FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
      WHERE d.project_id IN (${projects}) AND d.created_at >= $1
      GROUP BY 1, 2`,
    since,
  );

  const health = await db.$queryRawUnsafe(
    `SELECT h.endpoint_id, h.state, h.consecutive_failures, h.opened_at
       FROM endpoint_health h
      WHERE h.endpoint_id IN (${idList([...endpointGroup.keys()])})`,
  );

  const disabled = await db.$queryRawUnsafe(
    `SELECT id, status, enabled, disabled_reason
       FROM endpoints
      WHERE id IN (${idList([...endpointGroup.keys()])}) AND (status <> 'active' OR enabled = false)`,
  );

  /**
   * Wedged deliveries. A lease whose deadline is long past belongs to a worker
   * that never came back; a retrying row with no next attempt scheduled will
   * never be claimed again. Either is data loss in slow motion, and neither is
   * visible from ingest metrics.
   */
  const wedged = await db.$queryRawUnsafe(
    `SELECT count(*) FILTER (
              WHERE locked_until IS NOT NULL AND locked_until < now() - interval '120 seconds'
            )::int AS expired_leases,
            count(*) FILTER (
              WHERE status IN ('retrying', 'scheduled', 'queued') AND next_attempt_at IS NULL
            )::int AS unscheduled
       FROM deliveries
      WHERE project_id IN (${projects}) AND created_at >= $1`,
    since,
  );

  return {
    manifest,
    since: sinceIso,
    endpointGroup,
    events: events[0],
    outbox,
    byStatus,
    latency,
    attempts,
    health,
    disabled,
    wedged: wedged[0],
  };
}

function rollUp(data) {
  const groups = new Map();
  const group = (name) => {
    if (!groups.has(name)) {
      groups.set(name, {
        deliveries: 0,
        byStatus: {},
        succeeded: 0,
        terminal: 0,
        attempts: 0,
        attemptsByStatus: {},
        maxAttempt: 0,
        latency: { n: 0, p50: null, p95: null, max: null },
        breakerOpen: 0,
        autoDisabled: 0,
      });
    }
    return groups.get(name);
  };

  const TERMINAL = new Set(['succeeded', 'failed', 'exhausted', 'cancelled']);

  for (const row of data.byStatus) {
    const g = group(data.endpointGroup.get(row.endpoint_id) ?? 'unknown');
    g.deliveries += row.n;
    g.byStatus[row.status] = (g.byStatus[row.status] ?? 0) + row.n;
    if (row.status === 'succeeded') g.succeeded += row.n;
    if (TERMINAL.has(row.status)) g.terminal += row.n;
  }
  for (const row of data.attempts) {
    const g = group(data.endpointGroup.get(row.endpoint_id) ?? 'unknown');
    g.attempts += row.n;
    g.attemptsByStatus[row.status] = (g.attemptsByStatus[row.status] ?? 0) + row.n;
    if (row.max_attempt > g.maxAttempt) g.maxAttempt = row.max_attempt;
  }
  // Percentiles are per endpoint; the group figure is the worst endpoint in it,
  // which is the honest summary - an average would hide the starved one.
  for (const row of data.latency) {
    const g = group(data.endpointGroup.get(row.endpoint_id) ?? 'unknown');
    g.latency.n += row.n;
    for (const k of ['p50', 'p95', 'max']) {
      const v = row[k] === null ? null : Number(row[k]);
      if (v !== null && (g.latency[k] === null || v > g.latency[k])) g.latency[k] = v;
    }
  }
  for (const row of data.health) {
    const g = group(data.endpointGroup.get(row.endpoint_id) ?? 'unknown');
    if (row.state === 'open' || row.state === 'half_open') g.breakerOpen += 1;
  }
  for (const row of data.disabled) {
    const g = group(data.endpointGroup.get(row.id) ?? 'unknown');
    if (row.disabled_reason) g.autoDisabled += 1;
  }
  return groups;
}

/**
 * How many delivery rows the subscriptions imply for the events published.
 *
 * PER PROJECT. An event published to tenant 3 routes to tenant 3's
 * subscriptions and to nobody else's - counting event types globally across a
 * multi-tenant scenario would expect every tenant to receive every other
 * tenant's events, which is the opposite of the property being tested.
 */
function expectedDeliveryCount(manifest, eventsByProjectType) {
  let expected = 0;
  for (const p of manifest.projects) {
    for (const sub of p.subscriptions) {
      for (const type of sub.event_types) {
        expected += eventsByProjectType.get(`${p.id}\u0000${type}`) ?? 0;
      }
    }
  }
  return expected;
}

async function main() {
  const args = process.argv.slice(2);
  const scenario = args.find((a) => !a.startsWith('--'));
  const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
  const jsonArg = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

  if (!SCENARIOS.includes(scenario)) {
    console.error(`usage: verify.mjs <${SCENARIOS.join('|')}> [--since ISO] [--json FILE]`);
    process.exit(2);
  }
  if (!fs.existsSync(manifestPath(scenario))) {
    console.error(`no manifest for ${scenario}; run the seed first`);
    process.exit(2);
  }

  // Default window: the last half hour. A bad --since is refused rather than
  // silently becoming Invalid Date, which PostgreSQL would reject with a
  // message about nothing in particular.
  let since = new Date(Date.now() - 30 * 60 * 1000);
  if (sinceArg && !sinceArg.startsWith('--')) {
    since = new Date(sinceArg);
    if (Number.isNaN(since.getTime())) {
      console.error(`--since ${sinceArg} is not a date`);
      process.exit(2);
    }
  }
  const data = await gather(scenario, since);
  const groups = rollUp(data);
  const expectations = EXPECTATIONS[scenario] ?? { groups: {} };

  const failures = [];
  const notes = [];

  console.log('');
  console.log(c.bold(`  LEDGER CHECK - ${scenario}`));
  console.log(`  ${'-'.repeat(66)}`);
  console.log(`  database   ${config.databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`  projects   ${data.manifest.projects.map((p) => p.slug).join(', ')}`);
  console.log(`  window     since ${data.since}`);
  console.log('');

  const ev = data.events;
  const totalEvents = Number(ev.total);
  console.log(`  events accepted            ${totalEvents}`);
  console.log(`  events offloaded to S3     ${Number(ev.offloaded)}`);
  console.log(`  payload bytes accepted     ${Number(ev.bytes).toLocaleString('en-US')}`);

  if (totalEvents === 0) {
    failures.push('no events were accepted in the window - the run published nothing');
  }

  const outboxPending = data.outbox
    .filter((r) => r.status !== 'processed')
    .reduce((n, r) => n + r.n, 0);
  console.log(
    `  outbox                     ${data.outbox.map((r) => `${r.status}=${r.n}`).join(' ') || 'empty'}`,
  );
  if (outboxPending > 0) {
    failures.push(
      `${outboxPending} outbox rows never reached 'processed' - the router did not drain`,
    );
  }

  const totalDeliveries = [...groups.values()].reduce((n, g) => n + g.deliveries, 0);
  console.log(`  delivery rows created      ${totalDeliveries}`);

  if (expectations.exactDeliveryCount && totalEvents > 0) {
    const db = prisma();
    const perType = await db.$queryRawUnsafe(
      `SELECT project_id, event_type, count(*)::int AS n
         FROM events
        WHERE project_id IN (${idList(data.manifest.projects.map((p) => p.id))})
          AND created_at >= $1
        GROUP BY 1, 2`,
      since,
    );
    const eventsByProjectType = new Map(
      perType.map((r) => [`${r.project_id}\u0000${r.event_type}`, r.n]),
    );
    const expected = expectedDeliveryCount(data.manifest, eventsByProjectType);
    console.log(`  deliveries expected        ${expected}`);
    if (totalDeliveries !== expected) {
      failures.push(
        `routing is wrong: ${totalDeliveries} delivery rows for ${expected} implied by the ` +
          'subscriptions. Materialised routing must produce exactly one row per matching ' +
          'subscription.',
      );
    }
  }

  if (expectations.requireOffload) {
    if (Number(ev.offloaded) !== totalEvents) {
      failures.push(
        `only ${Number(ev.offloaded)} of ${totalEvents} events were offloaded to object ` +
          'storage. The rest were stored inline, so the offload boundary was not exercised.',
      );
    }
  }

  console.log('');
  console.log(
    `  ${'group'.padEnd(10)} ${'rows'.padStart(6)} ${'ok'.padStart(6)} ${'term%'.padStart(6)} ` +
      `${'att'.padStart(5)} ${'maxA'.padStart(4)}  ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(7)}  statuses`,
  );
  for (const [name, g] of [...groups].sort()) {
    const termPct = g.deliveries ? ((g.terminal / g.deliveries) * 100).toFixed(0) : '-';
    const fmt = (v) => (v === null || v === undefined ? '-' : Math.round(v).toString());
    console.log(
      `  ${name.padEnd(10)} ${String(g.deliveries).padStart(6)} ${String(g.succeeded).padStart(6)} ` +
        `${String(termPct).padStart(6)} ${String(g.attempts).padStart(5)} ${String(g.maxAttempt).padStart(4)}  ` +
        `${fmt(g.latency.p50).padStart(7)} ${fmt(g.latency.p95).padStart(7)} ${fmt(g.latency.max).padStart(7)}  ` +
        Object.entries(g.byStatus)
          .map(([s, n]) => `${s}=${n}`)
          .join(' '),
    );
  }
  console.log(c.dim('  latency is completed_at - events.created_at for succeeded rows, in ms;'));
  console.log(c.dim('  it INCLUDES the endpoint\'s own response time, unlike the sink-side number.'));

  for (const [name, expect] of Object.entries(expectations.groups)) {
    const g = groups.get(name);
    if (!g) {
      failures.push(`group "${name}" produced no delivery rows at all`);
      continue;
    }
    if (g.deliveries === 0) {
      failures.push(`group "${name}" produced no delivery rows at all`);
      continue;
    }
    if (expect.minTerminal !== undefined) {
      const ratio = g.terminal / g.deliveries;
      if (ratio < expect.minTerminal) {
        failures.push(
          `group "${name}": ${(ratio * 100).toFixed(1)}% terminal, expected at least ` +
            `${(expect.minTerminal * 100).toFixed(0)}%`,
        );
      }
    }
    if (expect.minSucceeded !== undefined) {
      const ratio = g.succeeded / g.deliveries;
      if (ratio < expect.minSucceeded) {
        failures.push(
          `group "${name}": ${(ratio * 100).toFixed(1)}% succeeded, expected at least ` +
            `${(expect.minSucceeded * 100).toFixed(0)}%`,
        );
      }
    }
    if (expect.maxLatencyP95Ms !== undefined && g.latency.p95 !== null) {
      if (g.latency.p95 > expect.maxLatencyP95Ms) {
        failures.push(
          `group "${name}": delivery p95 ${Math.round(g.latency.p95)}ms exceeds ` +
            `${expect.maxLatencyP95Ms}ms`,
        );
      }
    }
    if (expect.expectRetries && g.maxAttempt < 2) {
      failures.push(
        `group "${name}": no delivery was ever retried (max attempt ${g.maxAttempt}). The ` +
          'retry engine did not run.',
      );
    }
    if (expect.expectBreakerOpen && g.breakerOpen === 0 && g.autoDisabled === 0) {
      notes.push(
        `group "${name}": no endpoint breaker was open at the end of the run. It may have ` +
          'closed again during the drain window - check circuit_breaker_open_total on :9090.',
      );
    }
  }

  console.log('');
  console.log(`  expired leases (>120s)     ${data.wedged.expired_leases}`);
  console.log(`  retrying with no schedule  ${data.wedged.unscheduled}`);
  if (data.wedged.unscheduled > 0) {
    failures.push(
      `${data.wedged.unscheduled} deliveries are retrying or queued with no next_attempt_at. ` +
        'Nothing will ever claim them again.',
    );
  }
  if (data.wedged.expired_leases > 0) {
    notes.push(
      `${data.wedged.expired_leases} deliveries hold a lease that expired more than 120s ago. ` +
        'They are reclaimable, but a worker died holding them.',
    );
  }

  const breakers = data.health.filter((h) => h.state !== 'healthy');
  if (breakers.length) {
    console.log('');
    console.log('  endpoint health:');
    for (const h of breakers) {
      console.log(
        `    ${data.endpointGroup.get(h.endpoint_id) ?? '?'} ${h.endpoint_id} ${h.state} ` +
          `(${h.consecutive_failures} consecutive failures)`,
      );
    }
  }

  if (jsonArg) {
    fs.writeFileSync(
      jsonArg,
      JSON.stringify(
        {
          scenario,
          since: data.since,
          events: {
            total: totalEvents,
            offloaded: Number(ev.offloaded),
            bytes: Number(ev.bytes),
          },
          deliveries: Object.fromEntries(groups),
          wedged: data.wedged,
          failures,
          notes,
        },
        null,
        2,
      ),
    );
  }

  console.log('');
  for (const n of notes) console.log(c.yellow(`  note: ${n}`));
  if (failures.length === 0) {
    console.log(c.green('  LEDGER CHECK PASSED'));
  } else {
    console.log(c.red(`  LEDGER CHECK FAILED (${failures.length})`));
    for (const f of failures) console.log(c.red(`    - ${f}`));
  }
  console.log('');

  await disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(c.red(`verification failed: ${err.stack || err.message}`));
  await disconnect().catch(() => {});
  process.exit(2);
});
