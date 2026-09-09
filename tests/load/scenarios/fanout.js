/**
 * SCENARIO 1 - HIGH FAN-OUT
 *
 * What it proves: one published event becomes N independent delivery rows, and
 * what that multiplication costs. Fan-out is materialised - one row per
 * matching subscription, each with its own retry chain - which is what makes
 * per-endpoint replay possible and is also the most expensive design decision
 * in the system. This scenario prices it.
 *
 * Every endpoint here is fast on purpose. The only variable is N.
 *
 * How to read a failure:
 *   ingest_latency_ms   The accept path is doing too much work. Fan-out happens
 *                       AFTER the 202, so this should barely move as N grows.
 *                       If it tracks N, something in accept is not O(1) in
 *                       subscriptions.
 *   delivery_latency_ms The router or the worker pool cannot keep up. Check
 *                       outbox_pending_age_seconds and
 *                       queue_head_of_line_delay_seconds on :9090.
 *   deliveries_received Zero means nothing was delivered at all: the router
 *                       matched nothing, or the worker is not running.
 */

import { manifest, projectsByKey } from '../lib/manifest.js';
import { publish } from '../lib/publish.js';
import { drainSink, resetSink } from '../lib/collector.js';
import { baseThresholds, collector, env, publisher } from '../lib/options.js';
import { summary } from '../lib/summary.js';

const RATE = env.int('LOAD_FANOUT_RATE', 10);
const project = projectsByKey.fanout;
const FANOUT = manifest.groups.fanout ? manifest.groups.fanout.count : 0;

export const options = {
  scenarios: {
    publish_events: publisher('publishEvent', RATE),
    collect: collector('collect'),
  },
  thresholds: baseThresholds({
    // Fan-out is the cost being measured; give delivery a wide but finite
    // budget. A p95 above this means the pool is not draining the fan-out.
    'delivery_latency_ms{group:fanout}': ['p(95)<15000'],
    // The suite's dead-man switch: fast ingest with nothing delivered is a
    // failed run, not a fast one.
    'deliveries_received{group:fanout}': ['count>0'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  resetSink();
}

export function publishEvent() {
  publish(project, manifest.event_types.fanout, { fanout: FANOUT });
}

export function collect() {
  drainSink();
}

export function handleSummary(data) {
  return summary(data, `HIGH FAN-OUT - one event to ${FANOUT} endpoints at ${RATE}/s`);
}
