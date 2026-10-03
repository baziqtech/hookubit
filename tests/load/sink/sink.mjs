#!/usr/bin/env node
/**
 * The load-test target sink.
 *
 * Its default behaviour is deliberately identical to the throwaway sink in
 * docs/LOCAL_SETUP.md: 200 with `{"ok":true}`, immediately, for any path. What
 * this adds is the ability to be told to be SLOW, to FAIL, or to answer 429 -
 * because scenarios 2 and 3 of the load suite have nothing to prove against a
 * target that always answers instantly.
 *
 * Behaviour is resolved per request, in this order:
 *
 *   1. query string on the delivery URL  - `?delay_ms=5000&status=500`
 *   2. named profile from the path       - `/sink/slow`, `/sink/fail`
 *   3. runtime override posted to        - `POST /_profiles/slow`
 *   4. the default                       - 200, no delay
 *
 * Query string wins because it makes an endpoint URL self-describing: the seed
 * writes the endpoint's whole behaviour into the row the control plane stores,
 * so an operator reading `endpoints.url` in psql can see what that endpoint was
 * configured to do without consulting this file.
 *
 * It is also the measurement point for END-TO-END DELIVERY LATENCY. k6 can only
 * see ingest; the thing under test is delivery. Every event published by the
 * suite carries `published_at_ms`, so the moment a request lands here the sink
 * knows how long the whole path - accept, outbox, route, claim, sign, send -
 * actually took. Those samples are drained by the k6 collector scenario and
 * become the thresholds that encode the isolation claim.
 *
 * No dependencies, on purpose: this must start with `node sink.js` on a machine
 * where nothing has been installed.
 */

import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: argv } = parseArgs({
  options: {
    port: { type: 'string' },
    'slow-ms': { type: 'string' },
    quiet: { type: 'boolean' },
  },
  strict: false,
});

const PORT = Number(argv.port ?? process.env.LOAD_SINK_PORT ?? 8091);
/**
 * How many ports to listen on, all sharing one set of statistics.
 *
 * This is not a throughput knob - it exists because of a hard limit in the
 * thing under test. The data plane builds ONE egress client per process, and
 * its transport caps concurrent TCP connections PER DESTINATION HOST:PORT,
 * shared by every endpoint and every tenant pointing at that host.
 *
 * That cap was a hardcoded 16 (IdleConnsPerHost = 4, times four). Put every
 * load-test endpoint on one port and that ceiling - not the worker pool, not
 * the per-endpoint gate - was what the run measured: sixteen 5-second requests
 * would starve everything else on the same port, and the result said "no
 * isolation" when what it had found was a connection pool. It is now
 * EGRESS_MAX_CONNS_PER_HOST, defaulting to WORKER_CONCURRENCY, but it is still
 * a per-host bound, so the spread still models production.
 *
 * Spreading endpoints over ports models production, where different customers
 * are different hosts. Set LOAD_SINK_PORTS=1 to deliberately put them back on
 * one host and measure the per-host ceiling instead - that is a real scenario
 * too (one customer, one domain, many endpoints).
 */
const PORT_COUNT = Math.max(1, Number(argv.ports ?? process.env.LOAD_SINK_PORTS ?? 8));
const HOST = process.env.LOAD_SINK_HOST ?? '127.0.0.1';
const SLOW_MS = Number(argv['slow-ms'] ?? process.env.LOAD_SINK_SLOW_MS ?? 5000);
const QUIET = Boolean(argv.quiet ?? process.env.LOAD_SINK_QUIET);

/** Latency samples are drained by the collector; the buffer is capped so a run
 *  nobody is draining cannot grow the heap without bound. */
const MAX_PENDING_SAMPLES = 200_000;
/** Delivery ids are kept to count duplicates (retries and at-least-once). Also
 *  capped - at a million ids this is already ~60 MB. */
const MAX_TRACKED_DELIVERIES = 1_000_000;

/**
 * Built-in profiles. `hold: true` means "never answer" - the endpoint's own
 * timeout_ms is what ends the attempt, which is the only honest way to test a
 * timeout: a sink that answers 504 quickly tests error handling, not timeouts.
 */
const BUILT_IN = {
  default: { status: 200, delayMs: 0 },
  fast: { status: 200, delayMs: 0 },
  slow: { status: 200, delayMs: SLOW_MS },
  fail: { status: 500, delayMs: 0 },
  flaky: { status: 200, delayMs: 0, failRate: 0.5, failStatus: 500 },
  throttled: { status: 429, delayMs: 0, retryAfter: 1 },
  timeout: { status: 200, delayMs: 0, hold: true },
};

/** Runtime overrides set through POST /_profiles/:name. */
const overrides = new Map();

const state = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  inFlight: 0,
  groups: new Map(),
  seenDeliveries: new Set(),
  duplicateDeliveries: 0,
  pendingSamples: [],
  droppedSamples: 0,
};

