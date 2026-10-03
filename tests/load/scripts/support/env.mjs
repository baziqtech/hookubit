/**
 * Shared configuration for the load suite's Node-side tooling.
 *
 * The Go data plane does not read `.env` (docs/LOCAL_SETUP.md 5) but these
 * scripts do, because they must talk to the SAME database the running services
 * were started with and size themselves against the SAME worker settings.
 * Reading the repo's env files is how the suite stays honest about that: if you
 * point the data plane somewhere else, you point this somewhere else too, in
 * one place.
 *
 * SINCE THE THREE-FILE SPLIT THAT IS TWO FILES, NOT ONE. What the suite reads
 * is spread across them:
 *
 *   .env                      DATABASE_URL  (the nine both planes read)
 *   services/data-plane/.env  INGEST_PORT, DATA_PLANE_METRICS_PORT,
 *                             PAYLOAD_INLINE_MAX_BYTES, PAYLOAD_MAX_BYTES
 *
 * apps/control-api/.env is deliberately NOT read. Nothing here needs a
 * control-plane-only key - the suite talks to the control API over HTTP, as a
 * customer would - and loading it would put JWT_SECRET and SESSION_SECRET in
 * this process's environment for no reason. Add it here if that ever changes,
 * ahead of the common file, not behind it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
export const LOAD_ROOT = path.join(REPO_ROOT, 'tests/load');
export const ARTIFACTS = path.join(LOAD_ROOT, '.artifacts');

/**
 * The env files this suite reads, IN PRECEDENCE ORDER - service-specific first.
 *
 * `loadDotEnv` only fills a key that is still undefined, so the FIRST file to
 * define one wins and a real environment variable beats both. That is the same
 * resolution the services use from the other end: @nestjs/config walks
 * envFilePath doing `Object.assign(dotenv.parse(file), config)`, so earlier
 * entries win there too, and systemd gets there by listing the common file
 * first because a LATER EnvironmentFile= wins. Three parsers, one answer.
 */
export const ENV_FILES = [
  path.join(REPO_ROOT, 'services/data-plane/.env'),
  path.join(REPO_ROOT, '.env'),
];

/**
 * Parse one env file without adding a dependency. Existing process env wins.
 *
 * This is the third hand-written reader of this format in the repository - the
 * other two are `hb_env` in deployments/deployer/hookubit.php and systemd's own
 * EnvironmentFile parser - so it follows the same rules the templates enforce
 * and that apps/control-api/src/config/env-example.spec.ts checks: plain
 * KEY=value, no quotes, no `$`, no `export`, no trailing comments, and every
 * value on one physical line.
 *
 * A value continued with a trailing backslash THROWS rather than being read as
 * one line. Truncated at the `\` a connection string usually still parses, so
 * the quiet outcome is a load run that seeds and verifies against a different
 * database than the services are writing to - which is not a load test.
 */
export function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.endsWith('\\')) {
      throw new Error(
        `${file}: ${key} ends in a backslash. Put the whole value on one physical line - ` +
          'systemd would join it with the next one and this reader would not, so the ' +
          'services and this suite would disagree about where to look.',
      );
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

for (const file of ENV_FILES) loadDotEnv(file);

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
    wideEndpoints: int('LOAD_WIDE_ENDPOINTS', 25),
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
  'wide',
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
