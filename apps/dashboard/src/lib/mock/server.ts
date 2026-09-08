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
  AuditLogEntry,
  CreatedApiKey,
  CreatedEndpoint,
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  Endpoint,
  EndpointSecret,
  EventDetail,
  Member,
  OffsetPage,
  Organization,
  Project,
  RetryPolicy,
  RotatedSecret,
  Subscription,
  WebhookEvent,
} from '../../types/api';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
} from '../../types/api';
import * as db from './data';
import { rejectEndpointPatch, rejectIdentityPatch } from './writes';

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
    // `message` is an array on a validation failure; join it for the `Error`
    // and leave `body` carrying the original, which is what the transport
    // normalises into per-field issues.
    const { message } = body.error;
    super(Array.isArray(message) ? message.join(' ') : message);
  }
}

let requestSeq = 0;
const requestId = () => `req_01JQMOCK${(requestSeq += 1).toString().padStart(4, '0')}`;

/**
 * `message` may be a STRING ARRAY, because on a 400 the real API's is.
 * `AppExceptionFilter` passes the global `ValidationPipe`'s array straight
 * through, so each rejected property arrives as its own `"<property>: <reason>"`
 * entry. A mock that flattened that to a sentence would let the dashboard's
 * per-field error placement rot untested until it met a real 400.
 */