function groupStats(name) {
  let g = state.groups.get(name);
  if (!g) {
    g = {
      requests: 0,
      inFlight: 0,
      maxInFlight: 0,
      bytes: 0,
      byStatus: {},
      byAttempt: {},
      firstAt: null,
      lastAt: null,
      latencyCount: 0,
      latencySumMs: 0,
      latencyMaxMs: 0,
      latencyMs: [],
      signed: 0,
      unsigned: 0,
    };
    state.groups.set(name, g);
  }
  return g;
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve the behaviour for one delivery request. */
function resolveBehaviour(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  // /sink/<profile>/... or /<profile>
  const profileName =
    segments[0] === 'sink' ? (segments[1] ?? 'default') : (segments[0] ?? 'default');
  const base = overrides.get(profileName) ?? BUILT_IN[profileName] ?? BUILT_IN.default;
  const q = url.searchParams;

  return {
    profile: profileName,
    group: q.get('g') ?? profileName,
    endpoint: q.get('ep') ?? profileName,
    status: num(q.get('status'), base.status ?? 200),
    delayMs: num(q.get('delay_ms'), base.delayMs ?? 0),
    jitterMs: num(q.get('jitter_ms'), base.jitterMs ?? 0),
    failRate: num(q.get('fail_rate'), base.failRate ?? 0),
    failStatus: num(q.get('fail_status'), base.failStatus ?? 500),
    retryAfter: num(q.get('retry_after'), base.retryAfter ?? 0),
    hold: q.get('hold') === '1' || Boolean(base.hold),
  };
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
  });
  res.end(payload);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function snapshot({ withSamples = false } = {}) {
  const groups = {};
  for (const [name, g] of state.groups) {
    const sorted = [...g.latencyMs].sort((a, b) => a - b);
    groups[name] = {
      requests: g.requests,
      in_flight: g.inFlight,
      max_in_flight: g.maxInFlight,
      bytes: g.bytes,
      by_status: g.byStatus,
      by_attempt: g.byAttempt,
      signed: g.signed,
      unsigned: g.unsigned,
      first_at: g.firstAt,
      last_at: g.lastAt,
      delivery_latency_ms: {
        count: g.latencyCount,
        mean: g.latencyCount ? Math.round(g.latencySumMs / g.latencyCount) : null,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: g.latencyMaxMs || null,
      },
      ...(withSamples ? { samples: sorted } : {}),
    };
  }
  return {
    started_at: state.startedAt,
    now: new Date().toISOString(),
    total_requests: state.totalRequests,
    in_flight: state.inFlight,
    unique_deliveries: state.seenDeliveries.size,
    duplicate_deliveries: state.duplicateDeliveries,
    dropped_samples: state.droppedSamples,
    profiles: Object.fromEntries(
      [...new Set([...Object.keys(BUILT_IN), ...overrides.keys()])].map((n) => [
        n,
        overrides.get(n) ?? BUILT_IN[n],
      ]),
    ),
    groups,
  };
}

function resetStats() {
  state.totalRequests = 0;
  state.groups.clear();
  state.seenDeliveries.clear();
  state.duplicateDeliveries = 0;
  state.pendingSamples = [];
  state.droppedSamples = 0;
}

function readBody(req, limit = 8 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Pull `published_at_ms` out of the body without fully parsing a large payload. */
function publishedAtMs(body) {
  // The suite always puts it in the first 512 bytes of `data`.
  const head = body.subarray(0, 1024).toString('utf8');
  const m = /"published_at_ms"\s*:\s*(\d{10,16})/.exec(head);
  if (m) return Number(m[1]);
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const v = parsed?.published_at_ms ?? parsed?.data?.published_at_ms;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function handleControl(req, res, url) {
  const path = url.pathname;

  if (path === '/_healthz') return json(res, 200, { ok: true, started_at: state.startedAt });
  if (path === '/_stats') return json(res, 200, snapshot({ withSamples: url.searchParams.get('samples') === '1' }));

  if (path === '/_stats/drain') {
    const samples = state.pendingSamples;
    state.pendingSamples = [];
    return json(res, 200, {
      now_ms: Date.now(),
      dropped: state.droppedSamples,
      total_requests: state.totalRequests,
      in_flight: state.inFlight,
      samples,
    });
  }

  if (path === '/_reset' && req.method === 'POST') {
    resetStats();
    return json(res, 200, { ok: true, reset_at: new Date().toISOString() });
  }

  if (path.startsWith('/_profiles')) {
    const name = path.split('/')[2];
    if (req.method === 'GET') {
      return json(res, 200, snapshot().profiles);
    }
    if (req.method === 'POST' && name) {
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { error: 'body must be JSON' });
      }
      const merged = { ...(BUILT_IN[name] ?? BUILT_IN.default), ...parsed };
      overrides.set(name, merged);
      if (!QUIET) console.log(`profile ${name} =`, JSON.stringify(merged));
      return json(res, 200, { ok: true, profile: name, config: merged });
    }
    if (req.method === 'DELETE' && name) {
      overrides.delete(name);
      return json(res, 200, { ok: true, profile: name, config: BUILT_IN[name] ?? null });
    }
  }

  return json(res, 404, { error: 'unknown control route' });
}

