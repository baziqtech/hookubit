/**
 * In-memory stand-in for the control API.
 *
 * It exists because the dashboard and @webhook/control-api are being built in
 * parallel. It implements the paths in docs/API.md and returns the same error
 * envelope, so features written against it need no change when the real client
 * arrives — see the transport switch in `lib/api.ts`, which is the single file
 * that has to change.
 */
import type {
  ApiErrorBody,
  ApiKey,
  CountedOffsetPage,
  CreatedApiKey,
  CreatedEndpoint,
  CursorPage,
  Delivery,
  Endpoint,
  EndpointSecret,
  EventDetail,
  Member,
  OffsetPage,
  Organization,
  Project,
  RotatedSecret,
  TotalPage,
  WebhookEvent,
} from '../../types/api';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../types/api';
import * as db from './data';

interface Handler {
  method: string;
  /** `:param` segments are captured by name. */
  pattern: string;
  handle: (context: {
    params: Record<string, string>;
    query: URLSearchParams;
    body: unknown;
  }) => unknown;
}

class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.error.message);
  }
}

let requestSeq = 0;
const requestId = () => `req_01JQMOCK${(requestSeq += 1).toString().padStart(4, '0')}`;

function fail(
  status: number,
  code: ApiErrorBody['error']['code'],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MockHttpError(status, {
    error: { code, message, details, request_id: requestId() },
  });
}

/**
 * Cursor pagination — MOCK-ONLY ROUTES.
 *
 * No control-plane module returns this shape. It is kept for events,
 * deliveries and audit logs, which have no module yet; everything that does
 * have one uses the offset envelopes below.
 */
function cursorPage<T>(items: T[], query: URLSearchParams): CursorPage<T> {
  const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
  const offset = Number(query.get('cursor') ?? 0) || 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit;
  return {
    data: slice,
    has_more: next < items.length,
    next_cursor: next < items.length ? String(next) : null,
  };
}

/**
 * `limit`/`offset` as the control API validates them.
 *
 * A `limit` above `MAX_PAGE_SIZE` is a 400, not a silent clamp: a caller that
 * asks for 5000 and receives 200 rows with no explanation believes it has
 * everything. `ScopedRepository` still clamps underneath as a safety net, but
 * the API answers the question honestly first.
 */
