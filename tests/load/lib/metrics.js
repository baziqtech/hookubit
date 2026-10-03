/**
 * Every custom metric the suite reports on, in one place.
 *
 * Two families, and the distinction is the whole point of this suite:
 *
 *   ingest_*    what k6 can see itself - the 202 from POST /events.
 *   delivery_*  what only the SINK can see - the event actually arriving at an
 *               endpoint. k6 never makes these requests; they are drained from
 *               the sink by the collector scenario and replayed into these
 *               metrics so that thresholds can be written against them.
 *
 * A run where ingest was fast and nothing was ever delivered fails on
 * `deliveries_received`, not on a number a human has to notice.
 */

import { Counter, Rate, Trend } from 'k6/metrics';

/** Time from POST /v1/projects/:id/events to the 202. */
export const ingestLatency = new Trend('ingest_latency_ms', true);
/** Any non-202 from ingest, including 429. */
export const ingestErrors = new Rate('ingest_errors');
export const ingestAccepted = new Counter('ingest_accepted');
export const ingestRateLimited = new Counter('ingest_rate_limited');
export const ingestBytes = new Counter('ingest_bytes');

/**
 * Publish-to-arrival, measured at the sink, FIRST ATTEMPTS ONLY. A retry's
 * clock includes the backoff the retry policy deliberately imposed; mixing the
 * two makes "the platform is slow" and "the endpoint is down" the same number.
 */
export const deliveryLatency = new Trend('delivery_latency_ms', true);
export const deliveriesReceived = new Counter('deliveries_received');
/** Samples the sink had to drop because nothing drained them fast enough. */
export const collectorDropped = new Counter('collector_dropped_samples');
