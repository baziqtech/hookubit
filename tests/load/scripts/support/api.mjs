/**
 * A tiny control-plane client, plus the one place this suite writes SQL.
 *
 * EVERYTHING the load test needs - organization, projects, retry policies,
 * endpoints, subscriptions, API keys - is created by driving the real REST API,
 * so the seed exercises the same code path a customer would and a broken
 * control plane fails the seed instead of quietly producing a load test that
 * measures nothing.
 *
 * The single exception is the operator account itself, and it is deliberate:
 *
 *   - `POST /v1/auth/register` is gated by ALLOW_OPEN_REGISTRATION, which is
 *     false by default and should stay false (see .env.example).
 *   - `pnpm bootstrap` refuses to run once any user exists, and on a machine
 *     that has ever been developed on, one does.
 *   - Logging in as the developer's own account would need their password.
 *
 * So `ensureOperator` writes ONE users row - a dedicated, clearly-named,
 * non-routable-domain account - hashed with the same argon2id parameters the
 * control plane uses, and everything after that is HTTP. It never touches an
 * existing account it did not create.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ARTIFACTS, REPO_ROOT, config, ensureArtifacts } from './env.mjs';

/**
 * `@prisma/client` and `argon2` are already installed and generated for the
 * control plane. Requiring them through its package.json keeps the load suite
 * free of its own dependency tree - there is no `pnpm install` step to forget.
 */
const controlRequire = createRequire(path.join(REPO_ROOT, 'apps/control-api/package.json'));

/** The control plane's parameters, copied from src/auth/password.service.ts.
 *  If those change, a login here fails loudly rather than silently weakening. */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

function ulid() {
  // Crockford base32, monotonic enough for a seed. The control plane uses the
  // `ulid` package; ids only have to be well-formed and unique here.
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  const timeChars = [];
  for (let i = 0; i < 10; i += 1) {
    timeChars.unshift(ALPHABET[time % 32]);
    time = Math.floor(time / 32);
  }
  const rand = crypto.randomBytes(16);
  let randChars = '';
  for (let i = 0; i < 16; i += 1) randChars += ALPHABET[rand[i] % 32];
  return timeChars.join('') + randChars;
}

export const newId = (prefix) => `${prefix}_${ulid()}`;

export class ApiError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Cookie-jar HTTP client for the control API. */
export class ControlApi {
  constructor(baseUrl = config.controlApi) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, path, body, { expect } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) headers.cookie = this.cookieHeader();

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the raw text for the error message */
    }

    const ok = expect ? expect.includes(res.status) : res.ok;
    if (!ok) throw new ApiError(method, url, res.status, parsed);
    return { status: res.status, body: parsed };
  }

  get = (p, o) => this.request('GET', p, undefined, o);
  post = (p, b, o) => this.request('POST', p, b, o);
  patch = (p, b, o) => this.request('PATCH', p, b, o);
  del = (p, o) => this.request('DELETE', p, undefined, o);
}

let prismaSingleton = null;
export function prisma() {
  if (prismaSingleton) return prismaSingleton;
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set; cannot reach PostgreSQL');
  const { PrismaClient } = controlRequire('@prisma/client');
  prismaSingleton = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  return prismaSingleton;
}

export async function disconnect() {
  if (prismaSingleton) await prismaSingleton.$disconnect();
  prismaSingleton = null;
}

const credentialsFile = () => path.join(ARTIFACTS, 'operator.json');

function readCredentials() {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCredentials(creds) {
  ensureArtifacts();
  fs.writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Make sure the load-test operator exists and its password is one we know, then
 * log in. Returns a logged-in ControlApi.
 *
 * If LOAD_OPERATOR_PASSWORD is set the account is never modified beyond that -
 * that is the escape hatch for an environment where writing a users row is not
 * acceptable and someone has provisioned the account by hand.
 */
export async function ensureOperator() {
  const argon2 = controlRequire('argon2');
  const db = prisma();
  const email = config.operatorEmail.toLowerCase();

  let password = config.operatorPassword ?? readCredentials()?.password ?? null;
  const existing = await db.user.findUnique({ where: { email } });

  if (existing && config.operatorPassword) {
    // Caller supplied the password; trust it and do not touch the row.
  } else if (!existing) {
    password = password ?? crypto.randomBytes(24).toString('base64url');
    await db.user.create({
      data: {
        id: newId('usr'),
        email,
        name: 'Load Test Operator',
        passwordHash: await argon2.hash(password, ARGON2_OPTIONS),
        // Login refuses an unverified address (auth.service.ts). This account
        // will never receive mail, so verification is set at creation.
        emailVerifiedAt: new Date(),
        onboardingCompletedAt: new Date(),
      },
    });
    writeCredentials({ email, password });
  } else if (!password) {
    // The row exists but the credential file is gone. We own this account, so
    // resetting its password is safe and keeps the seed re-runnable.
    password = crypto.randomBytes(24).toString('base64url');
    await db.user.update({
      where: { email },
      data: {
        passwordHash: await argon2.hash(password, ARGON2_OPTIONS),
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        disabledAt: null,
      },
    });
    writeCredentials({ email, password });
  }

  const api = new ControlApi();
  try {
    await api.post('/v1/auth/login', { email, password });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !config.operatorPassword) {
      // Stale password in the artifacts file. Reset once, then retry.
      password = crypto.randomBytes(24).toString('base64url');
      await db.user.update({
        where: { email },
        data: { passwordHash: await argon2.hash(password, ARGON2_OPTIONS) },
      });
      writeCredentials({ email, password });
      await api.post('/v1/auth/login', { email, password });
    } else {
      throw err;
    }
  }
  return api;
}

/** The load organization, created through the API on first use. */
export async function ensureOrganization(api) {
  const { body } = await api.get('/v1/organizations?limit=100');
  const found = (body.data ?? body.items ?? body ?? []).find?.(
    (o) => o.slug === config.orgSlug || o.name === config.orgName,
  );
  if (found) return found;

  try {
    const created = await api.post('/v1/organizations', {
      name: config.orgName,
      slug: config.orgSlug,
    });
    return created.body;
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      throw new Error(
        'POST /v1/organizations is throttled to 10 per hour per address. The load ' +
          'organization could not be created. Wait, or set LOAD_ORG_SLUG to an ' +
          'organization that already exists.',
      );
    }
    throw err;
  }
}

