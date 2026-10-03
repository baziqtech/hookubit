/**
 * What each scenario needs to exist before it can measure anything.
 *
 * One module, because the seed, the k6 scripts and the post-run verification
 * must agree on the shape of the world or they are measuring different things.
 * The seed builds this; the manifest is this plus the ids the control plane
 * assigned; k6 and verify read the manifest and nothing else.
 *
 * The behaviour of every endpoint is encoded in its URL query string, so
 * `select url from endpoints` in psql tells an operator exactly what that
 * endpoint was configured to do during a run.
 */

import { config } from './env.mjs';

function sinkUrl(profile, port, { group, key, ...query }) {
  const params = new URLSearchParams({ g: group, ep: key });
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  return `http://${config.sinkHost}:${port}/sink/${profile}?${params.toString()}`;
}

/**
 * Give every endpoint a destination port, and never let two different GROUPS
 * share one.
 *
 * The data plane opens at most EGRESS_MAX_CONNS_PER_HOST concurrent connections
 * to a host:port, and that pool is shared by every endpoint and every tenant
 * pointing at it. Put the slow group and the fast group on the same port and
 * the fast group waits for the slow group's connections - which reads exactly
 * like a scheduling failure and is not one. That ceiling was a hardcoded 16
 * (egress.Limits.IdleConnsPerHost = 4, times four, in cmd/webhookd/roles.go);
 * it now defaults to WORKER_CONCURRENCY, but it is still a per-HOST bound.
 *
 * Groups therefore get disjoint ports. Endpoints WITHIN a group may share, and
 * should: contention between endpoints that behave the same way is not what any
 * of these scenarios is about.
 */
export function assignPorts(spec) {
  const groups = [];
  for (const p of spec.projects) {
    for (const e of p.endpoints) if (!groups.includes(e.group)) groups.push(e.group);
  }
  const ports = config.sinkPorts;
  if (ports < groups.length) {
    console.warn(
      `  ! LOAD_SINK_PORTS=${ports} but this scenario has ${groups.length} endpoint groups. ` +
        'Groups will share a destination host and its EGRESS_MAX_CONNS_PER_HOST ceiling; ' +
        'if that ceiling is below WORKER_CONCURRENCY, this run measures the egress ' +
        'connection pool rather than the scheduler.',
    );
  }
  // Ports are dealt to groups first, then round-robin within each group.
  const perGroup = Math.max(1, Math.floor(ports / Math.max(1, groups.length)));
  const counters = new Map();
  for (const p of spec.projects) {
    for (const e of p.endpoints) {
      const gi = groups.indexOf(e.group);
      const base = (gi * perGroup) % ports;
      const n = counters.get(e.group) ?? 0;
      counters.set(e.group, n + 1);
      e.port = config.sinkPort + ((base + (n % perGroup)) % ports);
    }
  }
  return spec;
}

/** A retry policy fast enough that a load run can actually watch a delivery
 *  exhaust. The product default is 8 attempts starting at 5s doubling - hours. */
const FAST_RETRY = {
  name: 'load-fast-retry',
  strategy: 'exponential',
  max_attempts: 3,
  initial_delay_ms: 1000,
  max_delay_ms: 4000,
  multiplier: 2,
  jitter_ratio: 0.2,
  max_retry_duration_ms: 60000,
  is_default: true,
};

const endpoint = (key, profile, group, overrides = {}) => ({
  key,
  profile,
  group,
  name: `load ${key}`,
  max_concurrency: overrides.max_concurrency ?? 16,
  timeout_ms: overrides.timeout_ms ?? 10000,
  use_retry_policy: overrides.use_retry_policy ?? false,
  query: overrides.query ?? {},
});

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

