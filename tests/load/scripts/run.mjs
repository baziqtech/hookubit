#!/usr/bin/env node
/**
 * One command per scenario: seed, run, verify, report.
 *
 * The order is not negotiable. Seeding through the real control API means a
 * broken control plane fails the run rather than producing a load test that
 * measures nothing; scraping :9090 either side of k6 turns lifetime counters
 * into what happened during THIS run; and the ledger check afterwards is what
 * stops "ingest was fast" being mistaken for "webhooks were delivered".
 *
 * Usage:
 *   node tests/load/scripts/run.mjs <scenario|all> [--no-seed] [--no-verify]
 *                                   [--k6-arg=...]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  ARTIFACTS,
  LOAD_ROOT,
  REPO_ROOT,
  SCENARIOS,
  c,
  config,
  ensureArtifacts,
  manifestPath,
} from './support/env.mjs';
import { deltaByLabel, delta, histogramMean, scrape } from './support/promscrape.mjs';
import { disconnect } from './support/api.mjs';
import { resetBreakers, waitForQuiesce } from './support/db.mjs';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      ...options,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(c.red(`could not run ${command}: ${err.message}`));
      resolve(127);
    });
  });
}

function reachable(url, timeoutMs = 1500) {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({
      host: hostname,
      port: Number(port || (protocol === 'https:' ? 443 : 80)),
    });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * Start the sink if nothing is listening. Started here, it is killed here - a
 * sink left running between sessions accumulates stats from runs nobody
 * remembers and quietly biases the next one.
 */
async function ensureSink() {
  if (await reachable(config.sink)) {
    console.log(c.dim(`sink already listening at ${config.sink}`));
    return null;
  }
  const logFile = path.join(ensureArtifacts(), 'sink.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(LOAD_ROOT, 'sink/sink.mjs')], {
    cwd: REPO_ROOT,
    stdio: ['ignore', out, out],
    detached: false,
  });
  for (let i = 0; i < 40; i += 1) {
    if (await reachable(config.sink)) {
      console.log(`started the sink at ${config.sink} (log: ${logFile})`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`the sink did not come up at ${config.sink}; see ${logFile}`);
}

function which(bin) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.some((d) => d && fs.existsSync(path.join(d, bin)));
}

async function metricsSnapshot() {
  try {
    return await scrape(config.metrics);
  } catch (err) {
    console.warn(c.yellow(`  ! could not scrape ${config.metrics}/metrics: ${err.message}`));
    return null;
  }
}

function reportMetrics(before, after) {
  if (!before || !after) return;
  const fmt = (n) => (n === null ? '-' : Math.round(n * 1000) / 1000);
  console.log('');
  console.log(c.bold('  DATA PLANE, during this run (delta on :9090)'));
  console.log(
    c.dim('    process-wide, not scoped to this scenario - a previous run still draining,'),
  );
  console.log(c.dim('    or another project on the same data plane, is counted here too.'));
  console.log(`    events ingested            ${delta(before, after, 'events_ingested_total')}`);
  console.log(`    deliveries created         ${delta(before, after, 'deliveries_created_total')}`);
  console.log(
    `    deliveries completed       ${JSON.stringify(deltaByLabel(before, after, 'deliveries_completed_total', 'outcome'))}`,
  );
  console.log(`    deliveries retried         ${delta(before, after, 'deliveries_retried_total')}`);
  console.log(
    `    egress responses           ${JSON.stringify(deltaByLabel(before, after, 'egress_http_responses_total', 'class'))}`,
  );
  console.log(
    `    rate limit hits            ${JSON.stringify(deltaByLabel(before, after, 'rate_limit_hits_total', 'scope'))}`,
  );
  console.log(`    circuit breakers opened    ${delta(before, after, 'circuit_breaker_open_total')}`);
  console.log(
    `    payload offloads           ${JSON.stringify(deltaByLabel(before, after, 'payload_offloads_total', 'outcome'))}`,
  );
  console.log(
    `    payload fetches            ${JSON.stringify(deltaByLabel(before, after, 'payload_fetches_total', 'outcome'))}`,
  );
  // The number internal/queue says should decide whether FIFO stays the default.
  console.log(
    `    queue head-of-line delay   ${fmt(histogramMean(before, after, 'queue_head_of_line_delay_seconds'))} s mean`,
  );
  console.log(
    `    delivery latency (dataplane) ${fmt(histogramMean(before, after, 'delivery_latency_seconds'))} s mean`,
  );
}

/**
 * What the sink saw. This is the answer to "was the load generator the
 * bottleneck?" - if max_in_flight sat at the connection ceiling for a
 * destination, the run measured the egress pool rather than the platform.
 */