function createServer() {
  return http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/_')) {
    handleControl(req, res, url).catch((err) => json(res, 500, { error: String(err) }));
    return;
  }

  const b = resolveBehaviour(url);
  const g = groupStats(b.group);
  const receivedAt = Date.now();

  state.totalRequests += 1;
  state.inFlight += 1;
  g.requests += 1;
  g.inFlight += 1;
  if (g.inFlight > g.maxInFlight) g.maxInFlight = g.inFlight;
  g.firstAt ??= new Date(receivedAt).toISOString();
  g.lastAt = new Date(receivedAt).toISOString();

  const deliveryId = req.headers['webhook-delivery-id'];
  const attempt = req.headers['webhook-attempt'] ?? '?';
  g.byAttempt[attempt] = (g.byAttempt[attempt] ?? 0) + 1;
  if (req.headers['webhook-signature']) g.signed += 1;
  else g.unsigned += 1;

  if (typeof deliveryId === 'string') {
    if (state.seenDeliveries.has(deliveryId)) state.duplicateDeliveries += 1;
    else if (state.seenDeliveries.size < MAX_TRACKED_DELIVERIES) state.seenDeliveries.add(deliveryId);
  }

  readBody(req)
    .then((body) => {
      g.bytes += body.length;

      // Only first attempts are recorded as delivery latency. A retry's clock
      // includes the backoff the retry policy deliberately imposed, and mixing
      // the two turns "the platform was slow" and "the endpoint was down" into
      // one indistinguishable number.
      const published = publishedAtMs(body);
      if (published && (attempt === '1' || attempt === '?')) {
        const latency = receivedAt - published;
        if (latency >= 0 && latency < 3_600_000) {
          g.latencyCount += 1;
          g.latencySumMs += latency;
          if (latency > g.latencyMaxMs) g.latencyMaxMs = latency;
          if (g.latencyMs.length < 200_000) g.latencyMs.push(latency);
          if (state.pendingSamples.length < MAX_PENDING_SAMPLES) {
            state.pendingSamples.push({
              g: b.group,
              ep: b.endpoint,
              ms: latency,
              at: receivedAt,
            });
          } else {
            state.droppedSamples += 1;
          }
        }
      }

      const finish = () => {
        if (b.hold) return; // never answers; the endpoint timeout ends it
        const failed = b.failRate > 0 && Math.random() < b.failRate;
        const status = failed ? b.failStatus : b.status;
        g.byStatus[status] = (g.byStatus[status] ?? 0) + 1;
        state.inFlight -= 1;
        g.inFlight -= 1;
        const headers = { 'content-type': 'application/json' };
        if (status === 429 && b.retryAfter > 0) headers['retry-after'] = String(b.retryAfter);
        res.writeHead(status, headers);
        res.end(status < 400 ? '{"ok":true}' : '{"ok":false}');
      };

      const delay = b.delayMs + (b.jitterMs > 0 ? Math.random() * b.jitterMs : 0);
      if (b.hold) {
        // Hold the socket. Release the in-flight counters when the client gives
        // up, or the counters only ever climb.
        req.on('close', () => {
          state.inFlight -= 1;
          g.inFlight -= 1;
          g.byStatus['timeout'] = (g.byStatus['timeout'] ?? 0) + 1;
        });
        return;
      }
      if (delay > 0) setTimeout(finish, delay);
      else finish();
    })
    .catch(() => {
      state.inFlight -= 1;
      g.inFlight -= 1;
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"body too large"}');
      }
    });
  });
}

const servers = [];
let listening = 0;
for (let i = 0; i < PORT_COUNT; i += 1) {
  const server = createServer();
  // A slow profile parks sockets for seconds; the defaults would close them.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;
  server.on('error', (err) => {
    console.error(`sink could not listen on ${HOST}:${PORT + i}: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT + i, HOST, () => {
    listening += 1;
    if (listening === PORT_COUNT) {
      const last = PORT + PORT_COUNT - 1;
      console.log(
        `load sink listening on http://${HOST}:${PORT}` +
          (PORT_COUNT > 1 ? `-${last} (${PORT_COUNT} ports, shared stats)` : ''),
      );
      console.log(`  profiles: ${Object.keys(BUILT_IN).join(', ')}  (slow = ${SLOW_MS}ms)`);
      console.log(`  control:  GET /_stats  GET /_stats/drain  POST /_reset  POST /_profiles/<name>`);
    }
  });
  servers.push(server);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal}: ${state.totalRequests} requests served`);
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
