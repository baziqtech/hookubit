/**
 * Publishing an event, and the payload it carries.
 *
 * `published_at_ms` is the first field of `data` on purpose: the sink reads it
 * out of the first kilobyte of the delivered body to compute end-to-end
 * delivery latency, and a 96 KB payload must not push it out of reach.
 */

import http from 'k6/http';
import { check } from 'k6';
import {
  ingestAccepted,
  ingestBytes,
  ingestErrors,
  ingestLatency,
  ingestRateLimited,
} from './metrics.js';
import { RUN_ID, manifest } from './manifest.js';

/** Filler is built once per VU in init cost terms, not per iteration. */
const FILLER_CHUNK = 'x'.repeat(1024);

export function filler(bytes) {
  if (bytes <= 0) return '';
  let out = '';
  while (out.length < bytes) out += FILLER_CHUNK;
  return out.slice(0, bytes);
}

export function body(eventType, extra) {
  return JSON.stringify({
    event_type: eventType,
    data: Object.assign({ published_at_ms: Date.now(), run: RUN_ID }, extra),
  });
}

/**
 * POST one event. `tags` are attached to every metric this call emits so a
 * threshold can name one publisher ("the quiet tenants") without the noisy one
 * averaging it away.
 */
export function publish(project, eventType, extra, tags) {
  const payload = body(eventType, extra);
  const url = `${manifest.ingest_url}/v1/projects/${project.id}/events`;
  const allTags = Object.assign({ op: 'publish', project: project.key }, tags || {});

  const res = http.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${project.api_key}`,
      // Unique per request: the idempotency ledger write is part of the hot
      // path this suite exists to measure, so it must not be skipped.
      'Idempotency-Key': `${RUN_ID}-${__VU}-${__ITER}-${Date.now()}`,
    },
    tags: allTags,
    timeout: '30s',
  });

  ingestLatency.add(res.timings.duration, allTags);
  ingestErrors.add(res.status !== 202, allTags);
  ingestBytes.add(payload.length, allTags);
  if (res.status === 202) ingestAccepted.add(1, allTags);
  if (res.status === 429) ingestRateLimited.add(1, allTags);

  check(
    res,
    {
      'ingest accepted (202)': (r) => r.status === 202,
    },
    allTags,
  );

  return res;
}
