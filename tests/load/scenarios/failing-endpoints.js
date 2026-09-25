/**
 * SCENARIO 3 - FAILING ENDPOINTS
 *
 * Endpoints that answer 500, an endpoint that answers 429 with a Retry-After,
 * and an endpoint that never answers at all - next to a healthy control group
 * in the same project.
 *
 * What it proves:
 *   - The retry engine schedules and records attempts under load, rather than
 *     losing deliveries or hot-looping on them.
 *   - The circuit breaker opens (5 consecutive failures, 30s base cooldown) and
 *     the platform stops spending the pool on an endpoint that is down.
 *   - The healthy group keeps being served throughout. Failure isolation is the
 *     same claim as slowness isolation, arrived at from the other direction.
 *
 * The failing endpoints use a deliberately fast retry policy seeded for this
 * project (3 attempts, 1s initial, 4s ceiling). The product default is 8
 * attempts starting at 5s and doubling - correct for production, useless in a
 * 45-second run, where nothing would reach a terminal state and the ledger
 * check afterwards would have nothing to assert.
 *
 * How to read a failure:
 *   delivery_latency_ms{group:fast} over budget
 *     Failing endpoints are consuming the pool. Attempts against a dead
 *     endpoint cost a full timeout each; if the breaker is not opening, the
 *     pool drains into them. Check circuit_breaker_open_total on :9090.
 *   ingest_errors
 *     Failure on the delivery side has reached the accept side. It must not.
 *   The ledger check afterwards is where retry and breaker behaviour is
 *   actually asserted - k6 cannot see either.
 */

import { manifest, projectsByKey } from '../lib/manifest.js';
import { publish } from '../lib/publish.js';
import { drainSink, resetSink } from '../lib/collector.js';
import { baseThresholds, collector, env, publisher } from '../lib/options.js';
import { summary } from '../lib/summary.js';

const FAIL_RATE = env.int('LOAD_FAIL_RATE', 3);
const FAST_RATE = env.int('LOAD_FAST_RATE', 15);
const project = projectsByKey.failing;

export const options = {
  scenarios: {
    publish_failing: publisher('publishFailing', FAIL_RATE, { tags: { flow: 'failing' } }),
    publish_fast: publisher('publishFast', FAST_RATE, { tags: { flow: 'fast' } }),
    collect: collector('collect'),
  },
  thresholds: baseThresholds({
    // The healthy group must be unaffected by the sick one.
    'delivery_latency_ms{group:fast}': ['p(95)<5000', 'p(99)<15000'],
    'deliveries_received{group:fast}': ['count>0'],
    // The failing endpoints must actually be reached - a run where the breaker
    // opened before a single attempt landed proves nothing about retries.
    'deliveries_received{group:failing}': ['count>0'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  resetSink();
}

export function publishFailing() {
  publish(project, manifest.event_types.failing, { target: 'failing' }, { flow: 'failing' });
}

export function publishFast() {
  publish(project, manifest.event_types.fast, { target: 'fast' }, { flow: 'fast' });
}

export function collect() {
  drainSink();
}

export function handleSummary(data) {
  return summary(data, `FAILING ENDPOINTS - 500s, 429s and a dead socket at ${FAIL_RATE}/s`);
}