function fail(
  status: number,
  code: ApiErrorBody['error']['code'],
  message: string | string[],
  details?: Record<string, unknown>,
): never {
  throw new MockHttpError(status, {
    error: { code, message, details, request_id: requestId() },
  });
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

/**
 * THE list envelope. Every `*ListDto` in the published document is this shape —
 * `{ data, has_more, next_offset }` — including organizations and members,
 * which used to carry `{ total, limit, offset }`, and projects and API keys,
 * which used to carry a `count`. Neither of those exists any more, so neither
 * is served here: a mock that disagrees with the schema is worse than no mock.
 */
function offsetEnvelope<T>(items: T[], query: URLSearchParams): OffsetPage<T> {
  const { limit, offset } = readPaging(query);
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  const hasMore = next < items.length;
  return { data: slice, has_more: hasMore, next_offset: hasMore ? next : null };
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
 * A 429 is transient and carries `retry_after_seconds`. A ceiling is a 409
 * `limit_exceeded` carrying `{ limit, current, resource }`, and waiting does not
 * clear it. Both paths have to be reachable in the mock, or the UI that tells
 * them apart is never exercised before it meets a real user.
 */
const THROTTLE_LIMITS: Record<string, number> = {
  'projects.create': 20,
  'projects.update': 30,
  'api-keys.create': 10,
  'endpoints.create': 60,
  // Small on purpose, like the other mock buckets: a throttle the mock cannot
  // reach is a UI path that first runs in production.
  'endpoints.update': 10,
  // Deliberately small. Enabling and disabling are the controls an operator
  // reaches for during an incident, which is exactly when a 429 on one of them
  // is most confusing — so the path has to be reachable here.
  'endpoints.toggle': 10,
  'organizations.create': 10,
  'organizations.update': 30,
  'members.invite': 20,
  'endpoint-secrets.rotate': 30,
};

const throttleCounts = new Map<string, number>();

/** Test seam: the counters are process-wide, so a suite must be able to reset them. */
export function resetMockLimits(): void {
  throttleCounts.clear();
}

/**
 * The fixtures as they were at module load.
 *
 * PATCH, enable and disable mutate `db` in place — they have to, or the UI
 * that invalidates a query after a mutation would refetch the old row and the
 * change would appear to have been lost. That makes the fixtures shared mutable
 * state across a test file, so there has to be a way back.
 */
const pristine = {
  endpoints: db.endpoints.map((endpoint) => ({ ...endpoint })),
  projects: db.projects.map((project) => ({ ...project })),
  organizations: db.organizations.map((organization) => ({ ...organization })),
};

/** Rewinds every write the mock has accepted, and the throttle counters. */
export function resetMockState(): void {
  throttleCounts.clear();
  db.endpoints.splice(0, db.endpoints.length, ...pristine.endpoints.map((row) => ({ ...row })));
  db.projects.splice(0, db.projects.length, ...pristine.projects.map((row) => ({ ...row })));
  db.organizations.splice(
    0,
    db.organizations.length,
    ...pristine.organizations.map((row) => ({ ...row })),
  );
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
 * A resource ceiling, reported the way the real API reports one.
 *
 * `limit_exceeded`, NOT `conflict`, and always with
 * `{ limit, current, resource }`. That is now true of all four ceilings in the
 * control API — projects, API keys, endpoints (`endpoints.service.ts`
 * `requireHeadroom`) and organizations (`organizations.service.ts` `create`).
 * It was not always: two of them attached prose only, which is why the
 * dashboard once had to match on the sentence. The mock must not keep serving
 * the old shape, or the message-matching fallback would stay alive here long
 * after the reason for it was gone.
 */
function assertBelowCeiling(
  current: number,
  limit: number,
  message: string,
  resource: string,
): void {
  if (current < limit) return;
  fail(409, 'limit_exceeded', message, { limit, current, resource });
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

/**
 * A replay is a NEW delivery row pointing back at the original, not a reset of
 * it. Both rows survive, which is what stops the ledger lying about how many
 * times a consumer was called.
 */
function replayOf(delivery: Delivery): Delivery {
  const now = new Date().toISOString();
  return {
    ...delivery,
    id: `del_01JQRPL${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`,
    status: 'queued',
    terminal: false,
    attempt_count: 0,
    last_error: null,
    last_attempt_at: null,
    next_attempt_at: now,
    completed_at: null,
    replay_of_delivery_id: delivery.id,
    replayed_by: null,
    is_replay: true,
    created_at: now,
    updated_at: now,
  };
}

/** Deliveries for one event, ordered so the failing rows are on top. */
function deliveriesForEvent(eventId: string): Delivery[] {
  return db.deliveries.filter((delivery) => delivery.event_id === eventId);
}

/** Everything that has failed and not recovered — `?failing_now=true`. */
const FAILING_NOW = ['retrying', 'failed', 'exhausted'];

function filterDeliveries(projectId: string, query: URLSearchParams): Delivery[] {
  const status = query.get('status');
  const failingNow = booleanQuery(query, 'failing_now') ?? false;
  const endpointId = query.get('endpoint_id');
  const eventId = query.get('event_id');
  const eventType = query.get('event_type');
  const origin = query.get('origin');

  /*
   * The API REFUSES `status` and `failing_now` together rather than picking
   * one, because they contradict each other. The mock refuses it too — a mock
   * that quietly accepted the pair would let the UI ship a combination the real
   * API 400s on.
   */
  if (status && failingNow) {
    fail(400, 'invalid_request', [
      'failing_now: cannot be combined with status — they would contradict each other',
    ]);
  }

  return db.deliveries.filter((delivery) => {
    // Tenant scoping is the whole point of a project. Without it every project
    // in the switcher serves the same rows, and a brand-new project looks like
    // it already has 64 events — which is exactly the state the first-run
    // experience has to be designed against.
    if (delivery.project_id !== projectId) return false;
    if (status && delivery.status !== status) return false;
    if (failingNow && !FAILING_NOW.includes(delivery.status)) return false;
    if (endpointId && delivery.endpoint_id !== endpointId) return false;
    if (eventId && delivery.event_id !== eventId) return false;
    if (eventType) {
      // `event_type` is a JOIN to `events` — a delivery row does not carry it.
      const event = db.events.find((candidate) => candidate.id === delivery.event_id);
      if (event?.event_type !== eventType) return false;
    }
    if (origin === 'original' && delivery.is_replay) return false;
    if (origin === 'replay' && !delivery.is_replay) return false;
    return true;
  });
}

function filterEvents(projectId: string, query: URLSearchParams): EventDetail[] {
  const eventType = query.get('event_type');
  const status = query.get('status');
  // A case-insensitive SUBSTRING of the producer's key. There is no general
  // `search` parameter and the mock must not invent one.
  const idempotencyKey = query.get('idempotency_key')?.toLowerCase();

  if (idempotencyKey !== undefined && idempotencyKey.length > 0 && idempotencyKey.length < 3) {
    fail(400, 'invalid_request', ['idempotency_key: must be at least 3 characters']);
  }

  return db.events.filter((event) => {
    if (event.project_id !== projectId) return false;
    if (eventType && event.event_type !== eventType) return false;
    if (status && event.status !== status) return false;
    if (
      idempotencyKey &&
      !(event.idempotency_key ?? '').toLowerCase().includes(idempotencyKey)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * `EventDto` is `EventDetailDto` MINUS `payload`. `headers` stays: it is on the
 * list DTO too, so stripping it here would make the mock narrower than the
 * schema — the opposite failure, but a failure.
 */
function withoutPayload(event: EventDetail): WebhookEvent {
  const { payload: _payload, ...summary } = event;
  void _payload;
  return summary;
}

/** The endpoint, or the 404 that never distinguishes "gone" from "not yours". */
function endpointOr404(projectId: string, endpointId: string) {
  const endpoint = db.endpoints.find(
    (candidate) => candidate.id === endpointId && candidate.project_id === projectId,
  );
  if (!endpoint) {
    // One answer, one message, for "does not exist" and "belongs to another
    // tenant" alike. A 403 here would confirm that an id scraped from somewhere
    // else is live infrastructure belonging to someone.
    fail(404, 'not_found', `Endpoint ${endpointId} was not found`);
  }
  return endpoint;
}

/**
 * A deleted endpoint is kept forever so the delivery ledger stays readable, and
 * every write against one is refused. Not a 404: the caller is inside the
 * tenant and can still see the row through GET, so hiding it here would be
 * confusing rather than protective.
 */
function assertNotDeleted(status: string): void {
  if (status !== 'deleted') return;
  fail(
    409,
    'conflict',
    'This endpoint has been deleted. Deleted endpoints are kept so the delivery ledger stays ' +
      'readable, but they cannot be modified.',
  );
}

function assertRejections(rejections: string[]): void {
  if (rejections.length === 0) return;
  // An ARRAY, exactly as the ValidationPipe produces one.
  fail(400, 'invalid_request', rejections);
}

const handlers: Handler[] = [
  /* Auth */
  /*
   * `SessionResponseDto` is `{ user }` and NOTHING ELSE.
   *
   * The mock returned an `organizations` array alongside it, the login redirect
   * and the landing route both read `session.organizations[0]`, and neither
   * would have found anything against the real API. The list has its own route.
   */
  {
    method: 'GET',
    pattern: '/v1/auth/session',
    handle: () => ({ user: db.user }),
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
      return { user: { ...db.user, email: credentials.email } };
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

  /* Organizations — the one list envelope: { data, has_more, next_offset }. */
  {
    method: 'GET',
    pattern: '/v1/organizations',
    handle: ({ query }) => offsetEnvelope<Organization>(db.organizations, query),
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
       * in production.
       *
       * It answers `limit_exceeded` with `{ limit, current, resource }`, like
       * the real service does now — `organizations.service.ts` line 140.
       */
      const MOCK_ORGANIZATION_CEILING = db.organizations.length;
      assertBelowCeiling(
        db.organizations.length,
        MOCK_ORGANIZATION_CEILING,
        `You already own ${MOCK_ORGANIZATION_CEILING} organizations, which is the limit. Delete one, or ask to have the limit raised.`,
        'organizations',
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
    method: 'PATCH',
    pattern: '/v1/organizations/:orgId',
    handle: ({ params, body }) => {
      charge('organizations.update');
      const organization = db.organizations.find((org) => org.id === params.orgId);
      if (!organization) fail(404, 'not_found', `Organization ${params.orgId} was not found`);

      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(
        rejectIdentityPatch(input, {
          nameMin: ORGANIZATION_NAME_MIN_LENGTH,
          nameMax: ORGANIZATION_NAME_MAX_LENGTH,
          slugMax: ORGANIZATION_SLUG_MAX_LENGTH,
          kind: 'organization',
        }),
      );

      if (typeof input.slug === 'string') {
        const taken = db.organizations.some(
          (candidate) => candidate.id !== organization.id && candidate.slug === input.slug,
        );
        if (taken) fail(409, 'conflict', `The slug "${input.slug}" is already taken.`);
      }

      if (typeof input.name === 'string') organization.name = input.name;
      if (typeof input.slug === 'string') organization.slug = input.slug;
      organization.updated_at = new Date().toISOString();
      return organization;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/members',
    handle: ({ params, query }) =>
      offsetEnvelope<Member>(db.members[params.orgId] ?? [], query),
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
  /*
   * Audit logs — a REAL module, offset paged like everything else, gated on
   * `audit.read`.
   *
   * The mock has one session and no role switching, so the 403 branch is
   * reachable through `?as=viewer`. That exists only so the permission-denied
   * state can be seen without a second account: a viewer holds `members.read`
   * and NOT `audit.read`, and a page that renders that as a red "request
   * failed" with a retry button is a page nobody can act on.
   */
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/audit-logs',
    handle: ({ params, query }) => {
      if (query.get('as') === 'viewer') {
        fail(403, 'forbidden', 'This action requires the audit.read permission.');
      }
      const action = query.get('action');
      const resourceType = query.get('resource_type');
      const resourceId = query.get('resource_id');
      const userId = query.get('user_id');
      const after = query.get('created_after');
      const before = query.get('created_before');

      const rows = db.auditLogs.filter((entry) => {
        if (entry.organization_id !== params.orgId) return false;
        if (action && entry.action !== action) return false;
        if (resourceType && entry.resource_type !== resourceType) return false;
        if (resourceId && entry.resource_id !== resourceId) return false;
        if (userId && entry.user_id !== userId) return false;
        if (after && entry.created_at < after) return false;
        if (before && entry.created_at > before) return false;
        return true;
      });
      return offsetEnvelope<AuditLogEntry>(rows, query);
    },
  },
  { method: 'GET', pattern: '/v1/organizations/:orgId/usage', handle: () => db.usage },

  /* Projects — nested under the organization. */
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
      return offsetEnvelope<Project>(rows, query);
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
        'projects',
      );
      fail(500, 'internal_error', `The mock does not persist new projects ("${input.name}").`);
    },
  },
  /*
   * NESTED UNDER THE ORGANIZATION, like the list, because `ProjectsController`
   * is mounted at `organizations/:orgId/projects`. There is no top-level
   * `/v1/projects/:id` route on the real API and the mock no longer pretends
   * there is — a route the mock serves and the API does not is a 404 that first
   * appears the day the transport is switched.
   */
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/projects/:projectId',
    handle: ({ params }) =>
      db.projects.find(
        (project) =>
          project.id === params.projectId && project.organization_id === params.orgId,
      ) ?? fail(404, 'not_found', `Project ${params.projectId} was not found`),
  },
  {
    method: 'PATCH',
    pattern: '/v1/organizations/:orgId/projects/:projectId',
    handle: ({ params, body }) => {
      charge('projects.update');
      const project = db.projects.find(
        (candidate) =>
          candidate.id === params.projectId && candidate.organization_id === params.orgId,
      );
      if (!project) fail(404, 'not_found', `Project ${params.projectId} was not found`);
      if (project.status === 'deleted') {
        fail(409, 'conflict', 'This project has been deleted and cannot be modified.');
      }

      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(
        rejectIdentityPatch(input, {
          nameMin: PROJECT_NAME_MIN_LENGTH,
          nameMax: PROJECT_NAME_MAX_LENGTH,
          slugMax: PROJECT_SLUG_MAX_LENGTH,
          kind: 'project',
        }),
      );

      // A slug is unique within the organization. This is a plain `conflict`
      // and NOT a `limit_exceeded`: nothing has to be deleted to fix it.
      if (typeof input.slug === 'string') {
        const taken = db.projects.some(
          (candidate) =>
            candidate.organization_id === params.orgId &&
            candidate.id !== project.id &&
            candidate.slug === input.slug,
        );
        if (taken) {
          fail(409, 'conflict', `Another project in this organization already uses "${input.slug}".`);
        }
      }

      if (typeof input.name === 'string') project.name = input.name;
      if (typeof input.slug === 'string') project.slug = input.slug;
      project.updated_at = new Date().toISOString();
      return project;
    },
  },

  /* Endpoints. */
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
      // The URL is checked at CREATE as well as at update — the same mirror of
      // the Go dial-time guard — so an unusable URL is refused at save time
      // rather than becoming a day of silent delivery failures.
      assertRejections(rejectEndpointPatch({ name: input.name, url: input.url }));
      const live = db.endpoints.filter(
        (endpoint) => endpoint.project_id === params.projectId && endpoint.status !== 'deleted',
      ).length;
      assertBelowCeiling(
        live,
        500,
        'This project already has 500 endpoints, which is the maximum. Delete one you no longer deliver to, or talk to us about a higher limit.',
        'endpoints',
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
        // A create by someone who cannot read secrets returns secret_pending
        // and leaves the endpoint paused, so it has no live secret and
        // "Resume" on it will genuinely 409. Mirroring that here is the point
        // of the flag existing.
        has_live_secret: canReadSecrets,
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

  /* API keys. */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/api-keys',
    handle: ({ params, query }) =>
      offsetEnvelope<ApiKey>(
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
        'api-keys',
      );
      const now = new Date().toISOString();
      // The plaintext, returned exactly once. Only the SHA-256 hash is stored,
      // so nothing can reproduce it later — not this API, not psql.
      const created: CreatedApiKey = {
        // Effective scopes are re-derived at use time from the issuer's CURRENT
        // role, so a freshly minted key with no explicit scopes has none.
        effective_scopes: [],
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

  /* Subscriptions — offset paged, like every other list. */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/subscriptions',
    handle: ({ params, query }) => {
      const endpointId = query.get('endpoint_id');
      const enabled = booleanQuery(query, 'enabled');
      const rows = db.subscriptions.filter((subscription) => {
        if (subscription.project_id !== params.projectId) return false;
        if (endpointId && subscription.endpoint_id !== endpointId) return false;
        if (enabled !== undefined && subscription.enabled !== enabled) return false;
        return true;
      });
      return offsetEnvelope<Subscription>(rows, query);
    },
  },

  /*
   * Retry policies, scoped to the project.
   *
   * Only the first project has any. That is deliberate: the endpoint edit
   * form has to render an honest "this project has no policies" state, and a
   * mock where every project has some leaves that branch first running in
   * production.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/retry-policies',
    handle: ({ params, query }) => {
      const isDefault = booleanQuery(query, 'is_default');
      const rows = db.retryPolicies.filter((policy) => {
        if (policy.project_id !== params.projectId) return false;
        if (isDefault !== undefined && policy.is_default !== isDefault) return false;
        return true;
      });
      return offsetEnvelope<RetryPolicy>(rows, query);
    },
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
      offsetEnvelope<WebhookEvent>(
        filterEvents(params.projectId, query).map(withoutPayload),
        query,
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/deliveries',
    handle: ({ params, query }) =>
      offsetEnvelope<Delivery>(filterDeliveries(params.projectId, query), query),
  },

  /*
   * One endpoint, and the three writes against it.
   *
   * All nested under the project: `EndpointsController` is mounted at
   * `projects/:projectId/endpoints`, and the project id is what the tenant
   * resolver reads the organization off. (`/v1/endpoints/:id/secrets` above IS
   * top-level, because `EndpointSecretsController` is mounted separately. The
   * asymmetry is real.)
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/endpoints/:endpointId',
    // Returns soft-deleted endpoints too, with `status: "deleted"`, so a
    // delivery pointing at a removed endpoint is still readable.
    handle: ({ params }) => endpointOr404(params.projectId, params.endpointId),
  },
  {
    method: 'PATCH',
    pattern: '/v1/projects/:projectId/endpoints/:endpointId',
    handle: ({ params, body }) => {
      charge('endpoints.update');
      const endpoint = endpointOr404(params.projectId, params.endpointId);
      assertNotDeleted(endpoint.status);

      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      // The URL and the headers are re-validated on UPDATE with the same rules
      // as on create. That is the point of exercising it here: a form that only
      // ever saw a happy-path PATCH renders these as "request failed".
      assertRejections(rejectEndpointPatch(input));

      if (typeof input.name === 'string') endpoint.name = input.name;
      if (typeof input.url === 'string') endpoint.url = input.url.trim();
      if ('description' in input) {
        const description = input.description;
        endpoint.description =
          typeof description === 'string' && description.length > 0 ? description : null;
      }
      if (typeof input.timeout_ms === 'number') endpoint.timeout_ms = input.timeout_ms;
      if (typeof input.max_concurrency === 'number') {
        endpoint.max_concurrency = input.max_concurrency;
      }
      if ('rate_limit' in input) {
        endpoint.rate_limit = typeof input.rate_limit === 'number' ? input.rate_limit : null;
      }
      if (typeof input.rate_limit_window_seconds === 'number') {
        endpoint.rate_limit_window_seconds = input.rate_limit_window_seconds;
      }
      if ('retry_policy_id' in input) {
        endpoint.retry_policy_id =
          typeof input.retry_policy_id === 'string' ? input.retry_policy_id : null;
      }
      if ('custom_headers' in input) {
        const headers = input.custom_headers;
        // An empty map is stored as NULL, so "unset" has one representation.
        endpoint.custom_headers =
          headers && typeof headers === 'object' && Object.keys(headers).length > 0
            ? (headers as Record<string, string>)
            : null;
      }
      endpoint.updated_at = new Date().toISOString();
      return endpoint;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/endpoints/:endpointId/enable',
    handle: ({ params }) => {
      charge('endpoints.toggle');
      const endpoint = endpointOr404(params.projectId, params.endpointId);
      assertNotDeleted(endpoint.status);

      /*
       * The precondition that makes `enable` a route rather than a PATCH.
       *
       * With no active signing secret the data plane fails CLOSED — it will not
       * deliver unsigned — so enabling would queue failures rather than
       * deliveries. `ep_01JQPENDING` in the fixtures is exactly this endpoint:
       * created by a developer who could not be handed a secret. The branch has
       * to be reachable or the UI first meets it in production.
       */
      const active = (db.endpointSecrets[endpoint.id] ?? []).some((secret) => secret.active);
      if (!active) {
        fail(
          409,
          'conflict',
          'This endpoint has no active signing secret, so deliveries to it could not be signed. ' +
            'Rotate a secret and hand the plaintext to whoever runs the consumer, then enable it.',
        );
      }

      endpoint.enabled = true;
      endpoint.status = 'active';
      // Resuming clears the breaker's verdict. If the consumer is still broken
      // the breaker writes a new one — which is the whole reason the dashboard
      // says "resume anyway" rather than implying anything has been fixed.
      endpoint.disabled_reason = null;
      endpoint.disabled_at = null;
      endpoint.updated_at = new Date().toISOString();
      return endpoint;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/endpoints/:endpointId/disable',
    handle: ({ params, body }) => {
      charge('endpoints.toggle');
      const endpoint = endpointOr404(params.projectId, params.endpointId);
      assertNotDeleted(endpoint.status);

      const reason = (body as { reason?: unknown } | null)?.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
        fail(400, 'invalid_request', ['reason: must be a string of at most 200 characters']);
      }

      endpoint.enabled = false;
      endpoint.status = 'paused';
      // Operator intent, recorded and attributed. Queued deliveries are not
      // discarded; they wait.
      endpoint.disabled_reason = reason
        ? `Paused by ${db.user.email}: ${reason}`
        : `Paused by ${db.user.email}.`;
      endpoint.disabled_at = new Date().toISOString();
      endpoint.updated_at = endpoint.disabled_at;
      return endpoint;
    },
  },

  /*
   * Events and deliveries — ALL NESTED UNDER THE PROJECT.
   *
   * `EventsController` is mounted at `projects/:projectId/events` and
   * `DeliveriesController` at `projects/:projectId/deliveries`, so the
   * top-level `/v1/events/:id` and `/v1/deliveries/:id` routes the mock used to
   * serve do not exist. Every one of them would have 404'd the moment the
   * transport flipped. The project id in the path is what the tenant resolver
   * reads the organization off; it is a lookup key, never an authorization
   * claim.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/events/:eventId',
    handle: ({ params }) =>
      db.events.find(
        (event) => event.id === params.eventId && event.project_id === params.projectId,
      ) ?? fail(404, 'not_found', `Event ${params.eventId} was not found`),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/events/:eventId/deliveries',
    handle: ({ params, query }) =>
      offsetEnvelope<Delivery>(deliveriesForEvent(params.eventId), query),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/events/:eventId/replay',
    handle: ({ params }) => {
      // `ReplayResultDto` — the created rows, not a bare `{ replayed }` count.
      const originals = deliveriesForEvent(params.eventId);
      return {
        deliveries: originals.map((delivery) => replayOf(delivery)),
        replayed_count: originals.length,
        replay_of: originals.map((delivery) => delivery.id),
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId',
    handle: ({ params }) => {
      const delivery = db.deliveries.find(
        (candidate) =>
          candidate.id === params.deliveryId && candidate.project_id === params.projectId,
      );
      if (!delivery) fail(404, 'not_found', `Delivery ${params.deliveryId} was not found`);
      const event = db.events.find((candidate) => candidate.id === delivery.event_id);
      const endpoint = db.endpoints.find((candidate) => candidate.id === delivery.endpoint_id);
      const attempts = db.attempts[delivery.id] ?? [];

      /*
       * `DeliveryDetailDto` — the row, NESTED `event` and `endpoint` refs, the
       * embedded attempt history and `attempts_truncated`.
       *
       * There is no `payload` and no `request_headers` on a delivery. The
       * payload lives on the event (one copy, however many deliveries) and the
       * request headers on each attempt, because the signature is recomputed
       * per attempt. The mock served both on the delivery and neither exists.
       *
       * The embedded array is capped so `attempts_truncated` is REACHABLE: a
       * flag that is always false is a branch the UI never runs.
       */
      const EMBEDDED_ATTEMPT_LIMIT = 5;
      const detail: DeliveryDetail = {
        ...delivery,
        event: {
          id: delivery.event_id,
          event_type: event?.event_type ?? 'unknown',
          idempotency_key: event?.idempotency_key ?? null,
          created_at: event?.created_at ?? delivery.created_at,
        },
        endpoint: {
          id: delivery.endpoint_id,
          name: endpoint?.name ?? 'deleted endpoint',
          url: endpoint?.url ?? '',
          status: endpoint?.status ?? 'deleted',
          disabled_reason: endpoint?.disabled_reason ?? null,
        },
        attempts: attempts.slice(0, EMBEDDED_ATTEMPT_LIMIT),
        attempts_truncated: attempts.length > EMBEDDED_ATTEMPT_LIMIT,
      };
      return detail;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/attempts',
    handle: ({ params, query }) =>
      offsetEnvelope<DeliveryAttempt>(db.attempts[params.deliveryId] ?? [], query),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/replay',
    handle: ({ params }) => {
      const delivery = db.deliveries.find(
        (candidate) =>
          candidate.id === params.deliveryId && candidate.project_id === params.projectId,
      );
      if (!delivery) fail(404, 'not_found', `Delivery ${params.deliveryId} was not found`);
      // A NEW delivery row, not a reset of this one. Both stay in the ledger.
      return replayOf(delivery);
    },
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