export function plan(scenario) {
  const s = config.sizes;

  switch (scenario) {
    /**
     * WIDE ROUTING - what one published event costs when it becomes N delivery
     * rows. The endpoints are all fast on purpose: the only variable is the
     * multiplication.
     */
    case 'wide':
      return {
        scenario,
        event_types: { wide: 'load.wide' },
        projects: [
          {
            key: 'wide',
            name: 'Load - wide',
            slug: 'load-wide',
            ingest_limit: 5000,
            endpoints: range(s.wideEndpoints).map((i) =>
              endpoint(`wide-${i}`, 'fast', 'wide', { timeout_ms: 5000 }),
            ),
            subscriptions: range(s.wideEndpoints).map((i) => ({
              endpoint_key: `wide-${i}`,
              event_types: ['load.wide'],
            })),
          },
        ],
      };

    /**
     * SLOW ENDPOINTS - the important one. Slow and fast endpoints share a
     * project, an organization and a worker pool, which is the harshest form of
     * the claim in ARCHITECTURE.md 24: a slow endpoint must not consume the
     * pool. If the fast group's delivery latency tracks the slow group's, the
     * pool is being consumed and per-endpoint isolation is not real.
     *
     * The slow endpoints' timeout is set well ABOVE their delay - otherwise
     * this stops being an isolation test and becomes a timeout test.
     */
    case 'slow-endpoints':
      return {
        scenario,
        event_types: { slow: 'load.slow', fast: 'load.fast' },
        projects: [
          {
            key: 'slow',
            name: 'Load - slow endpoints',
            slug: 'load-slow-endpoints',
            ingest_limit: 5000,
            endpoints: [
              ...range(s.slowEndpoints).map((i) =>
                endpoint(`slow-${i}`, 'slow', 'slow', {
                  timeout_ms: Math.min(120000, s.slowMs * 2 + 5000),
                  max_concurrency: s.slowMaxConcurrency,
                  query: { delay_ms: s.slowMs },
                }),
              ),
              ...range(s.slowControlEndpoints).map((i) =>
                endpoint(`fast-${i}`, 'fast', 'fast', { timeout_ms: 5000 }),
              ),
            ],
            subscriptions: [
              ...range(s.slowEndpoints).map((i) => ({
                endpoint_key: `slow-${i}`,
                event_types: ['load.slow'],
              })),
              ...range(s.slowControlEndpoints).map((i) => ({
                endpoint_key: `fast-${i}`,
                event_types: ['load.fast'],
              })),
            ],
          },
        ],
      };

    /**
     * FAILING ENDPOINTS - 500s, 429s and a socket that never answers, next to a
     * healthy control group. Exercises the retry engine and the circuit breaker
     * (5 consecutive failures opens it for 30s) while asking the same question
     * as the slow scenario: does the healthy group still get served?
     */
    case 'failing-endpoints':
      return {
        scenario,
        event_types: { failing: 'load.fail', fast: 'load.fast' },
        projects: [
          {
            key: 'failing',
            name: 'Load - failing endpoints',
            slug: 'load-failing-endpoints',
            ingest_limit: 5000,
            retry_policy: FAST_RETRY,
            endpoints: [
              ...range(s.failEndpoints).map((i) =>
                endpoint(`fail-${i}`, 'fail', 'failing', {
                  timeout_ms: 5000,
                  use_retry_policy: true,
                }),
              ),
              endpoint('throttled-1', 'throttled', 'throttled', {
                timeout_ms: 5000,
                use_retry_policy: true,
              }),
              endpoint('timeout-1', 'timeout', 'timeout', {
                // The sink never answers; this is what ends the attempt.
                timeout_ms: 2000,
                use_retry_policy: true,
              }),
              ...range(s.failControlEndpoints).map((i) =>
                endpoint(`fast-${i}`, 'fast', 'fast', { timeout_ms: 5000 }),
              ),
            ],
            subscriptions: [
              ...range(s.failEndpoints).map((i) => ({
                endpoint_key: `fail-${i}`,
                event_types: ['load.fail'],
              })),
              { endpoint_key: 'throttled-1', event_types: ['load.fail'] },
              { endpoint_key: 'timeout-1', event_types: ['load.fail'] },
              ...range(s.failControlEndpoints).map((i) => ({
                endpoint_key: `fast-${i}`,
                event_types: ['load.fast'],
              })),
            ],
          },
        ],
      };

    /**
     * MANY TENANTS - tenant 1 is the noisy neighbour with slow endpoints and a
     * high publish rate; the rest are quiet and fast. They are separate
     * PROJECTS under one organization, which is both the shape the concurrency
     * ceilings are expressed in (MAX_CONCURRENCY_PER_PROJECT) and the only
     * shape a re-runnable seed can build: POST /v1/organizations is throttled
     * to ten per hour per address.
     */
    case 'many-tenants':
      return {
        scenario,
        event_types: { tenant: 'load.tenant' },
        noisy_tenant: 'tenant-1',
        projects: range(s.tenants).map((t) => {
          const noisy = t === 1;
          const group = noisy ? 'noisy' : 'quiet';
          return {
            key: `tenant-${t}`,
            name: `Load - tenant ${t}`,
            slug: `load-tenant-${t}`,
            ingest_limit: 2000,
            noisy,
            endpoints: range(s.tenantEndpoints).map((i) =>
              endpoint(
                `t${t}-ep-${i}`,
                noisy ? 'slow' : 'fast',
                group,
                noisy
                  ? {
                      timeout_ms: Math.min(120000, s.slowMs * 2 + 5000),
                      query: { delay_ms: s.slowMs, tenant: t },
                    }
                  : { timeout_ms: 5000, query: { tenant: t } },
              ),
            ),
            subscriptions: range(s.tenantEndpoints).map((i) => ({
              endpoint_key: `t${t}-ep-${i}`,
              event_types: ['load.tenant'],
            })),
          };
        }),
      };

    /**
     * LARGE PAYLOADS - events above PAYLOAD_INLINE_MAX_BYTES, which the ingest
     * path offloads to object storage and the worker must fetch back before it
     * can sign and send. Proves the offload boundary works under load and
     * measures what the extra round trip costs.
     */
    case 'large-payloads':
      return {
        scenario,
        event_types: { large: 'load.large' },
        payload_bytes: config.sizes.largePayloadBytes,
        projects: [
          {
            key: 'large',
            name: 'Load - large payloads',
            slug: 'load-large-payloads',
            ingest_limit: 2000,
            endpoints: range(s.largeEndpoints).map((i) =>
              endpoint(`large-${i}`, 'fast', 'large', { timeout_ms: 15000 }),
            ),
            subscriptions: range(s.largeEndpoints).map((i) => ({
              endpoint_key: `large-${i}`,
              event_types: ['load.large'],
            })),
          },
        ],
      };

    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
}

/** The endpoint URL the control plane will store, behaviour and all. */
export function urlFor(ep) {
  return sinkUrl(ep.profile, ep.port ?? config.sinkPort, {
    group: ep.group,
    key: ep.key,
    ...ep.query,
  });
}
