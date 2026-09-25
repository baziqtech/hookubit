/**
 * Shared scenario wiring.
 *
 * Two knobs decide the shape of every run: how long publishers publish
 * (LOAD_DURATION) and how long the collector keeps draining afterwards
 * (LOAD_DRAIN). The drain window is not padding - deliveries are still in
 * flight when the last 202 comes back, and cutting the collector off with the
 * publishers is how a load test reports a delivery p95 that only covers the
 * deliveries that happened to be quick.
 */

export const env = {
  int(name, fallback) {
    const raw = __ENV[name];
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  },
  str(name, fallback) {
    return __ENV[name] === undefined || __ENV[name] === '' ? fallback : __ENV[name];
  },
};

export const DURATION = env.int('LOAD_DURATION', 45);
export const DRAIN = env.int('LOAD_DRAIN', 90);

export function publisher(exec, rate, opts) {
  const o = opts || {};
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate,
    timeUnit: '1s',
    duration: `${o.duration || DURATION}s`,
    preAllocatedVUs: o.preAllocatedVUs || Math.max(10, Math.ceil(rate / 2)),
    maxVUs: o.maxVUs || Math.max(50, rate * 4),
    startTime: `${o.startTime || 0}s`,
    gracefulStop: '15s',
    tags: o.tags || {},
  };
}

/** The collector runs for the publish window plus the whole drain window. */
export function collector(exec, opts) {
  const o = opts || {};
  return {
    executor: 'constant-arrival-rate',
    exec: exec || 'collect',
    rate: o.rate || 2,
    timeUnit: '1s',
    duration: `${(o.duration || DURATION) + (o.drain || DRAIN)}s`,
    preAllocatedVUs: 1,
    maxVUs: 2,
    gracefulStop: '10s',
    tags: { op: 'collect' },
  };
}

/** Thresholds every scenario carries, whatever else it is proving. */
export function baseThresholds(extra) {
  return Object.assign(
    {
      // The accept path. 202 means durably persisted; it is meant to be cheap.
      ingest_latency_ms: ['p(95)<300', 'p(99)<1000'],
      // A 429 counts as an error here: the run is sized to sit under the
      // configured ceiling, so hitting it means the run is measuring the rate
      // limiter, not the platform.
      ingest_errors: ['rate<0.01'],
      // A biased delivery sample invalidates every delivery threshold below it.
      collector_dropped_samples: ['count==0'],
    },
    extra || {},
  );
}
