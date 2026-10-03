#!/usr/bin/env node
/**
 * Create everything a scenario needs, through the real control API, and write a
 * manifest k6 and the verifier both read.
 *
 * Idempotent. Projects, endpoints and subscriptions are matched by name and
 * reused; only the API key cannot be, because the plaintext is returned exactly
 * once and is never recoverable - so a fresh key is minted whenever the
 * manifest that held the last one is gone.
 *
 * Usage:
 *   node tests/load/scripts/seed.mjs <scenario> [--force]
 *   node tests/load/scripts/seed.mjs all
 */

import fs from 'node:fs';
import net from 'node:net';
import { SCENARIOS, c, config, ensureArtifacts, manifestPath } from './support/env.mjs';
import { assignPorts, plan, urlFor } from './support/topology.mjs';
import {
  disconnect,
  ensureEndpoint,
  ensureIngestCeiling,
  ensureOperator,
  ensureOrganization,
  ensureProject,
  ensureRetryPolicy,
  ensureSubscription,
  mintApiKey,
} from './support/api.mjs';

/**
 * The ingest listener answers only POST /v1/projects/:id/events - every other
 * path is a 404 that also increments events_ingestion_failed_total. So it is
 * probed at the socket, not with a request: a health check must not appear in
 * the metrics the run is about to read.
 */
function tcpReachable(url, timeoutMs = 3000) {
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

async function preflight() {
  const checks = [
    ['control API', `${config.controlApi}/health/ready`],
    ['data-plane metrics', `${config.metrics}/health/ready`],
    ['sink', `${config.sink}/_healthz`],
  ];
  const problems = [];
  for (const [name, url] of checks) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) problems.push(`${name} at ${url} answered ${res.status}`);
    } catch (err) {
      problems.push(`${name} at ${url} is unreachable (${err.message})`);
    }
  }
  if (!(await tcpReachable(config.ingest))) {
    problems.push(`ingest at ${config.ingest} is not accepting connections`);
  }
  if (problems.length) {
    console.error(c.red('Preflight failed:'));
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nThe suite needs the control API, the data plane and the sink running.\n' +
        'See docs/LOAD_TESTING.md; the sink is `pnpm load:sink`.',
    );
    process.exit(2);
  }
}

async function seedScenario(api, org, scenario, { force }) {
  const spec = assignPorts(plan(scenario));
  const file = manifestPath(scenario);
  const previous = !force && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  console.log(c.bold(`\nseeding ${scenario}`));
  const projects = [];

  for (const p of spec.projects) {
    const project = await ensureProject(api, org.id, {
      name: p.name,
      slug: p.slug,
      environment: 'test',
    });

    let retryPolicyId = null;
    if (p.retry_policy) {
      const policy = await ensureRetryPolicy(api, project.id, p.retry_policy);
      retryPolicyId = policy.id;
    }

    const endpoints = [];
    for (const e of p.endpoints) {
      const created = await ensureEndpoint(api, project.id, {
        name: e.name,
        url: urlFor(e),
        max_concurrency: e.max_concurrency,
        timeout_ms: e.timeout_ms,
        ...(e.use_retry_policy && retryPolicyId ? { retry_policy_id: retryPolicyId } : {}),
      });
      endpoints.push({
        key: e.key,
        id: created.id,
        group: e.group,
        port: e.port,
        profile: e.profile,
        url: created.url,
        max_concurrency: created.max_concurrency,
        timeout_ms: created.timeout_ms,
        retry_policy_id: created.retry_policy_id ?? null,
      });
    }

    const byKey = new Map(endpoints.map((e) => [e.key, e]));
    const subscriptions = [];
    for (const sub of p.subscriptions) {
      const target = byKey.get(sub.endpoint_key);
      const created = await ensureSubscription(api, project.id, {
        name: `load sub ${sub.endpoint_key}`,
        endpoint_id: target.id,
        event_types: sub.event_types,
      });
      subscriptions.push({
        id: created.id,
        endpoint_key: sub.endpoint_key,
        endpoint_id: target.id,
        event_types: created.event_types,
      });
    }

    if (p.ingest_limit) await ensureIngestCeiling(api, project.id, p.ingest_limit);

    const carried = previous?.projects?.find((x) => x.key === p.key);
    const apiKey = carried?.api_key ?? (await mintApiKey(api, project.id, `load ${scenario}`)).key;

    projects.push({
      key: p.key,
      id: project.id,
      name: project.name,
      slug: project.slug,
      noisy: Boolean(p.noisy),
      api_key: apiKey,
      endpoints,
      subscriptions,
    });

    console.log(
      `  ${c.cyan(project.slug)} ${project.id}  ${endpoints.length} endpoints, ` +
        `${subscriptions.length} subscriptions${carried ? c.dim(' (api key reused)') : ''}`,
    );
  }

  const groups = {};
  for (const p of projects) {
    for (const e of p.endpoints) {
      groups[e.group] ??= { endpoint_ids: [], endpoint_keys: [], count: 0 };
      groups[e.group].endpoint_ids.push(e.id);
      groups[e.group].endpoint_keys.push(e.key);
      groups[e.group].count += 1;
    }
  }

  const manifest = {
    scenario,
    generated_at: new Date().toISOString(),
    control_api: config.controlApi,
    ingest_url: config.ingest,
    sink_url: config.sink,
    metrics_url: config.metrics,
    organization: { id: org.id, name: org.name, slug: org.slug },
    event_types: spec.event_types,
    noisy_tenant: spec.noisy_tenant ?? null,
    payload_bytes: spec.payload_bytes ?? null,
    payload_inline_max_bytes: config.payloadInlineMaxBytes,
    sizes: config.sizes,
    groups,
    projects,
  };

  ensureArtifacts();
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`  manifest ${c.dim(file)}`);
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const requested = args.filter((a) => !a.startsWith('--'));
  const scenarios =
    requested.length === 0 || requested[0] === 'all' ? SCENARIOS : requested;

  for (const s of scenarios) {
    if (!SCENARIOS.includes(s)) {
      console.error(`unknown scenario "${s}". Known: ${SCENARIOS.join(', ')}`);
      process.exit(2);
    }
  }

  await preflight();

  const api = await ensureOperator();
  console.log(`operator ${c.cyan(config.operatorEmail)} signed in`);
  const org = await ensureOrganization(api);
  console.log(`organization ${c.cyan(org.slug)} ${org.id}`);

  for (const s of scenarios) await seedScenario(api, org, s, { force });
  await disconnect();
  console.log(c.green('\nseed complete'));
}

main().catch(async (err) => {
  console.error(c.red(`\nseed failed: ${err.message}`));
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  await disconnect().catch(() => {});
  process.exit(1);
});
