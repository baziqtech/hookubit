/**
 * SCENARIO 5 - LARGE PAYLOADS
 *
 * Events above PAYLOAD_INLINE_MAX_BYTES, which the ingest path offloads to
 * object storage instead of jsonb, and which the worker must fetch back before
 * it can sign and send.
 *
 * What it proves: the offload boundary holds under load, in both directions.
 * The interesting risk is not the write - it is that every delivery of an
 * offloaded event now costs an object-store round trip on the delivery path,
 * multiplied by the routing. A run that succeeds here with a delivery p95 close
 * to the inline case means the fetch is not on the critical path in a way that
 * matters; a large gap is the number to take to a capacity conversation.
 *
 * How to read a failure:
 *   ingest_latency_ms over budget
 *     The accept path now includes a PUT to object storage, so its budget here
 *     is wider than elsewhere on purpose. Over it means MinIO/S3 is the
 *     bottleneck, or PAYLOAD_STORE timeouts are being hit.
 *   ingest_errors with 413s
 *     The payload is above PAYLOAD_MAX_BYTES. That is the platform working;
 *     lower LOAD_LARGE_PAYLOAD_BYTES.
 *   delivery_latency_ms{group:large}
 *     The read side. Check payload_fetches_total on :9090 for the failure
 *     outcome label before assuming it is slowness.
 *
 * The ledger check afterwards asserts what k6 cannot see: that every event was
 * actually offloaded (events.payload_location IS NOT NULL) rather than quietly
 * stored inline, which would make this scenario a no-op.
 */

import { manifest, projectsByKey } from '../lib/manifest.js';
import { filler, publish } from '../lib/publish.js';
import { drainSink, resetSink } from '../lib/collector.js';
import { baseThresholds, collector, env, publisher } from '../lib/options.js';
import { summary } from '../lib/summary.js';

const RATE = env.int('LOAD_LARGE_RATE', 5);
const project = projectsByKey.large;
const BYTES = manifest.payload_bytes || 96 * 1024;
const INLINE_MAX = manifest.payload_inline_max_bytes;

// Built once in init context and shared by every VU: regenerating 96 KB per
// iteration would make this a benchmark of the load generator.
const FILLER = filler(BYTES);

export const options = {
  scenarios: {
    publish_large: publisher('publishLarge', RATE),
    collect: collector('collect'),
  },
  thresholds: baseThresholds({
    // Wider than the shared default: accepting one of these includes a write to
    // object storage.
    ingest_latency_ms: ['p(95)<1500', 'p(99)<5000'],
    ingest_errors: ['rate<0.01'],
    'delivery_latency_ms{group:large}': ['p(95)<20000'],
    'deliveries_received{group:large}': ['count>0'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  if (BYTES <= INLINE_MAX) {
    throw new Error(
      `LOAD_LARGE_PAYLOAD_BYTES (${BYTES}) is at or below PAYLOAD_INLINE_MAX_BYTES ` +
        `(${INLINE_MAX}). Nothing would be offloaded and this scenario would prove nothing.`,
    );
  }
  resetSink();
}

export function publishLarge() {
  publish(project, manifest.event_types.large, { bytes: BYTES, filler: FILLER });
}

export function collect() {
  drainSink();
}

export function handleSummary(data) {
  return summary(
    data,
    `LARGE PAYLOADS - ${Math.round(BYTES / 1024)} KB events (inline max ` +
      `${Math.round(INLINE_MAX / 1024)} KB) at ${RATE}/s`,
  );
}
