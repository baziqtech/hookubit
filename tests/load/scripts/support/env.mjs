/**
 * Shared configuration for the load suite's Node-side tooling.
 *
 * The Go data plane does not read `.env` (docs/LOCAL_SETUP.md 5) but these
 * scripts do, because they must talk to the SAME database and the SAME object
 * store the running services were started with. Reading the repo's `.env` is
 * how the suite stays honest about that: if you point the data plane somewhere
 * else, you point this somewhere else too, in one place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
export const LOAD_ROOT = path.join(REPO_ROOT, 'tests/load');
export const ARTIFACTS = path.join(LOAD_ROOT, '.artifacts');

/** Parse the repo `.env` without adding a dependency. Existing process env wins. */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const int = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  controlApi: process.env.LOAD_CONTROL_API ?? 'http://localhost:3000',
  ingest: process.env.LOAD_INGEST_URL ?? `http://localhost:${process.env.INGEST_PORT ?? 8080}`,
  metrics:
    process.env.LOAD_METRICS_URL ??
    `http://localhost:${process.env.DATA_PLANE_METRICS_PORT ?? 9090}`,
  sink: process.env.LOAD_SINK_URL ?? `http://127.0.0.1:${process.env.LOAD_SINK_PORT ?? 8091}`,
  sinkHost: process.env.LOAD_SINK_HOST ?? '127.0.0.1',
  sinkPort: int('LOAD_SINK_PORT', 8091),
  /**
   * How many ports the sink listens on, and therefore how many DISTINCT
   * destination hosts the endpoints are spread over.
   *
   * The data plane holds at most EGRESS_MAX_CONNS_PER_HOST connections to any
   * one host:port, shared by every endpoint and tenant resolving there. That
   * used to be a hardcoded 16 (IdleConnsPerHost 4, times four, in
   * cmd/webhookd/roles.go) and it made a single-port sink a measurement of Go's
   * connection pool rather than of the scheduler. It now defaults to
   * WORKER_CONCURRENCY, so the ceiling is no longer below the pool - but it is
   * still a per-HOST number, and endpoints are still allocated so that
   * different GROUPS never share a port, which is what production looks like.
   *
   * Set LOAD_SINK_PORTS=1 on purpose to put every group back on one host. That
   * is the topology that exposed the old ceiling and the one to re-run if you
   * suspect it has come back.
   */
  sinkPorts: int('LOAD_SINK_PORTS', 8),
  databaseUrl: process.env.LOAD_DATABASE_URL ?? process.env.DATABASE_URL,

  /** Everything the suite creates lives under this one organization. */
  orgName: process.env.LOAD_ORG_NAME ?? 'HookuBit Load Tests',
  orgSlug: process.env.LOAD_ORG_SLUG ?? 'hookubit-load-tests',

  /**
   * The operator account the seed drives the control API as. It is created by
   * the seed if it does not exist and is NEVER the human developer's account -
   * see scripts/support/api.mjs for why exactly one row is written directly.
   */
  operatorEmail: process.env.LOAD_OPERATOR_EMAIL ?? 'load-test@hookubit.invalid',
  operatorPassword: process.env.LOAD_OPERATOR_PASSWORD ?? null,

  /** Sizing. Every one of these is a knob because the right value is the one
   *  that saturates YOUR machine, not the one that saturated ours. */
  sizes: {
    fanoutEndpoints: int('LOAD_FANOUT_ENDPOINTS', 25),
    slowEndpoints: int('LOAD_SLOW_ENDPOINTS', 6),
    /**
     * The per-endpoint concurrency ceiling given to SLOW endpoints.
     *
     * This is the most important number in the suite. Isolation is enforced by
     * per-endpoint caps, but caps bound one endpoint - they do not reserve
     * capacity for anyone else. When
     *
     *     slowEndpoints x slowMaxConcurrency  >=  WORKER_CONCURRENCY
     *
     * the slow endpoints can collectively hold every slot in the pool and the
     * fast ones wait, however small each individual cap is. The default (6 x 16
     * = 96 against a pool of 64) is deliberately over that line, because that
     * is the configuration a customer arrives at by accident. Set it to 4
     * (6 x 4 = 24 of 64) to run the control experiment.
     */
    slowMaxConcurrency: int('LOAD_SLOW_MAX_CONCURRENCY', 16),
    slowControlEndpoints: int('LOAD_SLOW_CONTROL_ENDPOINTS', 4),
    slowMs: int('LOAD_SLOW_MS', 5000),
    failEndpoints: int('LOAD_FAIL_ENDPOINTS', 4),
    failControlEndpoints: int('LOAD_FAIL_CONTROL_ENDPOINTS', 3),
    tenants: int('LOAD_TENANTS', 5),
    tenantEndpoints: int('LOAD_TENANT_ENDPOINTS', 2),
    largeEndpoints: int('LOAD_LARGE_ENDPOINTS', 2),
    largePayloadBytes: int('LOAD_LARGE_PAYLOAD_BYTES', 96 * 1024),
  },

  payloadInlineMaxBytes: int('PAYLOAD_INLINE_MAX_BYTES', 64 * 1024),
  payloadMaxBytes: int('PAYLOAD_MAX_BYTES', 1024 * 1024),
};

export const SCENARIOS = [
  'fanout',
  'slow-endpoints',
  'failing-endpoints',
  'many-tenants',
  'large-payloads',
];

export function manifestPath(scenario) {
  return path.join(ARTIFACTS, `manifest-${scenario}.json`);
}

export function ensureArtifacts() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  return ARTIFACTS;
}

/** Small ANSI helpers; the runner output is read by a human deciding pass or fail. */
const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};
