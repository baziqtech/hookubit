/**
 * SCENARIO 2 - SLOW ENDPOINTS (PER-ENDPOINT ISOLATION)
 *
 * The most important file in this suite. ARCHITECTURE.md calls per-endpoint
 * isolation "the hard part", and internal/worker states the claim outright: a
 * slow endpoint must never consume the pool, enforced by a bounded pool, a
 * claim sized to the free slots, and NON-BLOCKING ceilings that DEFER rather
 * than park a goroutine.
 *
 * The test: slow endpoints (5s per response, enough of them to saturate the
 * worker pool for the whole window) and fast endpoints share a project, an
 * organization and a worker pool. That is the harshest form of the claim - no
 * tenant boundary to hide behind. Both are published to at the same time.
 *
 * THE PROOF IS THE THRESHOLD ON delivery_latency_ms{group:fast}. If fast
 * deliveries are still quick while the slow group holds the pool, isolation is
 * real. If fast latency tracks slow latency, it is not - and no amount of
 * ingest throughput compensates, because the fast customer's webhooks are late.
 *
 * How to read a failure:
 *   delivery_latency_ms{group:fast} over budget
 *     Head-of-line blocking. The default claim strategy is FIFO (CLAIM_STRATEGY
 *     in internal/queue): the globally oldest ready deliveries win, so a
 *     backlog of slow-endpoint rows can sit in front of newer fast ones even
 *     though the endpoint gate would defer them. internal/queue says outright
 *     that tenant_fair "becomes the default when
 *     queue_head_of_line_delay_seconds actually shows starvation". This
 *     scenario is the instrument that decides that. Compare
 *     queue_head_of_line_delay_seconds on :9090 between the two strategies
 *     before changing anything.
 *   delivery_latency_ms{group:slow} much larger than the sink's own delay
 *     Expected, up to a point: with S slow endpoints at 5s and a per-endpoint
 *     ceiling of 16, the slow group is throughput-bound by design.
 *   deliveries_received{group:fast} == 0
 *     Total starvation. That is the failure this scenario exists to catch.
 */

import { manifest, projectsByKey } from '../lib/manifest.js';
import { publish } from '../lib/publish.js';
import { drainSink, resetSink } from '../lib/collector.js';
import { baseThresholds, collector, env, publisher } from '../lib/options.js';
import { summary } from '../lib/summary.js';

const FAST_RATE = env.int('LOAD_FAST_RATE', 20);
const SLOW_RATE = env.int('LOAD_SLOW_RATE', 2);
const project = projectsByKey.slow;
const slowMs = manifest.sizes.slowMs;
const slowCount = manifest.groups.slow ? manifest.groups.slow.count : 0;
const fastCount = manifest.groups.fast ? manifest.groups.fast.count : 0;

export const options = {
  scenarios: {
    publish_slow: publisher('publishSlow', SLOW_RATE, { tags: { flow: 'slow' } }),
    publish_fast: publisher('publishFast', FAST_RATE, { tags: { flow: 'fast' } }),
    collect: collector('collect'),
  },
  thresholds: baseThresholds({
    /**
     * THE ISOLATION CLAIM.
     *
     * The bar is one slow attempt: a fast endpoint's webhook must not wait
     * longer than a single slow endpoint takes to answer. Anything above that
     * means fast deliveries are queueing behind slow ones rather than being
     * scheduled around them.
     */
    'delivery_latency_ms{group:fast}': [`p(95)<${slowMs}`, `p(99)<${slowMs * 3}`],
    'deliveries_received{group:fast}': ['count>0'],
    'deliveries_received{group:slow}': ['count>0'],
    // Accepting an event must be unaffected by how slow any consumer is. If
    // this fails while the sink is slow, backpressure has reached the accept
    // path, which it must never do.
    'ingest_latency_ms{flow:fast}': ['p(95)<300'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  resetSink();
}

export function publishSlow() {
  publish(project, manifest.event_types.slow, { target: 'slow' }, { flow: 'slow' });
}

export function publishFast() {
  publish(project, manifest.event_types.fast, { target: 'fast' }, { flow: 'fast' });
}

export function collect() {
  drainSink();
}

export function handleSummary(data) {
  return summary(
    data,
    `SLOW ENDPOINTS - ${slowCount} endpoints at ${slowMs}ms vs ${fastCount} fast, ` +
      `${SLOW_RATE}/s and ${FAST_RATE}/s`,
  );
}