function readPaging(query: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = query.get('limit');
  const rawOffset = query.get('offset');
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    fail(400, 'invalid_request', `"limit" must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    fail(400, 'invalid_request', '"offset" must be an integer of at least 0.');
  }
  return { limit, offset };
}

/** `EndpointListDto` / `EndpointSecretListDto` — no `count`. */
function offsetEnvelope<T>(items: T[], query: URLSearchParams): OffsetPage<T> {
  const { limit, offset } = readPaging(query);
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  const hasMore = next < items.length;
  return { data: slice, has_more: hasMore, next_offset: hasMore ? next : null };
}

/** `ProjectListDto` / `ApiKeyListDto` — `count` is the rows in THIS page. */
function countedEnvelope<T>(items: T[], query: URLSearchParams): CountedOffsetPage<T> {
  const page = offsetEnvelope(items, query);
  return { ...page, count: page.data.length };
}

/** `OrganizationListDto` / `MemberListDto` — a real total, no `has_more`. */
function totalEnvelope<T>(items: T[], query: URLSearchParams): TotalPage<T> {
  const { limit, offset } = readPaging(query);
  return {
    data: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

/**
 * `?flag=false` must mean false.
 *
 * The control API's `BooleanQuery` compares the string instead of coercing it,
 * because `Boolean('false')` is `true` — which had `?include_deleted=false`
 * turning soft-deleted rows ON, with a 200. `true`/`1` are true, anything else
 * present is false, and an absent parameter stays undefined so the server's own
 * default applies. The mock mirrors it exactly, or it stops being a contract.
 */
function booleanQuery(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;
  return raw === 'true' || raw === '1';
}

/* ── Write limits ─────────────────────────────────────────────────────────── */

/**
 * Throttles and ceilings, kept distinct because the remedies are.
 *
 * A 429 is transient and carries `retry_after_seconds`. A ceiling is a 409 —
 * the control API has NO distinct code for one — and waiting does not clear it.
 * Both paths have to be reachable in the mock, or the UI that tells them apart
 * is never exercised before it meets a real user.
 */
const THROTTLE_LIMITS: Record<string, number> = {
  'projects.create': 20,
  'api-keys.create': 10,
  'endpoints.create': 60,
  'organizations.create': 10,
  'members.invite': 20,
  'endpoint-secrets.rotate': 30,
};

const throttleCounts = new Map<string, number>();

/** Test seam: the counters are process-wide, so a suite must be able to reset them. */
export function resetMockLimits(): void {
  throttleCounts.clear();
}

function charge(bucket: string): void {
  const limit = THROTTLE_LIMITS[bucket] ?? 60;
  const used = (throttleCounts.get(bucket) ?? 0) + 1;
  throttleCounts.set(bucket, used);
  if (used > limit) {
    fail(429, 'rate_limited', 'Too many attempts. Try again shortly.', {
      retry_after_seconds: 42,
    });
  }
}

/**
 * A resource ceiling, reported the way the real API reports one: 409 `conflict`
 * with prose. `details` is attached only where the real service attaches it —
 * projects and API keys do, endpoints and organizations do NOT — because the
 * dashboard's classifier has to cope with both and pretending otherwise would
 * hide the gap the backend still needs to close.
 */
function assertBelowCeiling(
  current: number,
  limit: number,
  message: string,
  withDetails: boolean,
): void {
  if (current < limit) return;
  fail(409, 'conflict', message, withDetails ? { limit, current } : undefined);
}

function requireBody<T extends Record<string, unknown>>(body: unknown, fields: string[]): T {
  if (typeof body !== 'object' || body === null) {
    fail(400, 'invalid_request', 'A JSON body is required');
  }
  const record = body as Record<string, unknown>;
  for (const field of fields) {
    if (!record[field]) {
      fail(400, 'invalid_request', `${field} is required`);
    }
  }
  return record as T;
}

/** Deliveries for one event, ordered so the failing rows are on top. */
function deliveriesForEvent(eventId: string): Delivery[] {
  return db.deliveries.filter((delivery) => delivery.event_id === eventId);
}

function filterDeliveries(projectId: string, query: URLSearchParams): Delivery[] {
  const status = query.get('status');
  const endpointId = query.get('endpoint_id');
  const search = query.get('search')?.toLowerCase();

  return db.deliveries.filter((delivery) => {
    // Tenant scoping is the whole point of a project. Without it every project
    // in the switcher serves the same rows, and a brand-new project looks like
    // it already has 64 events — which is exactly the state the first-run
    // experience has to be designed against.
    if (delivery.project_id !== projectId) return false;
    if (status && delivery.status !== status) return false;
    if (endpointId && delivery.endpoint_id !== endpointId) return false;
    if (
      search &&
      !`${delivery.id} ${delivery.event_id} ${delivery.event_type} ${delivery.endpoint_name}`
        .toLowerCase()
        .includes(search)
    ) {
      return false;
    }
    return true;
  });
}

function filterEvents(projectId: string, query: URLSearchParams): EventDetail[] {
  const eventType = query.get('event_type');
  const status = query.get('status');
  const search = query.get('search')?.toLowerCase();

  return db.events.filter((event) => {
    if (event.project_id !== projectId) return false;
    if (eventType && event.event_type !== eventType) return false;
    if (status && event.status !== status) return false;
    if (search && !`${event.id} ${event.event_type}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

/** Event list rows omit the payload; only the detail route carries it. */
function withoutPayload(event: EventDetail): WebhookEvent {
  const summary: Record<string, unknown> = { ...event };
  delete summary.payload;
  delete summary.headers;
  return summary as unknown as WebhookEvent;
}

const handlers: Handler[] = [
  /* Auth */
  {
    method: 'GET',
    pattern: '/v1/auth/session',
    handle: () => ({ user: db.user, organizations: db.organizations }),
  },
  {
    method: 'POST',
    pattern: '/v1/auth/login',
    handle: ({ body }) => {
      const credentials = requireBody<{ email: string; password: string }>(body, [
        'email',
        'password',
      ]);
      // One rejected credential so the error path is reachable in the mock.
      if (credentials.password === 'wrong') {
        fail(401, 'unauthenticated', 'Email or password is incorrect');
      }
      return { user: { ...db.user, email: credentials.email }, organizations: db.organizations };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/register',
    handle: ({ body }) => {
      requireBody(body, ['name', 'email', 'password', 'organization_name']);
      // Always 202, no session and no cookie, byte-identical for a free address
      // and a taken one. A 409 here — or a session on the success path alone —
      // is an account-enumeration oracle; the real owner of a taken address is
      // emailed a notice instead. Registering does not sign anyone in.
      return { status: 'accepted' };
    },
  },
  { method: 'POST', pattern: '/v1/auth/logout', handle: () => ({ ok: true }) },
  {
    method: 'POST',
    pattern: '/v1/auth/forgot-password',
    handle: ({ body }) => {
      requireBody(body, ['email']);
      // Always 202: confirming which addresses exist is an enumeration oracle.
      return { status: 'accepted' };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/reset-password',
    handle: ({ body }) => {
      const input = requireBody<{ token: string }>(body, ['token', 'password']);
      if (input.token === 'expired') {
        fail(400, 'invalid_request', 'This reset link has expired. Request a new one.');
      }
      return { status: 'ok' };
    },
  },

  /* Organizations — TotalPage envelope: { data, total, limit, offset }. */
  {
    method: 'GET',
    pattern: '/v1/organizations',
    handle: ({ query }) => totalEnvelope<Organization>(db.organizations, query),
  },
  {
    method: 'POST',
    pattern: '/v1/organizations',
    handle: ({ body }) => {
      requireBody(body, ['name']);
      charge('organizations.create');
      /*
       * Per-USER ceiling. The real limit is MAX_ORGANIZATIONS_PER_USER = 10;
       * the mock uses the fixture count so the ceiling branch is actually
       * REACHABLE. A limit the mock can never hit is a UI path that first runs
       * in production — and this is the one ceiling that carries no `details`,
       * so it is the one the dashboard's message-matching fallback depends on.
       *
       * The real service attaches prose only, never { limit, current }, so
       * neither does the mock. See HANDOFF.md.
       */
      const MOCK_ORGANIZATION_CEILING = db.organizations.length;
      assertBelowCeiling(
        db.organizations.length,
        MOCK_ORGANIZATION_CEILING,
        `You already own ${MOCK_ORGANIZATION_CEILING} organizations, which is the limit. Delete one, or ask to have the limit raised.`,
        false,
      );
      fail(500, 'internal_error', 'The mock does not persist new organizations.');
    },
  },
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId',
    handle: ({ params }) =>
      db.organizations.find((org) => org.id === params.orgId) ??
      fail(404, 'not_found', `Organization ${params.orgId} was not found`),
  },
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/members',
    handle: ({ params, query }) =>
      totalEnvelope<Member>(db.members[params.orgId] ?? [], query),
  },
  {
    method: 'POST',
    pattern: '/v1/organizations/:orgId/members',
    handle: ({ body }) => {
      requireBody(body, ['email', 'role']);
      charge('members.invite');
      // Always 202 — whether the address is already a member, already has an
      // account, or is unknown. Anything else lets a member enumerate the
      // platform. No member row is created; the invitee redeems a token.
      return { status: 'accepted' };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/audit-logs',
    handle: ({ query }) => cursorPage(db.auditLogs, query),
  },
  { method: 'GET', pattern: '/v1/organizations/:orgId/usage', handle: () => db.usage },

  /* Projects — CountedOffsetPage, and nested under the organization. */
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/projects',
    handle: ({ params, query }) => {
      const status = query.get('status');
      const rows = db.projects.filter((project) => {
        if (project.organization_id !== params.orgId) return false;
        // Defaults to everything except `deleted`; pass `status=deleted`
        // explicitly to find out why a create 409'd on a slug.
        if (status) return project.status === status;
        return project.status !== 'deleted';
      });
      return countedEnvelope<Project>(rows, query);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/organizations/:orgId/projects',
    handle: ({ params, body }) => {
      const input = requireBody<{ name: string }>(body, ['name']);
      charge('projects.create');
      const existing = db.projects.filter(
        (project) => project.organization_id === params.orgId && project.status !== 'deleted',
      ).length;
      assertBelowCeiling(
        existing,
        100,
        `This organization already has ${existing} projects, which is its limit of 100. Delete a project you no longer need, or ask an operator to raise MAX_PROJECTS_PER_ORGANIZATION.`,
        true,
      );
      fail(500, 'internal_error', `The mock does not persist new projects ("${input.name}").`);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId',
    handle: ({ params }) =>
      db.projects.find((project) => project.id === params.projectId) ??
      fail(404, 'not_found', `Project ${params.projectId} was not found`),
  },

  /* Endpoints — OffsetPage, no `count`. */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/endpoints',
    handle: ({ params, query }) => {
      const status = query.get('status');
      // `include_deleted` is compared as a string, never coerced.
      const includeDeleted = booleanQuery(query, 'include_deleted') ?? false;
      const rows = db.endpoints.filter((endpoint) => {
        if (endpoint.project_id !== params.projectId) return false;
        if (!includeDeleted && endpoint.status === 'deleted') return false;
        if (status && endpoint.status !== status) return false;
        return true;
      });
      return offsetEnvelope<Endpoint>(rows, query);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/endpoints',
    handle: ({ params, body }) => {
      const input = requireBody<{ name: string; url: string }>(body, ['name', 'url']);
      charge('endpoints.create');
      const live = db.endpoints.filter(
        (endpoint) => endpoint.project_id === params.projectId && endpoint.status !== 'deleted',
      ).length;
      // No details on the wire for this one — prose only, like the real service.
      assertBelowCeiling(
        live,
        500,
        'This project already has 500 endpoints, which is the maximum. Delete one you no longer deliver to, or talk to us about a higher limit.',
        false,
      );

      /*
       * The permission split that decides whether this endpoint works.
       *
       * A caller WITHOUT `endpoint-secrets.write` (a developer) may create an
       * endpoint but may not receive its signing secret. So the secret is null,
       * `secret_pending` is true and the endpoint is PAUSED — it is NOT
       * delivering. Going live instead would sign every delivery with a key
       * nobody holds.
       *
       * The mock keys this off a header-free convention so both branches are
       * reachable: a name containing "developer" simulates the weaker role.
       */
      const canReadSecrets = !input.name.toLowerCase().includes('developer');
      const now = new Date().toISOString();
      const created: CreatedEndpoint = {
        id: `ep_01JQNEW${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`,
        project_id: params.projectId,
        name: input.name,
        url: input.url,
        description: null,
        status: canReadSecrets ? 'active' : 'paused',
        enabled: canReadSecrets,
        disabled_reason: canReadSecrets
          ? null
          : 'Awaiting a signing secret. Created by a caller without endpoint-secrets.write.',
        disabled_at: canReadSecrets ? null : now,
        timeout_ms: 30_000,
        max_concurrency: 16,
        rate_limit: null,
        rate_limit_window_seconds: 1,
        retry_policy_id: null,
        custom_headers: null,
        created_at: now,
        updated_at: now,
        secret: canReadSecrets ? `whsec_${'m0ck'.repeat(8)}` : null,
        secret_pending: !canReadSecrets,
        secret_version: 1,
      };
      return created;
    },
  },

  /* Endpoint secrets — OffsetPage of METADATA. No plaintext on any read. */
  {
    method: 'GET',
    pattern: '/v1/endpoints/:endpointId/secrets',
    handle: ({ params, query }) =>
      offsetEnvelope<EndpointSecret>(db.endpointSecrets[params.endpointId] ?? [], query),
  },
  {
    method: 'POST',
    pattern: '/v1/endpoints/:endpointId/secrets/rotate',
    handle: ({ params, body }) => {
      charge('endpoint-secrets.rotate');
      const existing = db.endpointSecrets[params.endpointId] ?? [];
      const overlapSeconds =
        typeof (body as { overlap_seconds?: number } | null)?.overlap_seconds === 'number'
          ? (body as { overlap_seconds: number }).overlap_seconds
          : 86_400;
      const version = Math.max(0, ...existing.map((secret) => secret.version)) + 1;
      const now = new Date();
      // Every prior version that still signs — including ones this rotation did
      // not move, because they are still emitting a v1= component.
      const overlapping = existing.filter((secret) => secret.active).map((secret) => secret.version);
      const rotated: RotatedSecret = {
        id: `sec_01JQNEW${version}`,
        endpoint_id: params.endpointId,
        version,
        active: true,
        expires_at: null,
        rotated_at: null,
        created_at: now.toISOString(),
        secret: `whsec_${'r0t4t3d'.repeat(4)}`,
        previous_secrets_expire_at:
          overlapping.length === 0 || overlapSeconds === 0
            ? null
            : new Date(now.getTime() + overlapSeconds * 1000).toISOString(),
        overlapping_versions: overlapping.sort((a, b) => b - a),
      };
      return rotated;
    },
  },

  /* API keys — CountedOffsetPage. */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/api-keys',
    handle: ({ params, query }) =>
      countedEnvelope<ApiKey>(
        db.apiKeys.filter((key) => key.project_id === params.projectId),
        query,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/api-keys',
    handle: ({ params, body }) => {
      const input = requireBody<{ name: string }>(body, ['name']);
      charge('api-keys.create');
      const live = db.apiKeys.filter(
        (key) => key.project_id === params.projectId && key.revoked_at === null,
      ).length;
      assertBelowCeiling(
        live,
        50,
        `This project already holds ${live} un-revoked API keys, which is its limit of 50. Revoke a key you no longer need, or ask an operator to raise MAX_API_KEYS_PER_PROJECT.`,
        true,
      );
      const now = new Date().toISOString();
      // The plaintext, returned exactly once. Only the SHA-256 hash is stored,
      // so nothing can reproduce it later — not this API, not psql.
      const created: CreatedApiKey = {
        id: `key_01JQNEW${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`,
        project_id: params.projectId,
        name: input.name,
        key_prefix: 'wk_live_9f2c',
        environment: 'live',
        status: 'active',
        scopes: [],
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
        created_at: now,
        key: 'wk_live_9f2cM0ckPl4int3xtK3yV4lu3Chars32',
      };
      return created;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/api-keys/:apiKeyId/revoke',
    handle: ({ params }) => {
      charge('api-keys.revoke');
      const key = db.apiKeys.find((candidate) => candidate.id === params.apiKeyId);
      if (!key) fail(404, 'not_found', `API key ${params.apiKeyId} was not found`);
      return { ...key, status: 'revoked', revoked_at: new Date().toISOString() };
    },
  },

  /* Subscriptions — SPECULATIVE: no control-plane module exists yet. */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/subscriptions',
    handle: ({ params }) => ({
      data: db.subscriptions.filter(
        (subscription) => subscription.project_id === params.projectId,
      ),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics',
    handle: ({ params }) => db.analyticsFor(params.projectId),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/events',
    handle: ({ params, query }) =>
      cursorPage(filterEvents(params.projectId, query).map(withoutPayload), query),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/deliveries',
    handle: ({ params, query }) => cursorPage(filterDeliveries(params.projectId, query), query),
  },

  /* Endpoints */
  {
    method: 'GET',
    pattern: '/v1/endpoints/:endpointId',
    handle: ({ params }) =>
      db.endpoints.find((endpoint) => endpoint.id === params.endpointId) ??
      fail(404, 'not_found', `Endpoint ${params.endpointId} was not found`),
  },

  /* Events */
  {
    method: 'GET',
    pattern: '/v1/events/:eventId',
    handle: ({ params }) =>
      db.events.find((event) => event.id === params.eventId) ??
      fail(404, 'not_found', `Event ${params.eventId} was not found`),
  },
  {
    method: 'GET',
    pattern: '/v1/events/:eventId/deliveries',
    handle: ({ params }) => ({ data: deliveriesForEvent(params.eventId) }),
  },
  {
    method: 'POST',
    pattern: '/v1/events/:eventId/replay',
    handle: ({ params }) => ({
      replayed: deliveriesForEvent(params.eventId).length,
      event_id: params.eventId,
    }),
  },

  /* Deliveries */
  {
    method: 'GET',
    pattern: '/v1/deliveries/:deliveryId',
    handle: ({ params }) => {
      const delivery = db.deliveries.find((candidate) => candidate.id === params.deliveryId);
      if (!delivery) fail(404, 'not_found', `Delivery ${params.deliveryId} was not found`);
      const event = db.events.find((candidate) => candidate.id === delivery.event_id);
      return {
        ...delivery,
        payload: event?.payload ?? null,
        request_headers: {
          'content-type': 'application/json',
          'webhook-id': delivery.event_id,
          'webhook-delivery-id': delivery.id,
          'webhook-event-type': delivery.event_type,
          'webhook-attempt': String(delivery.attempt_count),
          'webhook-timestamp': String(Math.floor(new Date(delivery.created_at).getTime() / 1000)),
          'webhook-signature': 't=1757155200,v1=6f2c…9a41,v1=b03e…1cc7',
        },
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/deliveries/:deliveryId/attempts',
    handle: ({ params }) => ({ data: db.attempts[params.deliveryId] ?? [] }),
  },
  {
    method: 'POST',
    pattern: '/v1/deliveries/:deliveryId/replay',
    handle: ({ params }) => ({ delivery_id: params.deliveryId, status: 'queued' }),
  },

  /* Health, so the existing overview probe keeps working. */
  { method: 'GET', pattern: '/health/ready', handle: () => ({ status: 'ok (mock)' }) },
];

function match(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

/** Latency band that keeps skeletons visible without making the UI feel slow. */
const LATENCY_MS = 180;

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const [pathname, search = ''] = path.split('?');
  const query = new URLSearchParams(search);

  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

  for (const handler of handlers) {
    if (handler.method !== method) continue;
    const params = match(handler.pattern, pathname);
    if (!params) continue;
    return handler.handle({ params, query, body }) as T;
  }

  throw new MockHttpError(404, {
    error: {
      code: 'not_found',
      message: `No mock handler for ${method} ${pathname}`,
      request_id: requestId(),
    },
  });
}

export { MockHttpError };