export async function ensureProject(api, orgId, { name, slug, environment = 'test' }) {
  const { body } = await api.get(`/v1/organizations/${orgId}/projects?limit=100`);
  const list = body.data ?? body.items ?? [];
  const found = list.find((p) => p.slug === slug && p.status !== 'deleted');
  if (found) return found;
  const created = await api.post(`/v1/organizations/${orgId}/projects`, {
    name,
    slug,
    environment,
  });
  return created.body;
}

export async function mintApiKey(api, projectId, name) {
  const { body } = await api.post(`/v1/projects/${projectId}/api-keys`, { name });
  if (!body.key) {
    throw new Error(
      `API key ${body.id} was created without a plaintext key in the response. ` +
        'The suite cannot publish events without it.',
    );
  }
  return body;
}

export async function ensureRetryPolicy(api, projectId, policy) {
  const { body } = await api.get(`/v1/projects/${projectId}/retry-policies?limit=100`);
  const list = body.data ?? body.items ?? [];
  const found = list.find((p) => p.name === policy.name);
  if (found) return found;
  const created = await api.post(`/v1/projects/${projectId}/retry-policies`, policy);
  return created.body;
}

export async function ensureEndpoint(api, projectId, endpoint) {
  const { body } = await api.get(`/v1/projects/${projectId}/endpoints?limit=200`);
  const list = body.data ?? body.items ?? [];
  const found = list.find((e) => e.name === endpoint.name);
  if (found) {
    // The URL carries the behaviour (delay, status, group), so a re-seed with
    // different sizing must update it rather than silently keep the old shape.
    const needsUpdate =
      found.url !== endpoint.url ||
      found.max_concurrency !== endpoint.max_concurrency ||
      found.timeout_ms !== endpoint.timeout_ms ||
      (endpoint.retry_policy_id ?? null) !== (found.retry_policy_id ?? null) ||
      found.status === 'disabled' ||
      found.enabled === false;
    if (!needsUpdate) return found;
    const patched = await api.patch(`/v1/projects/${projectId}/endpoints/${found.id}`, {
      url: endpoint.url,
      max_concurrency: endpoint.max_concurrency,
      timeout_ms: endpoint.timeout_ms,
      retry_policy_id: endpoint.retry_policy_id ?? null,
    });
    if (patched.body.status === 'disabled' || patched.body.enabled === false) {
      // A previous failing-endpoint run left the circuit breaker's mark on it.
      await api.post(`/v1/projects/${projectId}/endpoints/${found.id}/enable`, {});
    }
    return patched.body;
  }
  const created = await api.post(`/v1/projects/${projectId}/endpoints`, endpoint);
  return created.body;
}

export async function ensureSubscription(api, projectId, subscription) {
  const { body } = await api.get(`/v1/projects/${projectId}/subscriptions?limit=200`);
  const list = body.data ?? body.items ?? [];
  const found = list.find((s) => s.name === subscription.name);
  if (found) {
    const same =
      found.endpoint_id === subscription.endpoint_id &&
      JSON.stringify(found.event_types) === JSON.stringify(subscription.event_types) &&
      found.enabled;
    if (same) return found;
    const patched = await api.patch(`/v1/projects/${projectId}/subscriptions/${found.id}`, {
      event_types: subscription.event_types,
    });
    if (!patched.body.enabled) {
      await api.post(`/v1/projects/${projectId}/subscriptions/${found.id}/enable`, {});
    }
    return patched.body;
  }
  const created = await api.post(`/v1/projects/${projectId}/subscriptions`, subscription);
  return created.body;
}

/**
 * Raise the ingest ceiling for this project so the load test measures the
 * platform rather than its own rate limiter. Best-effort: an environment where
 * the caller may not write policies still runs, just at a lower ceiling.
 */
export async function ensureIngestCeiling(api, projectId, limit, windowSeconds = 1) {
  try {
    const { body } = await api.get(`/v1/projects/${projectId}/rate-limits?limit=50`);
    const list = body.data ?? body.items ?? [];
    const found = list.find((p) => p.scope === 'ingest' && !p.resource_id);
    if (found) {
      if (found.limit >= limit) return found;
      const patched = await api.patch(`/v1/projects/${projectId}/rate-limits/${found.id}`, {
        limit,
        window_seconds: windowSeconds,
        burst: limit * 2,
      });
      return patched.body;
    }
    const created = await api.post(`/v1/projects/${projectId}/rate-limits`, {
      scope: 'ingest',
      limit,
      window_seconds: windowSeconds,
      burst: limit * 2,
    });
    return created.body;
  } catch (err) {
    console.warn(`  ! could not set the ingest rate-limit policy: ${err.message}`);
    return null;
  }
}
