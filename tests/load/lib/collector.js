/**
 * The bridge between what k6 can see and what is actually under test.
 *
 * k6 measures ingest. Ingest is the easy half: a 202 means "durably persisted",
 * not "delivered". The sink is the only place that knows when a webhook really
 * arrived, so every scenario runs a collector alongside its publishers that
 * drains the sink's latency samples and replays them into k6 metrics. Once they
 * are k6 metrics, they can carry THRESHOLDS - which is how "a slow tenant must
 * not starve a fast one" becomes a run that passes or fails instead of a wall
 * of numbers.
 *
 * The collector must outlive the publishers. Deliveries are still draining
 * after the last event is accepted, and a collector that stops with the
 * publishers reports a fraction of them.
 */

import http from 'k6/http';
import { manifest } from './manifest.js';
import { collectorDropped, deliveriesReceived, deliveryLatency } from './metrics.js';

let lastDropped = 0;

export function drainSink() {
  const res = http.get(`${manifest.sink_url}/_stats/drain`, {
    tags: { op: 'collect' },
    timeout: '30s',
  });
  if (res.status !== 200) return 0;

  let payload;
  try {
    payload = res.json();
  } catch (err) {
    return 0;
  }

  const samples = payload.samples || [];
  for (const s of samples) {
    const tags = { group: s.g, endpoint: s.ep };
    deliveryLatency.add(s.ms, tags);
    deliveriesReceived.add(1, tags);
  }

  // The sink caps its sample buffer. If it ever drops, the run's delivery
  // percentiles are computed from a biased sample and must not be trusted.
  const dropped = payload.dropped || 0;
  if (dropped > lastDropped) {
    collectorDropped.add(dropped - lastDropped);
    lastDropped = dropped;
  }
  return samples.length;
}

/** Clear the sink's counters so a run reports only its own traffic. */
export function resetSink() {
  const res = http.post(`${manifest.sink_url}/_reset`, null, { tags: { op: 'collect' } });
  return res.status === 200;
}

/** The sink's full snapshot, for the end-of-run summary. */
export function sinkStats() {
  const res = http.get(`${manifest.sink_url}/_stats`, { tags: { op: 'collect' } });
  return res.status === 200 ? res.json() : null;
}