async function reportSink() {
  try {
    const res = await fetch(`${config.sink}/_stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const stats = await res.json();
    console.log('');
    console.log(c.bold('  SINK'));
    console.log(
      `    total ${stats.total_requests} requests, ${stats.unique_deliveries} distinct ` +
        `deliveries, ${stats.duplicate_deliveries} repeats (retries and redeliveries)`,
    );
    for (const [name, g] of Object.entries(stats.groups)) {
      console.log(
        `    ${name.padEnd(10)} ${String(g.requests).padStart(6)} requests  ` +
          `max in flight ${String(g.max_in_flight).padStart(4)}  ` +
          `signed ${g.signed}/${g.requests}  statuses ${JSON.stringify(g.by_status)}`,
      );
    }
    if (stats.dropped_samples > 0) {
      console.log(
        c.yellow(`    ! the sink dropped ${stats.dropped_samples} latency samples; ` +
          'delivery percentiles above are from a biased sample'),
      );
    }
  } catch {
    /* the sink may already be gone; its numbers are a bonus, not the result */
  }
}

async function runScenario(scenario, flags) {
  console.log('');
  console.log(c.bold(`==== ${scenario} ====`));

  if (!flags.noSeed) {
    const code = await run(process.execPath, [
      path.join(LOAD_ROOT, 'scripts/seed.mjs'),
      scenario,
    ]);
    if (code !== 0) return { scenario, k6: code, verify: null, ok: false };
  }
  if (!fs.existsSync(manifestPath(scenario))) {
    console.error(c.red(`no manifest for ${scenario}; seed first`));
    return { scenario, k6: 2, verify: null, ok: false };
  }

  const summaryFile = path.join(ARTIFACTS, `summary-${scenario}.json`);
  const verifyFile = path.join(ARTIFACTS, `ledger-${scenario}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath(scenario), 'utf8'));

  // Never start on top of the last run's backlog, and never start behind a
  // breaker the last run opened. Both would be measured as this run's result.
  const settled = await waitForQuiesce(manifest, { label: 'before the run' });
  if (!settled.quiet) {
    console.warn(
      c.yellow(
        `  ! ${settled.remaining} deliveries were still outstanding when this run started` +
          `${settled.stalled ? ' and had stopped moving' : ''}. The numbers below include them.`,
      ),
    );
  }
  const cleared = await resetBreakers(manifest);
  if (cleared) console.log(c.dim(`  cleared ${cleared} endpoint_health rows (circuit breakers)`));

  const before = await metricsSnapshot();
  const since = new Date(Date.now() - 1000); // a second of slack for clock skew

  const k6Code = await run('k6', [
    'run',
    '--quiet',
    '-e',
    `LOAD_MANIFEST=${manifestPath(scenario)}`,
    '-e',
    `LOAD_SUMMARY=${summaryFile}`,
    '-e',
    `LOAD_RUN_ID=${scenario}-${since.getTime()}`,
    ...flags.k6Args,
    path.join(LOAD_ROOT, `scenarios/${scenario}.js`),
  ]);

  // Let the backlog land before the ledger is read - and before the sink is
  // stopped underneath it. A sink taken away mid-drain manufactures connection
  // failures, opens breakers on healthy endpoints, and poisons the next run.
  const drained = await waitForQuiesce(manifest, {
    timeoutMs: Number(process.env.LOAD_SETTLE_TIMEOUT_MS ?? 180000),
    label: 'after the run',
  });
  if (!drained.quiet) {
    console.log(
      c.dim(
        `  ${drained.remaining} deliveries still outstanding after ${Math.round(drained.waitedMs / 1000)}s` +
          `${drained.stalled ? ' (no longer moving - parked behind a breaker or a backoff)' : ''}`,
      ),
    );
  }

  const after = await metricsSnapshot();
  reportMetrics(before, after);
  await reportSink();

  let verifyCode = null;
  if (!flags.noVerify) {
    verifyCode = await run(process.execPath, [
      path.join(LOAD_ROOT, 'scripts/verify.mjs'),
      scenario,
      '--since',
      since.toISOString(),
      '--json',
      verifyFile,
    ]);
  }

  const ok = k6Code === 0 && (verifyCode === null || verifyCode === 0);
  return { scenario, k6: k6Code, verify: verifyCode, ok };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    noSeed: args.includes('--no-seed'),
    noVerify: args.includes('--no-verify'),
    k6Args: args.filter((a) => a.startsWith('--k6-arg=')).map((a) => a.slice('--k6-arg='.length)),
  };
  const requested = args.filter((a) => !a.startsWith('--'));
  const scenarios = requested.length === 0 || requested[0] === 'all' ? SCENARIOS : requested;

  for (const s of scenarios) {
    if (!SCENARIOS.includes(s)) {
      console.error(`unknown scenario "${s}". Known: ${SCENARIOS.join(', ')}`);
      process.exit(2);
    }
  }

  if (!which('k6')) {
    console.error(c.red('k6 is not installed.'));
    console.error('  brew install k6            (macOS)');
    console.error('  https://grafana.com/docs/k6/latest/set-up/install-k6/');
    console.error('');
    console.error('  Or run it from Docker against the host services:');
    console.error(
      '    docker run --rm -i --add-host=host.docker.internal:host-gateway \\\n' +
        '      -v "$PWD/tests/load:/load" grafana/k6 run /load/scenarios/<scenario>.js',
    );
    console.error('  (see docs/LOAD_TESTING.md - the URLs in the manifest must be rewritten');
    console.error('   to host.docker.internal for a container to reach them)');
    process.exit(127);
  }

  ensureArtifacts();
  const sink = await ensureSink();
  const results = [];
  try {
    for (const s of scenarios) results.push(await runScenario(s, flags));
  } finally {
    if (sink) {
      sink.kill('SIGTERM');
      console.log(c.dim('stopped the sink'));
    }
  }

  console.log('');
  console.log(c.bold('  SUMMARY'));
  for (const r of results) {
    const label = r.ok ? c.green('PASS') : c.red('FAIL');
    console.log(
      `    ${label}  ${r.scenario.padEnd(20)} k6=${r.k6}` +
        (r.verify === null ? '' : ` ledger=${r.verify}`),
    );
  }
  console.log('');
  await disconnect().catch(() => {});
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(err.stack || err.message));
  process.exit(1);
});
