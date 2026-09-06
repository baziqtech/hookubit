/**
 * In-memory stand-in for the control API.
 *
 * It exists because the dashboard and @webhook/control-api are being built in
 * parallel. It implements the paths in docs/API.md and returns the same error
 * envelope, so features written against it need no change when the real client
 * arrives — see the transport switch in `lib/api.ts`, which is the single file
 * that has to change.
 */
import type { ApiErrorBody, Delivery, EventDetail, Page, WebhookEvent } from '../../types/api';
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

function fail(status: number, code: ApiErrorBody['error']['code'], message: string): never {
  throw new MockHttpError(status, { error: { code, message, request_id: requestId() } });
}

/** Cursor pagination over a stable array; the cursor is just an offset, opaque to callers. */
function paginate<T>(items: T[], query: URLSearchParams): Page<T> {
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

function filterDeliveries(query: URLSearchParams): Delivery[] {
  const status = query.get('status');
  const endpointId = query.get('endpoint_id');
  const search = query.get('search')?.toLowerCase();

  return db.deliveries.filter((delivery) => {
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

function filterEvents(query: URLSearchParams): EventDetail[] {
  const eventType = query.get('event_type');
  const status = query.get('status');
  const search = query.get('search')?.toLowerCase();

  return db.events.filter((event) => {
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

  /* Organizations */
  { method: 'GET', pattern: '/v1/organizations', handle: () => ({ data: db.organizations }) },
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
    handle: ({ params }) => ({ data: db.members[params.orgId] ?? [] }),
  },
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/audit-logs',
    handle: ({ query }) => paginate(db.auditLogs, query),
  },
  { method: 'GET', pattern: '/v1/organizations/:orgId/usage', handle: () => db.usage },

  /* Projects */
  {
    method: 'GET',
    pattern: '/v1/projects',
    handle: ({ query }) => {
      const orgId = query.get('organization_id');
      return {
        data: orgId
          ? db.projects.filter((project) => project.organization_id === orgId)
          : db.projects,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId',
    handle: ({ params }) =>
      db.projects.find((project) => project.id === params.projectId) ??
      fail(404, 'not_found', `Project ${params.projectId} was not found`),
  },
  { method: 'GET', pattern: '/v1/projects/:projectId/endpoints', handle: () => ({ data: db.endpoints }) },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/subscriptions',
    handle: () => ({ data: db.subscriptions }),
  },
  { method: 'GET', pattern: '/v1/projects/:projectId/api-keys', handle: () => ({ data: db.apiKeys }) },
  { method: 'GET', pattern: '/v1/projects/:projectId/analytics', handle: () => db.analytics },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/events',
    handle: ({ query }) => paginate(filterEvents(query).map(withoutPayload), query),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/deliveries',
    handle: ({ query }) => paginate(filterDeliveries(query), query),
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
