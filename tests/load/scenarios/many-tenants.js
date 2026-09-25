/**
 * SCENARIO 4 - MANY TENANTS
 *
 * Tenant 1 is the noisy neighbour: slow endpoints, high publish rate. The rest
 * are quiet and fast. All of them share one organization, one database and one
 * worker pool.
 *
 * What it proves: ARCHITECTURE.md 63's "one tenant cannot starve others", at
 * the boundary the concurrency ceilings are actually expressed in
 * (MAX_CONCURRENCY_PER_PROJECT, then per-org, then global). Scenario 2 asks the
 * question within one tenant; this one asks it across tenants, which is the
 * multi-tenant product claim.
 *
 * Note on shape: tenants here are PROJECTS under one organization, not separate
 * organizations. POST /v1/organizations is throttled to ten per hour per
 * address, so an organization-per-tenant seed is not re-runnable. It is also
 * the harsher test: sharing an org means the noisy tenant's work counts against
 * the same per-org ceiling as everyone else's.
 *
 * How to read a failure:
 *   delivery_latency_ms{group:quiet} over budget
 *     The noisy tenant is being served at the quiet tenants' expense. With the
 *     FIFO claim strategy this is expected once the noisy tenant's backlog is
 *     large enough to fill every claim - which is exactly the measurement
 *     internal/queue says should decide whether tenant_fair becomes the
 *     default. Re-run with CLAIM_STRATEGY=tenant_fair and compare.
 *   ingest_latency_ms{tenant:quiet}
 *     Ingest is per-key rate limited and should be unaffected by another
 *     tenant's volume. A regression here is a shared-bucket bug.
 */

import { manifest } from '../lib/manifest.js';
import { publish } from '../lib/publish.js';
import { drainSink, resetSink } from '../lib/collector.js';
import { baseThresholds, collector, env, publisher } from '../lib/options.js';
import { summary } from '../lib/summary.js';

const noisyKey = manifest.noisy_tenant || 'tenant-1';
const noisy = manifest.projects.find((p) => p.key === noisyKey);
const quiet = manifest.projects.filter((p) => p.key !== noisyKey);

const NOISY_RATE = env.int('LOAD_NOISY_RATE', 15);
const QUIET_RATE_EACH = env.int('LOAD_QUIET_RATE', 3);
const QUIET_RATE = Math.max(1, QUIET_RATE_EACH * quiet.length);

export const options = {
  scenarios: {
    publish_noisy: publisher('publishNoisy', NOISY_RATE, { tags: { tenant: 'noisy' } }),
    publish_quiet: publisher('publishQuiet', QUIET_RATE, { tags: { tenant: 'quiet' } }),
    collect: collector('collect'),
  },
  thresholds: baseThresholds({
    // The fairness claim. A quiet tenant's webhooks must not inherit the noisy
    // tenant's latency.
    'delivery_latency_ms{group:quiet}': [`p(95)<${manifest.sizes.slowMs}`],
    'deliveries_received{group:quiet}': ['count>0'],
    'deliveries_received{group:noisy}': ['count>0'],
    'ingest_latency_ms{tenant:quiet}': ['p(95)<300'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  resetSink();
}

export function publishNoisy() {
  publish(noisy, manifest.event_types.tenant, { tenant: noisy.key }, { tenant: 'noisy' });
}

export function publishQuiet() {
  // Round-robin so every quiet tenant is published to evenly; a tenant that
  // never publishes cannot be starved, and would flatter the result.
  const target = quiet[(__VU + __ITER) % quiet.length];
  return publish(target, manifest.event_types.tenant, { tenant: target.key }, { tenant: 'quiet' });
}

export function collect() {
  drainSink();
}

export function handleSummary(data) {
  return summary(
    data,
    `MANY TENANTS - 1 noisy (${NOISY_RATE}/s, slow endpoints) vs ${quiet.length} quiet ` +
      `(${QUIET_RATE_EACH}/s each)`,
  );
}
