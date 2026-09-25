/**
 * In-memory stand-in for the control API.
 *
 * It exists because the dashboard and @hookubit/control-api are being built in
 * parallel. It implements the paths in docs/API.md and returns the same error
 * envelope, so features written against it need no change when the real client
 * arrives — see the transport switch in `lib/api.ts`, which is the single file
 * that has to change.
 */
import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorDetails,
  ApiKey,
  AuditLogEntry,
  CreatedApiKey,
  CreatedEndpoint,
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  DeliveryListItem,
  Endpoint,
  EndpointSecret,
  EventDetail,
  Member,
  NotificationDestination,
  OffsetPage,
  Organization,
  OutboxEntry,
  OutboxStatus,
  Project,
  RequeueResult,
  RetryPolicy,
  RotatedSecret,
  Subscription,
  WebhookEvent,
} from '../../types/api';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_REQUEUE_BATCH,
  MAX_REQUEUE_REASON_LENGTH,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  PAYLOAD_PREVIEW_MAX_CHARS,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
} from '../../types/api';
import * as analytics from './analytics';
import { parseAnalyticsQuery, parseSeriesQuery } from './analytics';
import * as db from './data';
import type { RateLimit, RateLimitScope } from '../../types/api';
import {
  MAX_RATE_LIMIT_POLICIES_PER_PROJECT,
  MAX_RETRY_POLICIES_PER_PROJECT,
} from '../../types/api';
import {
  DEFAULT_RETRY_SETTINGS,
  retryPolicyCoherenceIssues,
  type RetrySettings,
} from '../../features/retry-policies/retry-policy-rules';
import { rateLimitCoherenceIssues } from '../../features/rate-limits/rate-limit-rules';
import { rejectRateLimitBody, rejectRetryPolicyBody } from './writes';
import {
  isMemberRole,
  rejectDisableReason,
  rejectEndpointPatch,
  rejectIdentityPatch,
  rejectMemberChange,
  rejectProjectCreate,
  rejectSubscriptionCreate,
  rejectSubscriptionPatch,
  slugFromName,
} from './writes';

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

/** The one sentence `MembersService.accept` answers for every dead token. */
const INVALID_INVITATION = 'This invitation is invalid or has expired.';

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
  code: ApiErrorCode,
  message: string | string[],
  details?: ApiErrorDetails,
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
  // Every one of these causes MAIL to an address the caller chose, which is
  // why the real route is throttled harder than an ordinary write: a loop on
  // create is a way to send somebody a lot of confirmations using our
  // reputation.
  'notifications.create': 10,
  'organizations.create': 10,
  'organizations.update': 30,
  // `SUBSCRIPTION_CREATE_THROTTLE` is 30 a minute on the real route. The
  // mutate bucket (update, enable, disable, delete share one) is 120 there —
  // kept small here so the 429 branch on an incident-time control is reachable.
  'subscriptions.create': 30,
  'subscriptions.mutate': 20,
  'members.invite': 20,
  // Counted, not enforced per address, on the real route — the same posture
  // `auth.verify` takes. The number matches `InvitationsController`.
  'invitations.accept': 20,
  'endpoint-secrets.rotate': 30,
  // Sends mail to an address the caller typed, so it is the one auth route
  // the real API enforces per IP AND per address. Same number as the server.
  'auth.resend': 5,
  // As tight as event replay, and for the same reason: one call can put a
  // hundred events into the router's queue, each of which becomes real HTTP to
  // endpoints that were, very often, already failing. `OutboxController`
  // declares 10 per five minutes on BOTH requeue routes, sharing one bucket.
  'outbox.requeue': 10,
  // The real routes allow 60 per five minutes per address and the ceiling
  // tests below create dozens of rows, so these match the server rather than
  // being shrunk — the 429 path is already exercised on other buckets.
  'retry-policies.write': 60,
  'rate-limits.write': 60,
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
  user: { ...db.user },
  endpoints: db.endpoints.map((endpoint) => ({ ...endpoint })),
  projects: db.projects.map((project) => ({ ...project })),
  organizations: db.organizations.map((organization) => ({ ...organization })),
  // A requeue rewrites the outbox row AND flips its event `failed → received`.
  outbox: db.outbox.map((entry) => ({ ...entry })),
  events: db.events.map((event) => ({ ...event })),
  // Redemption consumes the token and can add an organization row.
  invitations: db.invitations.map((invitation) => ({ ...invitation })),
  // A role change rewrites a row; a removal deletes one.
  members: Object.fromEntries(
    Object.entries(db.members).map(([orgId, rows]) => [orgId, rows.map((row) => ({ ...row }))]),
  ),
  // Rotation appends a version and re-times the others; revocation retires one.
  endpointSecrets: Object.fromEntries(
    Object.entries(db.endpointSecrets).map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]),
  ),
  // Revocation is persisted, so the list reads back `revoked`.
  apiKeys: db.apiKeys.map((key) => ({ ...key })),
  // Create, PATCH, enable, disable and DELETE all mutate this list.
  subscriptions: db.subscriptions.map((subscription) => ({ ...subscription })),
  // Create, PATCH, set-default and DELETE all mutate these two lists.
  retryPolicies: db.retryPolicies.map((policy) => ({ ...policy })),
  rateLimitPolicies: db.rateLimitPolicies.map((policy) => ({ ...policy })),
};

/** Rewinds every write the mock has accepted, and the throttle counters. */
export function resetMockState(): void {
  throttleCounts.clear();
  Object.assign(db.user, pristine.user);
  db.endpoints.splice(0, db.endpoints.length, ...pristine.endpoints.map((row) => ({ ...row })));
  db.projects.splice(0, db.projects.length, ...pristine.projects.map((row) => ({ ...row })));
  db.organizations.splice(
    0,
    db.organizations.length,
    ...pristine.organizations.map((row) => ({ ...row })),
  );
  db.outbox.splice(0, db.outbox.length, ...pristine.outbox.map((row) => ({ ...row })));
  db.events.splice(0, db.events.length, ...pristine.events.map((row) => ({ ...row })));
  db.invitations.splice(
    0,
    db.invitations.length,
    ...pristine.invitations.map((row) => ({ ...row })),
  );
  db.retryPolicies.splice(
    0,
    db.retryPolicies.length,
    ...pristine.retryPolicies.map((row) => ({ ...row })),
  );
  db.rateLimitPolicies.splice(
    0,
    db.rateLimitPolicies.length,
    ...pristine.rateLimitPolicies.map((row) => ({ ...row })),
  );
  for (const key of Object.keys(db.members)) delete db.members[key];
  for (const [orgId, rows] of Object.entries(pristine.members)) {
    db.members[orgId] = rows.map((row) => ({ ...row }));
  }
  for (const key of Object.keys(db.endpointSecrets)) delete db.endpointSecrets[key];
  for (const [id, rows] of Object.entries(pristine.endpointSecrets)) {
    db.endpointSecrets[id] = rows.map((row) => ({ ...row }));
  }
  db.apiKeys.splice(0, db.apiKeys.length, ...pristine.apiKeys.map((row) => ({ ...row })));
  db.subscriptions.splice(
    0,
    db.subscriptions.length,
    ...pristine.subscriptions.map((row) => ({ ...row })),
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

/**
 * A delivery AS A LIST ROW: the row, plus the bounded payload preview that ONLY
 * the two list routes carry (`…/deliveries` and `…/events/:id/deliveries`).
 *
 * Derived from the EVENT's payload envelope every time rather than stored on the
 * fixture, so the mock cannot disagree with `GET /events/:id` about whether a
 * body is readable at all: the offloaded event and the aged-out one have no
 * `body`, so their rows have no preview, and their SIZE is still served —
 * exactly as the real ingest records it.
 *
 * The detail route and both replay routes keep serving plain `DeliveryDto`. A
 * preview there would be a null that reads as "unavailable" on a response that
 * never looked at the payload.
 */
function toListItem(delivery: Delivery): DeliveryListItem {
  const event = db.events.find((candidate) => candidate.id === delivery.event_id);
  const body = event?.payload.body ?? null;
  const size = event?.payload_size ?? null;

  // No readable bytes: offloaded, or past the retention window. `truncated` is
  // FALSE here, as the DTO promises — there is no preview for the body to be
  // longer than.
  if (body === null) {
    return { ...delivery, payload_preview: null, payload_size: size, payload_truncated: false };
  }

  // Sliced by CODE POINT, like the server: `String.prototype.slice` counts
  // UTF-16 code units and would cut a surrogate pair in half.
  const points = Array.from(body);
  const truncated = points.length > PAYLOAD_PREVIEW_MAX_CHARS;
  return {
    ...delivery,
    payload_preview: truncated ? points.slice(0, PAYLOAD_PREVIEW_MAX_CHARS).join('') : body,
    payload_size: size,
    payload_truncated: truncated,
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
  return { ...summary, deliveries: rollUpDeliveries(event) };
}

/**
 * What became of an event, counted from the same delivery fixture the list
 * routes serve — mirroring `EventsService.rollUpDeliveries` and
 * `delivery-rollup.ts`.
 *
 * `dropped` is the state that only exists here: routing COMPLETED (`status:
 * processed`) and produced no deliveries, because no subscription matched. It
 * is invisible in every other column because there is no delivery row to be
 * absent from.
 */
function rollUpDeliveries(event: EventDetail): WebhookEvent['deliveries'] {
  const rows = db.deliveries.filter((delivery) => delivery.event_id === event.id);

  const succeeded = rows.filter((row) => row.status === 'succeeded').length;
  const failed = rows.filter((row) => row.status === 'failed' || row.status === 'exhausted').length;
  const cancelled = rows.filter((row) => row.status === 'cancelled').length;
  const inFlight = rows.filter((row) =>
    ['pending', 'scheduled', 'queued', 'processing', 'retrying'].includes(row.status),
  ).length;

  const base = {
    total: rows.length,
    succeeded,
    failed,
    in_flight: inFlight,
    cancelled,
  };

  if (rows.length === 0) {
    return { ...base, state: event.status === 'processed' ? 'dropped' : 'received' };
  }
  if (inFlight > 0) return { ...base, state: 'in_progress' };
  if (succeeded === rows.length) return { ...base, state: 'delivered' };
  // Cancelled counts towards `all_failed`: not because a cancellation is a
  // failure, but because from the EVENT's point of view nothing arrived.
  if (succeeded === 0) return { ...base, state: 'all_failed' };
  return { ...base, state: 'partly_delivered' };
}

/**
 * One endpoint's health over the last hour, counted from the same delivery
 * fixture the list routes serve — mirroring `EndpointHealthService`.
 *
 * `success_rate_1h` is NULL, never 0, when nothing settled. The difference is
 * the whole point: 0 means every delivery we attempted failed, and an endpoint
 * with no traffic must never be rendered as one.
 *
 * `deliveries_waiting` is deliberately NOT hour-bounded. "What is queued behind
 * this problem?" is not a question about the last hour, and an endpoint stopped
 * for a day has a day of backlog.
 */
function endpointHealth(endpointId: string): Endpoint['health'] {
  const since = Date.now() - 3_600_000;
  const mine = db.deliveries.filter((delivery) => delivery.endpoint_id === endpointId);
  const recent = mine.filter((delivery) => new Date(delivery.created_at).getTime() >= since);

  const succeeded = recent.filter((delivery) => delivery.status === 'succeeded').length;
  const failing = recent.filter(
    (delivery) => delivery.status === 'failed' || delivery.status === 'exhausted',
  ).length;
  const settled = succeeded + failing;

  const waiting = mine.filter((delivery) =>
    ['pending', 'scheduled', 'queued', 'processing', 'retrying'].includes(delivery.status),
  ).length;

  const newest = mine.reduce<string | null>((latest, delivery) => {
    if (!latest) return delivery.created_at;
    return new Date(delivery.created_at) > new Date(latest) ? delivery.created_at : latest;
  }, null);

  return {
    success_rate_1h: settled === 0 ? null : Math.round((succeeded / settled) * 10_000) / 10_000,
    deliveries_1h: recent.length,
    deliveries_waiting: waiting,
    consecutive_failures: 0,
    opened_at: null,
    last_delivery_at: newest,
  };
}

/**
 * The same shape check `normaliseAllowedIps` applies on the server.
 *
 * Deliberately permissive about IPv6 beyond the character set: Go's net/netip
 * is the authority at the point of use, and a stricter parser that disagreed
 * with it would refuse addresses the data plane would have honoured.
 */
function looksLikeAddressOrBlock(entry: string): boolean {
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefix = slash === -1 ? null : entry.slice(slash + 1);

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const version = v4
    ? v4.slice(1).every((octet) => Number(octet) <= 255)
      ? 4
      : null
    : address.includes(':') && /^[0-9a-fA-F:.]+$/.test(address) && address.split('::').length <= 2
      ? 6
      : null;

  if (version === null) return false;
  if (prefix === null) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

/** The destination, or the 404 that never distinguishes "gone" from "not yours". */
function destinationOr404(projectId: string, destinationId: string) {
  const row = db.notificationDestinations.find(
    (candidate) => candidate.id === destinationId && candidate.project_id === projectId,
  );
  if (!row) fail(404, 'not_found', `Notification destination ${destinationId} was not found`);
  return row;
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
 * The actor's own membership in the organization, the target row, and the rows
 * the owner count is taken from. A caller who is not a member, or a membership
 * id that is not in this organization, is the same 404 — the tenant-scoped
 * repository matches zero rows for both.
 */
function memberChangeOr404(orgId: string, memberId: string) {
  const rows = db.members[orgId];
  const actor = rows?.find((row) => row.user_id === db.user.id);
  if (!rows || !actor) fail(404, 'not_found', `Organization ${orgId} was not found`);
  const target = rows.find((row) => row.id === memberId);
  if (!target) fail(404, 'not_found', `Member ${memberId} was not found`);
  return { actor, target, rows };
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

/* ── Subscriptions ────────────────────────────────────────────────────────── */

/**
 * The real default is `MAX_SUBSCRIPTIONS_PER_PROJECT = 500`. Eight here so the
 * `limit_exceeded` branch can be reached from the fixtures (the busy project
 * holds four) without a loop of five hundred creates.
 */
const MOCK_SUBSCRIPTION_CEILING = 8;
let subscriptionSeq = 0;

function projectOr404(projectId: string) {
  const project = db.projects.find(
    (candidate) => candidate.id === projectId && candidate.status !== 'deleted',
  );
  if (!project) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
  return project;
}

/** The subscription, or the layer's single 404 for absent and foreign ids alike. */
function subscriptionOr404(projectId: string, subscriptionId: string) {
  projectOr404(projectId);
  const subscription = db.subscriptions.find(
    (candidate) => candidate.id === subscriptionId && candidate.project_id === projectId,
  );
  if (!subscription) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
  return subscription;
}

/**
 * `requireEndpoint` on the service: an endpoint in THIS project (another
 * tenant's answers the same 404 as one that does not exist), and not deleted —
 * that is a 409 `conflict`, because the endpoint IS visible to the caller and
 * a subscription pointed at it could never deliver.
 */
function subscribableEndpoint(projectId: string, endpointId: string) {
  const endpoint = db.endpoints.find(
    (candidate) => candidate.id === endpointId && candidate.project_id === projectId,
  );
  if (!endpoint) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
  if (endpoint.status === 'deleted') {
    fail(
      409,
      'conflict',
      'That endpoint has been deleted, so a subscription pointed at it could never deliver. ' +
        'Pick another endpoint, or create a new one.',
      { endpoint_id: endpointId },
    );
  }
  return endpoint;
}

/* ── Outbox ───────────────────────────────────────────────────────────────── */

const OUTBOX_STATUSES: readonly OutboxStatus[] = ['pending', 'processing', 'processed', 'failed'];

/**
 * One message for "does not exist" and "belongs to another tenant" alike —
 * `CROSS_TENANT_MESSAGE` in the control API. These routes take an outbox id in
 * the path AND an event id in the query or body, so a 404 that said which KIND
 * of resource an id names would confirm the id is live infrastructure
 * belonging to somebody.
 */
const CROSS_TENANT_MESSAGE = 'Resource not found.';

/**
 * Outbox rows carry no project column; they are scoped through their event,
 * exactly as `ScopedRepository` scopes `event_outbox` on the server.
 */
function outboxInProject(projectId: string): OutboxEntry[] {
  const owned = new Set(
    db.events.filter((event) => event.project_id === projectId).map((event) => event.id),
  );
  return db.outbox.filter((entry) => owned.has(entry.event_id));
}

/** `forbidNonWhitelisted`: a filter the DTO does not declare is a 400, not a wider listing. */
function rejectUnknownQuery(query: URLSearchParams, allowed: readonly string[]): void {
  const rejections = [...query.keys()]
    .filter((key) => !allowed.includes(key))
    .map((key) => `property ${key} should not exist`);
  assertRejections(rejections);
}

function readRequeueBody(
  body: unknown,
  allowEventId: boolean,
): { reason?: string; event_id?: string } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const rejections: string[] = [];
  const allowed = allowEventId ? ['reason', 'event_id'] : ['reason'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) rejections.push(`property ${key} should not exist`);
  }
  if (record.reason !== undefined) {
    if (typeof record.reason !== 'string') rejections.push('reason: must be a string');
    else if (record.reason.length > MAX_REQUEUE_REASON_LENGTH) {
      rejections.push(
        `reason: must be shorter than or equal to ${MAX_REQUEUE_REASON_LENGTH} characters`,
      );
    }
  }
  if (record.event_id !== undefined) {
    if (typeof record.event_id !== 'string') rejections.push('event_id: must be a string');
    else if (record.event_id.length > 64) {
      rejections.push('event_id: must be shorter than or equal to 64 characters');
    }
  }
  assertRejections(rejections);
  return record as { reason?: string; event_id?: string };
}

/**
 * `OutboxService.returnToQueue`, mirrored write for write.
 *
 * The two BUDGETS reset — `unaccounted_attempts` and `failing_since` — because
 * the operator has looked at the row. `attempts` is NOT reset: it is monotonic,
 * and zeroing it would erase the number that separates "requeued four times
 * and keeps dying" from "first time". `last_error` and `routing_cursor` are
 * untouched — the evidence survives the recovery and a partial routing
 * resumes. `processed_at` clears because the row is no longer finished. The
 * event goes `failed → received`, guarded on `failed`.
 */
function returnToQueue(rows: OutboxEntry[]): OutboxEntry[] {
  const now = new Date().toISOString();
  for (const row of rows) {
    row.status = 'pending';
    row.available_at = now;
    row.processed_at = null;
    row.locked_by = null;
    row.locked_until = null;
    row.unaccounted_attempts = 0;
    row.failing_since = null;
    const event = db.events.find((candidate) => candidate.id === row.event_id);
    if (event && event.status === 'failed') event.status = 'received';
  }
  return rows;
}

/* ── Retry and rate-limit policies ────────────────────────────────────────── */

function retryPolicyOr404(projectId: string, policyId: string): RetryPolicy {
  const policy = db.retryPolicies.find(
    (candidate) => candidate.id === policyId && candidate.project_id === projectId,
  );
  // One answer for "does not exist" and "belongs to another tenant" alike —
  // `RetryPoliciesService.require` uses CROSS_TENANT_MESSAGE, never the
  // repository's own "Retry policy not found."
  if (!policy) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
  return policy;
}

function retrySettingsOf(policy: RetryPolicy): RetrySettings {
  return {
    strategy: policy.strategy,
    max_attempts: policy.max_attempts,
    initial_delay_ms: policy.initial_delay_ms,
    max_delay_ms: policy.max_delay_ms,
    multiplier: policy.multiplier,
    jitter_ratio: policy.jitter_ratio,
    max_retry_duration_ms: policy.max_retry_duration_ms,
  };
}

/** The settings half of a body, key by key — never a spread of the request. */
function retrySettingsPatch(input: Record<string, unknown>): Partial<RetrySettings> {
  const patch: Partial<RetrySettings> = {};
  if (typeof input.strategy === 'string') patch.strategy = input.strategy as RetrySettings['strategy'];
  for (const field of [
    'max_attempts',
    'initial_delay_ms',
    'max_delay_ms',
    'multiplier',
    'jitter_ratio',
    'max_retry_duration_ms',
  ] as const) {
    if (typeof input[field] === 'number') patch[field] = input[field] as number;
  }
  return patch;
}

/**
 * The cross-field rules, as the SERVICE raises them: one sentence, the field in
 * `details` — not the pipe's array. The dashboard's mirror produces the same
 * sentences, so this is the one place the mock and the form cannot disagree.
 */
function assertRetryCoherent(settings: RetrySettings): RetrySettings {
  const [issue] = retryPolicyCoherenceIssues(settings);
  if (issue) fail(400, 'invalid_request', issue.reason, { field: issue.field });
  return settings;
}

const RATE_LIMIT_SCOPE_VALUES: readonly RateLimitScope[] = [
  'organization',
  'project',
  'endpoint',
  'ingest',
];

function rateLimitOr404(projectId: string, policyId: string): RateLimit {
  const policy = db.rateLimitPolicies.find(
    (candidate) => candidate.id === policyId && candidate.project_id === projectId,
  );
  if (!policy) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
  return policy;
}

function assertRateLimitCoherent(settings: {
  limit: number;
  window_seconds: number;
  burst: number | null;
}) {
  const [issue] = rateLimitCoherenceIssues(settings);
  if (issue) fail(400, 'invalid_request', issue.reason, { field: issue.field });
  return settings;
}

function rateLimitResourceKind(scope: RateLimitScope): string {
  switch (scope) {
    case 'endpoint':
      return 'endpoint';
    case 'ingest':
      return 'API key';
    case 'project':
      return 'project';
    case 'organization':
      return 'organization';
  }
}

/**
 * `resolveRateLimitResource`, lookup for lookup. Null is legal at every scope
 * and means "every resource in this scope". A non-null id is resolved through
 * the table the scope names, INSIDE this project's tenant, so another
 * tenant's endpoint or key is the shared 404 — and a sibling project in the
 * same organization is a 400, because the caller can see it and needs to be
 * told the row would never be read.
 */
function resolveRateLimitResource(
  projectId: string,
  scope: RateLimitScope,
  resourceId: string | null,
): string | null {
  if (resourceId === null) return null;
  const project = db.projects.find((candidate) => candidate.id === projectId);
  if (!project) fail(404, 'not_found', CROSS_TENANT_MESSAGE);

  switch (scope) {
    case 'endpoint': {
      const endpoint = db.endpoints.find(
        (candidate) => candidate.id === resourceId && candidate.project_id === projectId,
      );
      if (!endpoint) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      return endpoint.id;
    }
    case 'ingest': {
      const key = db.apiKeys.find(
        (candidate) => candidate.id === resourceId && candidate.project_id === projectId,
      );
      if (!key) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      return key.id;
    }
    case 'project': {
      const named = db.projects.find(
        (candidate) =>
          candidate.id === resourceId && candidate.organization_id === project.organization_id,
      );
      if (!named) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      if (named.id !== projectId) {
        fail(
          400,
          'invalid_request',
          'resource_id at project scope must be null or this project’s own id; a policy ' +
            'row stored in one project and pointing at another is never read by anything.',
          { field: 'resource_id' },
        );
      }
      return named.id;
    }
    case 'organization': {
      if (resourceId !== project.organization_id) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      return resourceId;
    }
  }
}

/** One ceiling per `(scope, resource_id)`, the null row included. */
function requireUniqueRateLimit(
  projectId: string,
  scope: RateLimitScope,
  resourceId: string | null,
  excludeId: string | null,
): void {
  const existing = db.rateLimitPolicies.find(
    (candidate) =>
      candidate.project_id === projectId &&
      candidate.scope === scope &&
      candidate.resource_id === resourceId &&
      candidate.id !== excludeId,
  );
  if (!existing) return;
  const covers =
    resourceId === null
      ? `every ${rateLimitResourceKind(scope)} in this project`
      : `${rateLimitResourceKind(scope)} ${resourceId}`;
  fail(
    409,
    'conflict',
    `A ${scope}-scoped rate limit covering ${covers} already exists in this ` +
      'project. One ceiling per resource: update the existing policy instead of adding a ' +
      'second one, or the data plane would have two answers to one question.',
    { scope, resource_id: resourceId, existing_policy_id: existing.id },
  );
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
      // And one unverified account, so the resend path on the login page is
      // reachable too. 403 with the code, as `AuthService.login` answers it.
      if (credentials.password === 'unverified') {
        fail(
          403,
          'email_not_verified',
          'Confirm your email address before signing in. Request a new link if the last one expired.',
        );
      }
      return { user: { ...db.user, email: credentials.email } };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/verify-email',
    handle: ({ body }) => {
      const input = requireBody<{ token: string }>(body, ['token']);
      // Unknown, already consumed and expired are ONE outcome on the real API
      // — the same 400 and the same sentence — so the mock has one too. There
      // is no session cookie in the mock to set, and the real route sets none
      // either: the page it answers sends the user on to sign in.
      if (input.token === 'expired' || input.token === 'invalid') {
        fail(400, 'invalid_request', 'This verification link is invalid or has expired.');
      }
      db.user.email_verified = true;
      return { user: db.user };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/resend-verification',
    handle: ({ body }) => {
      // Throttle first, as the guard runs before validation on the server.
      charge('auth.resend');
      requireBody(body, ['email']);
      // Always 202 with this exact body: registered, unknown, verified and
      // disabled addresses are indistinguishable by design.
      return { status: 'accepted' };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/onboarding-completed',
    handle: () => {
      // 204, no body. The FIRST completion is the one that sticks; a replay
      // is a success that touches nothing, and the client re-reads the
      // session to learn the instant.
      db.user.onboarding_completed_at ??= new Date().toISOString();
      return undefined;
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
    // A deleted organization answers 404 on every route beneath it, and it is
    // not in the caller's list either — or the switcher would keep offering it.
    handle: ({ query }) =>
      offsetEnvelope<Organization>(
        db.organizations.filter((organization) => organization.status !== 'deleted'),
        query,
      ),
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
      db.organizations.find((org) => org.id === params.orgId && org.status !== 'deleted') ??
      fail(404, 'not_found', `Organization ${params.orgId} was not found`),
  },
  /*
   * `DELETE /v1/organizations/:orgId` — owner ONLY, soft.
   *
   * The route is declared `projects.write`, and `OrganizationsService.remove`
   * then refuses any role but `owner` with a 403. That branch is reachable
   * here without `?as=`: the caller is an ADMIN of `org_01JQKWIK` in the
   * fixtures, so deleting that one is the refusal. Every active project is
   * soft-deleted first, then the organization, in one transaction on the real
   * service — so the ingest path stops accepting every key at once and the
   * ledger and the members are kept. 204.
   */
  {
    method: 'DELETE',
    pattern: '/v1/organizations/:orgId',
    handle: ({ params }) => {
      const organization = db.organizations.find(
        (org) => org.id === params.orgId && org.status !== 'deleted',
      );
      if (!organization) fail(404, 'not_found', `Organization ${params.orgId} was not found`);
      if (organization.role !== 'owner') {
        fail(403, 'forbidden', 'Only an owner can delete an organization. Ask an owner to do it.');
      }
      const now = new Date().toISOString();
      for (const project of db.projects) {
        if (project.organization_id !== organization.id || project.status === 'deleted') continue;
        project.status = 'deleted';
        project.updated_at = now;
      }
      organization.status = 'deleted';
      organization.updated_at = now;
      return undefined;
    },
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
   * Role change and removal — `MembersService.changeRole` / `remove`.
   *
   * The actor is the demo user's OWN membership in `:orgId` (owner in ShaQ
   * Express, admin in Kwik Logistics), so every rung of the lattice is
   * reachable: your own row, a role above your rank, a member who outranks
   * you. The rules and their sentences are in `writes.ts`; the owner count is
   * taken from the same rows the write lands on, as the real transaction does.
   */
  {
    method: 'PATCH',
    pattern: '/v1/organizations/:orgId/members/:memberId',
    handle: ({ params, body }) => {
      const { actor, target, rows } = memberChangeOr404(params.orgId, params.memberId);
      const role = (body as { role?: unknown } | null)?.role;
      if (!isMemberRole(role)) {
        fail(400, 'invalid_request', [
          'role: role must be one of the following values: owner, admin, developer, viewer, billing',
        ]);
      }
      const refusal = rejectMemberChange({
        actorRole: actor.role,
        actorMembershipId: actor.id,
        targetMembershipId: target.id,
        currentRole: target.role,
        nextRole: role,
        ownerCount: rows.filter((row) => row.role === 'owner').length,
      });
      if (refusal) fail(refusal.status, refusal.code, refusal.message);
      // A no-op is allowed and not audited.
      target.role = role;
      return target;
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/organizations/:orgId/members/:memberId',
    handle: ({ params }) => {
      const { actor, target, rows } = memberChangeOr404(params.orgId, params.memberId);
      const refusal = rejectMemberChange({
        actorRole: actor.role,
        actorMembershipId: actor.id,
        targetMembershipId: target.id,
        currentRole: target.role,
        nextRole: null,
        ownerCount: rows.filter((row) => row.role === 'owner').length,
      });
      if (refusal) fail(refusal.status, refusal.code, refusal.message);
      // A HARD delete: nothing in the ledger hangs off a membership row.
      rows.splice(rows.indexOf(target), 1);
      return undefined;
    },
  },
  /*
   * Redemption lives at `/v1/invitations`, not under `:orgId` — the invitee is
   * not a member yet, so a tenant-scoped route would 404. Mirrors
   * `MembersService.accept` step for step: the token is CONSUMED first, then
   * the address on it is checked against the session, then the inviter. So an
   * expired, used, unknown or wrong-address token is ONE 400 with ONE sentence
   * (the real service refuses to say which), and every refusal burns the token
   * — a second POST of the same token is that same 400.
   */
  {
    method: 'POST',
    pattern: '/v1/invitations/accept',
    handle: ({ body }) => {
      charge('invitations.accept');
      const input = requireBody<{ token: unknown }>(body, ['token']);
      if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) {
        fail(400, 'invalid_request', [
          'token: token must be longer than or equal to 20 and shorter than or equal to 200 characters',
        ]);
      }
      const refuse: () => never = () => fail(400, 'invalid_request', INVALID_INVITATION);

      const invitation = db.invitations.find((row) => row.token === input.token);
      if (!invitation || invitation.consumed_at !== null) refuse();
      if (invitation.expires_at < new Date().toISOString()) refuse();
      invitation.consumed_at = new Date().toISOString();

      if (invitation.email.toLowerCase() !== db.user.email.toLowerCase()) refuse();

      // Already a member: the membership as it stands, role untouched.
      const existing = db.organizations.find((row) => row.id === invitation.organization_id);
      if (existing) return { organization: existing };

      if (invitation.inviter_gone) {
        fail(
          409,
          'conflict',
          'The member who invited you is no longer part of that organization. Ask for a new invitation.',
        );
      }
      const joined: Organization = {
        ...db.invitableOrganization,
        role: invitation.role,
        updated_at: new Date().toISOString(),
      };
      db.organizations.push(joined);
      return { organization: joined };
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
  /*
   * `POST /v1/organizations/:orgId/projects` — persisted, so the switcher and
   * the landing page can navigate to what was just made.
   *
   * The order of checks is the service's: DTO validation, then the slug is
   * derived from the name when omitted (a SUPPLIED slug is validated, never
   * rewritten), then the ceiling, then the unique index — a taken slug is a
   * plain `conflict` and deleted projects keep theirs, so they still collide.
   */
  {
    method: 'POST',
    pattern: '/v1/organizations/:orgId/projects',
    handle: ({ params, body }) => {
      charge('projects.create');
      const organization = db.organizations.find(
        (org) => org.id === params.orgId && org.status !== 'deleted',
      );
      if (!organization) fail(404, 'not_found', `Organization ${params.orgId} was not found`);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectProjectCreate(input));

      const name = (input.name as string).trim();
      const slug = typeof input.slug === 'string' ? input.slug : slugFromName(name);
      if (!slug) {
        fail(
          400,
          'invalid_request',
          'Could not derive a slug from that name. Supply "slug" explicitly (lowercase letters, digits and hyphens).',
        );
      }
      const environment = (input.environment as Project['environment'] | undefined) ?? 'test';

      const existing = db.projects.filter(
        (project) => project.organization_id === params.orgId && project.status !== 'deleted',
      ).length;
      assertBelowCeiling(
        existing,
        100,
        `This organization already has ${existing} projects, which is its limit of 100. Delete a project you no longer need, or ask an operator to raise MAX_PROJECTS_PER_ORGANIZATION.`,
        'projects',
      );

      const taken = db.projects.some(
        (project) => project.organization_id === params.orgId && project.slug === slug,
      );
      if (taken) {
        fail(
          409,
          'conflict',
          `A project with the slug "${slug}" already exists in this organization. Deleted projects keep their slug; list with ?status=deleted to check.`,
        );
      }

      const now = new Date().toISOString();
      const project: Project = {
        id: `proj_01JQNEW${(db.projects.length + 1).toString().padStart(3, '0')}`,
        organization_id: params.orgId,
        name,
        slug,
        environment,
        status: 'active',
        // A new project permits every address, which is the default and what
        // the settings panel calls out as fine until a key leaks.
        allowed_ips: [],
        created_at: now,
        updated_at: now,
      };
      db.projects.push(project);

      /*
       * The copy, mirrored to the extent the fixture can: endpoints arrive
       * PAUSED and with no live secret, which is the rule the dialog is built
       * around. Secrets are not copied — and the response says `signing_secrets:
       * 0` out loud, because that zero is the reason nothing delivers yet.
       */
      const copyFrom =
        typeof input.copy_from_project_id === 'string' ? input.copy_from_project_id : null;
      if (!copyFrom) return { ...project, copied: null, copy_error: null };

      const source = db.projects.find(
        (candidate) => candidate.id === copyFrom && candidate.organization_id === params.orgId,
      );
      if (!source) {
        return {
          ...project,
          copied: null,
          copy_error:
            'The project to copy from does not exist, or belongs to another organization.',
        };
      }

      const sourceEndpoints = db.endpoints.filter(
        (row) => row.project_id === source.id && row.status !== 'deleted',
      );
      const endpointMap = new Map<string, string>();
      for (const row of sourceEndpoints) {
        const id = `ep_01JQCOPY${endpointMap.size + 1}`;
        endpointMap.set(row.id, id);
        db.endpoints.push({
          ...row,
          id,
          project_id: project.id,
          status: 'paused',
          enabled: false,
          disabled_reason:
            'Copied from another project. Check the URL, issue a signing secret, then resume it.',
          has_live_secret: false,
          health: null,
          created_at: now,
          updated_at: now,
        });
      }

      let copiedSubscriptions = 0;
      for (const row of db.subscriptions.filter((s2) => s2.project_id === source.id)) {
        const endpointId = endpointMap.get(row.endpoint_id);
        // A subscription whose endpoint was not copied has nowhere to point.
        // Pointing it at the SOURCE project's endpoint would deliver this
        // project's events into another project's consumer.
        if (!endpointId) continue;
        db.subscriptions.push({
          ...row,
          id: `sub_01JQCOPY${copiedSubscriptions + 1}`,
          project_id: project.id,
          endpoint_id: endpointId,
          created_at: now,
          updated_at: now,
        });
        copiedSubscriptions += 1;
      }

      const copiedPolicies = db.retryPolicies.filter((row) => row.project_id === source.id).length;

      return {
        ...project,
        copied: {
          endpoints: endpointMap.size,
          subscriptions: copiedSubscriptions,
          retry_policies: copiedPolicies,
          signing_secrets: 0,
        },
        copy_error: null,
      };
    },
  },
  /*
   * `DELETE …/projects/:projectId` — SOFT. `status = deleted`, and the row
   * comes back in that state (200, not 204). Endpoints, keys and the ledger
   * are untouched; keys are deliberately not revoked because the ingest path
   * already refuses every key whose project is not active. Idempotent on an
   * already-deleted project on the real service (the update is a no-op).
   */
  {
    method: 'DELETE',
    pattern: '/v1/organizations/:orgId/projects/:projectId',
    handle: ({ params }) => {
      const project = db.projects.find(
        (candidate) =>
          candidate.id === params.projectId && candidate.organization_id === params.orgId,
      );
      if (!project) fail(404, 'not_found', `Project ${params.projectId} was not found`);
      if (project.status !== 'deleted') {
        project.status = 'deleted';
        project.updated_at = new Date().toISOString();
      }
      return project;
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

      if (Array.isArray(input.allowed_ips)) {
        // REPLACES the list, and a malformed entry is refused rather than
        // dropped — mirroring `normaliseAllowedIps`. Silently discarding one
        // would lock out the service it was for at the moment the operator
        // believed they had just permitted it.
        const entries: string[] = [];
        for (const raw of input.allowed_ips) {
          const entry = String(raw).trim();
          if (entry === '') continue;
          if (!looksLikeAddressOrBlock(entry)) {
            fail(
              400,
              'invalid_request',
              `'${entry}' is not an IP address or CIDR block. Entries look like '203.0.113.4', '203.0.113.0/24' or '2001:db8::/32'.`,
            );
          }
          if (!entries.includes(entry)) entries.push(entry);
        }
        if (entries.length > 50) {
          fail(
            400,
            'invalid_request',
            `'allowed_ips' may hold at most 50 entries; ${entries.length} were given. Use a CIDR block rather than listing addresses individually.`,
          );
        }
        project.allowed_ips = entries;
      }

      if (typeof input.name === 'string') project.name = input.name;
      if (typeof input.slug === 'string') project.slug = input.slug;
      project.updated_at = new Date().toISOString();
      return project;
    },
  },

  /*
   * Billing. `billable: false` and `plan: null` travel on the wire, because
   * they are the two facts the page is built to state: there is no payment
   * provider and no plan is defined. A mock that invented either would let the
   * dashboard ship an invoice table nobody could honour.
   */
  {
    method: 'GET',
    pattern: '/v1/organizations/:orgId/billing',
    handle: () => {
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

      const inPeriod = (iso: string) => {
        const at = new Date(iso);
        return at >= periodStart && at < periodEnd;
      };

      return {
        plan: null,
        status: null,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
        usage: [
          {
            metric: 'events_ingested',
            used: String(db.events.filter((row) => inPeriod(row.created_at)).length),
            included: null,
          },
          {
            metric: 'deliveries',
            used: String(db.deliveries.filter((row) => inPeriod(row.created_at)).length),
            included: null,
          },
          {
            metric: 'replays',
            used: String(
              db.deliveries.filter(
                (row) => inPeriod(row.created_at) && row.replay_of_delivery_id !== null,
              ).length,
            ),
            included: null,
          },
        ],
        billable: false,
      };
    },
  },

  /*
   * Notification destinations. The confirmation half is modelled properly
   * because `pending` is the state the UI is built around: a destination
   * receives nothing until somebody who can read the address says yes.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/notification-destinations',
    handle: ({ params, query }) =>
      offsetEnvelope<NotificationDestination>(
        db.notificationDestinations.filter((row) => row.project_id === params.projectId),
        query,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notification-destinations',
    handle: ({ params, body }) => {
      charge('notifications.create');
      const input = requireBody<{ kind: string; target: string; label?: string }>(body, [
        'kind',
        'target',
      ]);
      if (input.kind !== 'email') {
        fail(
          400,
          'invalid_request',
          "Only 'email' destinations can be created today. A Slack destination needs an app installed in your workspace, which is not built yet.",
        );
      }
      const target = String(input.target).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
        fail(400, 'invalid_request', `'${input.target}' is not a valid email address.`);
      }
      const taken = db.notificationDestinations.some(
        (row) => row.project_id === params.projectId && row.target === target,
      );
      if (taken) {
        fail(
          409,
          'conflict',
          `${target} is already a destination for this project. One address cannot be added twice — it would receive everything twice.`,
        );
      }

      const created: NotificationDestination = {
        id: `ntd_01JQNEW${db.notificationDestinations.length + 1}`,
        project_id: params.projectId,
        kind: 'email',
        target,
        label: input.label?.trim() || target,
        // Created PENDING. The row exists before the message is sent and a send
        // failure does not roll it back: a pending destination with a Resend
        // button is a better place to be than a form you fill in again.
        status: 'pending',
        events: ['endpoint.stopped', 'event.stuck', 'secret.retiring', 'delivery.exhausted'],
        confirmed_at: null,
        last_sent_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      };
      db.notificationDestinations.push(created);
      return created;
    },
  },
  {
    method: 'PATCH',
    pattern: '/v1/projects/:projectId/notification-destinations/:destinationId',
    handle: ({ params, body }) => {
      const row = destinationOr404(params.projectId, params.destinationId);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      if (Array.isArray(input.events)) row.events = input.events.map(String);
      if (typeof input.label === 'string') row.label = input.label;
      return row;
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/projects/:projectId/notification-destinations/:destinationId',
    handle: ({ params }) => {
      const row = destinationOr404(params.projectId, params.destinationId);
      db.notificationDestinations.splice(db.notificationDestinations.indexOf(row), 1);
      return undefined;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notification-destinations/:destinationId/resend',
    handle: ({ params }) => {
      const row = destinationOr404(params.projectId, params.destinationId);
      if (row.status === 'confirmed') {
        fail(409, 'conflict', 'This address is already confirmed. Nothing to send.');
      }
      return row;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notification-destinations/:destinationId/test',
    handle: ({ params }) => {
      const row = destinationOr404(params.projectId, params.destinationId);
      if (row.status !== 'confirmed') {
        fail(
          409,
          'conflict',
          'This address has not been confirmed yet, so nothing can be sent to it.',
        );
      }
      row.last_sent_at = new Date().toISOString();
      return undefined;
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
      return offsetEnvelope<Endpoint>(
        rows.map((endpoint) => ({ ...endpoint, health: endpointHealth(endpoint.id) })),
        query,
      );
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
        // A create returns no health: nothing has been delivered to a URL that
        // did not exist a moment ago, and `null` says "not computed" rather
        // than inventing a rate of zero for it.
        health: null,
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
  /*
   * `EndpointSecretsService.rotate`, statement for statement: the new secret
   * is inserted ACTIVE first, then the previously active ones are given an
   * expiry `overlap_seconds` from now — so a failure between the two leaves two
   * live secrets rather than none. `overlap_seconds: 0` retires them on the
   * spot (the leak button). The change is PERSISTED, because the dialog
   * invalidates the list and would otherwise read back the old versions, and
   * `has_live_secret` on the endpoint row follows the rows it is derived from.
   */
  {
    method: 'POST',
    pattern: '/v1/endpoints/:endpointId/secrets/rotate',
    handle: ({ params, body }) => {
      charge('endpoint-secrets.rotate');
      const endpoint = db.endpoints.find((candidate) => candidate.id === params.endpointId);
      if (!endpoint) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      if (endpoint.status === 'deleted') {
        fail(
          409,
          'conflict',
          'This endpoint is deleted. Rotating a secret for it would create a credential nothing can use.',
        );
      }
      const raw = (body as { overlap_seconds?: unknown } | null)?.overlap_seconds;
      let overlapSeconds = 86_400;
      if (raw !== undefined) {
        // `@IsInt() @Min(0) @Max(2592000)` on `RotateSecretDto`, as an ARRAY.
        if (!Number.isInteger(raw)) {
          fail(400, 'invalid_request', ['overlap_seconds: overlap_seconds must be an integer number']);
        }
        if ((raw as number) < 0) {
          fail(400, 'invalid_request', ['overlap_seconds: overlap_seconds must not be less than 0']);
        }
        if ((raw as number) > 2_592_000) {
          fail(400, 'invalid_request', [
            'overlap_seconds: overlap_seconds must not be greater than 2592000',
          ]);
        }
        overlapSeconds = raw as number;
      }

      const existing = (db.endpointSecrets[params.endpointId] ??= []);
      const version = Math.max(0, ...existing.map((secret) => secret.version)) + 1;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + overlapSeconds * 1000).toISOString();

      // 1. The new secret first.
      const minted: EndpointSecret = {
        id: `sec_01JQNEW${version}`,
        endpoint_id: params.endpointId,
        version,
        active: true,
        expires_at: null,
        rotated_at: null,
        created_at: now.toISOString(),
      };
      existing.unshift(minted);

      // 2. Then the clock on the old ones. An existing overlap that ends LATER
      //    than the new deadline is left alone — a rotation never shortens a
      //    window a consumer was promised.
      const overlapping: number[] = [];
      let lastExpiry: string | null = null;
      for (const secret of existing) {
        if (secret === minted || !secret.active) continue;
        if (secret.expires_at === null || secret.expires_at > expiresAt) {
          secret.expires_at = expiresAt;
          secret.rotated_at = now.toISOString();
        }
        if (overlapSeconds === 0) {
          secret.active = false;
          continue;
        }
        overlapping.push(secret.version);
        if (lastExpiry === null || secret.expires_at > lastExpiry) lastExpiry = secret.expires_at;
      }
      endpoint.has_live_secret = true;

      const rotated: RotatedSecret = {
        ...minted,
        secret: `whsec_${'r0t4t3d'.repeat(4)}`,
        previous_secrets_expire_at: lastExpiry,
        overlapping_versions: overlapping.sort((a, b) => b - a),
      };
      return rotated;
    },
  },
  /*
   * `EndpointSecretsService.revoke` — stop ONE secret signing. Refused when it
   * is the last one signing for an endpoint that is not deleted: that state
   * makes every delivery fail closed. The server names the remedy (rotate with
   * an overlap of 0) in the sentence, and the dialog turns it into a button.
   */
  {
    method: 'DELETE',
    pattern: '/v1/endpoints/:endpointId/secrets/:secretId',
    handle: ({ params }) => {
      const endpoint = db.endpoints.find((candidate) => candidate.id === params.endpointId);
      if (!endpoint) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      const secrets = db.endpointSecrets[params.endpointId] ?? [];
      const target = secrets.find((secret) => secret.id === params.secretId);
      if (!target) fail(404, 'not_found', CROSS_TENANT_MESSAGE);

      const survivors = secrets.filter((secret) => secret.id !== target.id && secret.active);
      if (survivors.length === 0 && endpoint.status !== 'deleted') {
        fail(
          409,
          'conflict',
          'This is the only secret currently signing for this endpoint. Removing it would make ' +
            'every delivery fail unsigned. Rotate instead - use an overlap of 0 seconds if this ' +
            'secret has leaked and must stop signing immediately.',
        );
      }
      const now = new Date().toISOString();
      target.active = false;
      target.expires_at = now;
      target.rotated_at = now;
      endpoint.has_live_secret = secrets.some((secret) => secret.active);
      return target;
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
        // WHO MINTED IT, taken from the session rather than the body — as the
        // control API takes it from the resolved session. These three were
        // omitted here until the schema stated their types; the generated type
        // required them the moment it did, which is the whole argument for
        // generating it.
        created_by_user_id: db.user.id,
        created_by_membership_id: 'mem_01',
        created_by_role: 'owner',
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
        created_at: now,
        key: 'wk_live_9f2cM0ckPl4int3xtK3yV4lu3Chars32',
      };
      return created;
    },
  },
  /*
   * `ApiKeysService.revoke`: immediate, irreversible, IDEMPOTENT. A second call
   * returns the already-revoked key with its ORIGINAL `revoked_at` — the
   * forensically interesting one — and the row stays, `status: revoked`, so
   * what the key published remains attributable. Persisted, or the invalidated
   * list would read the key back as active.
   */
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/api-keys/:apiKeyId/revoke',
    handle: ({ params }) => {
      charge('api-keys.revoke');
      const key = db.apiKeys.find(
        (candidate) => candidate.id === params.apiKeyId && candidate.project_id === params.projectId,
      );
      // One answer for "does not exist" and "another project's", as everywhere.
      if (!key) fail(404, 'not_found', `API key ${params.apiKeyId} was not found`);
      if (key.revoked_at !== null) return key;
      key.revoked_at = new Date().toISOString();
      // Revoked outranks expired, exactly as the ingest path derives it.
      key.status = 'revoked';
      return key;
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
   * Subscription writes — `WebhookSubscriptionsController`, all five.
   *
   * The event-type refusals are the server's own sentences, via the mirror in
   * `features/subscriptions/event-types.ts`, and they arrive WITHOUT a
   * `property:` prefix because that is how `EventTypesConstraint` emits them.
   * Two 409s on create, told apart by `error.code`: `limit_exceeded` at the
   * per-project ceiling, `conflict` for a deleted endpoint. The mock ceiling
   * is small on purpose so the branch is reachable — the real default is 500.
   */
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/subscriptions',
    handle: ({ params, body }) => {
      charge('subscriptions.create');
      projectOr404(params.projectId);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectSubscriptionCreate(input));

      const existing = db.subscriptions.filter(
        (subscription) => subscription.project_id === params.projectId,
      ).length;
      assertBelowCeiling(
        existing,
        MOCK_SUBSCRIPTION_CEILING,
        `This project already has ${existing} subscriptions, which is its limit of ${MOCK_SUBSCRIPTION_CEILING}. Every subscription multiplies the deliveries one event produces, so the ceiling is real work rather than a row count. Delete one you no longer need, or ask an operator to raise MAX_SUBSCRIPTIONS_PER_PROJECT.`,
        'subscriptions',
      );

      const endpoint = subscribableEndpoint(params.projectId, input.endpoint_id as string);
      const now = new Date().toISOString();
      const subscription: Subscription = {
        id: `sub_01JQNEW${(subscriptionSeq += 1).toString().padStart(3, '0')}`,
        project_id: params.projectId,
        endpoint_id: endpoint.id,
        name: typeof input.name === 'string' ? input.name : null,
        // Stored EXACTLY as sent. Never trimmed, never de-duplicated, never widened.
        event_types: [...(input.event_types as string[])],
        payload_filter: (input.payload_filter as Record<string, unknown> | undefined) ?? null,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
        created_at: now,
        updated_at: now,
      };
      // Newest first, like the real list.
      db.subscriptions.unshift(subscription);
      return subscription;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/subscriptions/:subscriptionId',
    handle: ({ params }) => subscriptionOr404(params.projectId, params.subscriptionId),
  },
  {
    method: 'PATCH',
    pattern: '/v1/projects/:projectId/subscriptions/:subscriptionId',
    handle: ({ params, body }) => {
      charge('subscriptions.mutate');
      const subscription = subscriptionOr404(params.projectId, params.subscriptionId);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectSubscriptionPatch(input));

      if ('endpoint_id' in input) {
        subscription.endpoint_id = subscribableEndpoint(
          params.projectId,
          input.endpoint_id as string,
        ).id;
      }
      if ('name' in input) subscription.name = input.name as string | null;
      // Replaced wholesale, not merged.
      if ('event_types' in input) subscription.event_types = [...(input.event_types as string[])];
      if ('payload_filter' in input) {
        subscription.payload_filter = input.payload_filter as Record<string, unknown> | null;
      }
      if (Object.keys(input).length > 0) subscription.updated_at = new Date().toISOString();
      return subscription;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/subscriptions/:subscriptionId/enable',
    handle: ({ params }) => {
      charge('subscriptions.mutate');
      const subscription = subscriptionOr404(params.projectId, params.subscriptionId);
      // Idempotent: already enabled is a 200 with the row unchanged.
      if (!subscription.enabled) {
        subscription.enabled = true;
        subscription.updated_at = new Date().toISOString();
      }
      return subscription;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/subscriptions/:subscriptionId/disable',
    handle: ({ params, body }) => {
      charge('subscriptions.mutate');
      const subscription = subscriptionOr404(params.projectId, params.subscriptionId);
      assertRejections(rejectDisableReason(body));
      if (subscription.enabled) {
        subscription.enabled = false;
        subscription.updated_at = new Date().toISOString();
      }
      return subscription;
    },
  },
  /*
   * HARD delete, and idempotent: a subscription that is already gone answers
   * 204 rather than 404, so a retrying script is not punished for having
   * worked the first time. A subscription in ANOTHER project is, through the
   * tenant scope, simply not found — which here is also "already gone".
   */
  {
    method: 'DELETE',
    pattern: '/v1/projects/:projectId/subscriptions/:subscriptionId',
    handle: ({ params }) => {
      charge('subscriptions.mutate');
      projectOr404(params.projectId);
      const index = db.subscriptions.findIndex(
        (subscription) =>
          subscription.id === params.subscriptionId &&
          subscription.project_id === params.projectId,
      );
      if (index >= 0) db.subscriptions.splice(index, 1);
      return undefined;
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
  /*
   * The retry-policy writes, mirroring `RetryPoliciesService` refusal for
   * refusal. Two invariants it holds and this has to as well: every stored
   * policy is one the data plane can consume (bounds per field via
   * `rejectRetryPolicyBody`, cross-field rules on the MERGED settings via the
   * dashboard's own mirror), and a project with policies has exactly one
   * default (the first created is promoted whether or not it asked).
   */
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/retry-policies',
    handle: ({ params, body }) => {
      charge('retry-policies.write');
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectRetryPolicyBody(input, 'create'));
      const settings = assertRetryCoherent({
        ...DEFAULT_RETRY_SETTINGS,
        ...retrySettingsPatch(input),
      });

      const owned = db.retryPolicies.filter((policy) => policy.project_id === params.projectId);
      assertBelowCeiling(
        owned.length,
        MAX_RETRY_POLICIES_PER_PROJECT,
        `This project already has ${MAX_RETRY_POLICIES_PER_PROJECT} retry policies, which is the maximum. Delete one you no longer point endpoints at.`,
        'retry_policies',
      );

      // A project with policies and no default is a state nothing downstream
      // can resolve, so the first policy is promoted whether or not it asked.
      const currentDefault = owned.find((policy) => policy.is_default);
      const promote = input.is_default === true || currentDefault === undefined;
      if (promote && currentDefault) currentDefault.is_default = false;

      const now = new Date().toISOString();
      const created: RetryPolicy = {
        id: `rp_01JQNEW${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`,
        project_id: params.projectId,
        name: input.name as string,
        is_default: promote,
        ...settings,
        created_at: now,
        updated_at: now,
      };
      db.retryPolicies.push(created);
      return created;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/retry-policies/:policyId',
    handle: ({ params }) => retryPolicyOr404(params.projectId, params.policyId),
  },
  {
    method: 'PATCH',
    pattern: '/v1/projects/:projectId/retry-policies/:policyId',
    handle: ({ params, body }) => {
      charge('retry-policies.write');
      const policy = retryPolicyOr404(params.projectId, params.policyId);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectRetryPolicyBody(input, 'update'));
      // The MERGED settings are validated, not the body: lowering max_delay_ms
      // under a stored initial_delay_ms is one PATCH away.
      const settings = assertRetryCoherent({
        ...retrySettingsOf(policy),
        ...retrySettingsPatch(input),
      });
      Object.assign(policy, settings);
      if (typeof input.name === 'string') policy.name = input.name;
      policy.updated_at = new Date().toISOString();
      return policy;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/retry-policies/:policyId/default',
    handle: ({ params }) => {
      charge('retry-policies.write');
      const target = retryPolicyOr404(params.projectId, params.policyId);
      // Every OTHER default, not just the one that was read — the clear is the
      // statement that has to be true. Idempotent on the current default.
      for (const policy of db.retryPolicies) {
        if (policy.project_id === params.projectId && policy.id !== target.id) {
          policy.is_default = false;
        }
      }
      if (!target.is_default) {
        target.is_default = true;
        target.updated_at = new Date().toISOString();
      }
      return target;
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/projects/:projectId/retry-policies/:policyId',
    handle: ({ params, query }) => {
      charge('retry-policies.write');
      rejectUnknownQuery(query, ['replacement_id']);
      const policy = retryPolicyOr404(params.projectId, params.policyId);
      const replacementId = query.get('replacement_id') ?? undefined;
      if (replacementId !== undefined && replacementId.length > 64) {
        fail(400, 'invalid_request', [
          'replacement_id: must be shorter than or equal to 64 characters',
        ]);
      }

      // A LIVE endpoint still on it blocks the delete: the FK is ON DELETE SET
      // NULL, so deleting would silently repoint those endpoints at the
      // built-in default with nothing in the record to say so.
      const live = db.endpoints.filter(
        (endpoint) =>
          endpoint.project_id === params.projectId &&
          endpoint.retry_policy_id === policy.id &&
          endpoint.status !== 'deleted',
      ).length;
      if (live > 0) {
        fail(
          409,
          'conflict',
          `${live} endpoint${live === 1 ? '' : 's'} in this project still use this retry ` +
            'policy. Deleting it would silently move them onto the platform default backoff ' +
            'with nothing in the record to say so. Point them at another policy first.',
          { endpoints: live },
        );
      }

      const others = db.retryPolicies.filter(
        (candidate) => candidate.project_id === params.projectId && candidate.id !== policy.id,
      );
      if (policy.is_default && others.length > 0) {
        if (!replacementId) {
          fail(
            409,
            'conflict',
            'This is the project default retry policy and other policies exist. Name its ' +
              'successor with ?replacement_id= so the project is never left with policies and ' +
              'no default.',
          );
        }
        if (replacementId === policy.id) {
          fail(400, 'invalid_request', 'replacement_id cannot be the policy being deleted.', {
            field: 'replacement_id',
          });
        }
        const replacement = retryPolicyOr404(params.projectId, replacementId);
        replacement.is_default = true;
        replacement.updated_at = new Date().toISOString();
      } else if (replacementId) {
        fail(
          400,
          'invalid_request',
          policy.is_default
            ? 'replacement_id is not accepted when deleting the only policy in the project: ' +
                'there is nothing to promote, and the project falls back to the platform default.'
            : 'replacement_id is only accepted when deleting the project default policy; this ' +
                'policy is not the default, so nothing would be promoted.',
          { field: 'replacement_id' },
        );
      }

      // Soft-deleted endpoints are unlinked explicitly rather than by the FK.
      for (const endpoint of db.endpoints) {
        if (endpoint.retry_policy_id === policy.id && endpoint.status === 'deleted') {
          endpoint.retry_policy_id = null;
        }
      }
      db.retryPolicies.splice(db.retryPolicies.indexOf(policy), 1);
      return undefined;
    },
  },

  /*
   * Rate-limit policies, mirroring `RateLimitsService`. The row's IDENTITY is
   * `(scope, resource_id)` and the null-resource row counts, so a duplicate is
   * a 409 `conflict` naming the existing row; `resource_id` is resolved
   * through the table its scope names, so another tenant's endpoint is the
   * shared 404 and a sibling project is a 400 that says why.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/rate-limits',
    handle: ({ params, query }) => {
      rejectUnknownQuery(query, ['scope', 'resource_id', 'limit', 'offset']);
      const scope = query.get('scope');
      if (scope !== null && !(RATE_LIMIT_SCOPE_VALUES as readonly string[]).includes(scope)) {
        fail(400, 'invalid_request', [
          `scope: must be one of the following values: ${RATE_LIMIT_SCOPE_VALUES.join(', ')}`,
        ]);
      }
      const resourceId = query.get('resource_id');
      const rows = db.rateLimitPolicies.filter((policy) => {
        if (policy.project_id !== params.projectId) return false;
        if (scope && policy.scope !== scope) return false;
        if (resourceId && policy.resource_id !== resourceId) return false;
        return true;
      });
      return offsetEnvelope<RateLimit>(rows, query);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/rate-limits',
    handle: ({ params, body }) => {
      charge('rate-limits.write');
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectRateLimitBody(input, 'create'));
      const settings = assertRateLimitCoherent({
        limit: input.limit as number,
        window_seconds: typeof input.window_seconds === 'number' ? input.window_seconds : 1,
        burst: typeof input.burst === 'number' ? input.burst : null,
      });

      const owned = db.rateLimitPolicies.filter((policy) => policy.project_id === params.projectId);
      assertBelowCeiling(
        owned.length,
        MAX_RATE_LIMIT_POLICIES_PER_PROJECT,
        `This project already has ${MAX_RATE_LIMIT_POLICIES_PER_PROJECT} rate-limit policies, which is the maximum. Delete one you no longer enforce.`,
        'rate_limit_policies',
      );

      const scope = input.scope as RateLimitScope;
      const resourceId = resolveRateLimitResource(
        params.projectId,
        scope,
        typeof input.resource_id === 'string' ? input.resource_id : null,
      );
      requireUniqueRateLimit(params.projectId, scope, resourceId, null);

      const now = new Date().toISOString();
      const created: RateLimit = {
        id: `rl_01JQNEW${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`,
        project_id: params.projectId,
        scope,
        resource_id: resourceId,
        limit: settings.limit,
        window_seconds: settings.window_seconds,
        burst: settings.burst,
        created_at: now,
        updated_at: now,
      };
      db.rateLimitPolicies.push(created);
      return created;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/rate-limits/:policyId',
    handle: ({ params }) => rateLimitOr404(params.projectId, params.policyId),
  },
  {
    method: 'PATCH',
    pattern: '/v1/projects/:projectId/rate-limits/:policyId',
    handle: ({ params, body }) => {
      charge('rate-limits.write');
      const policy = rateLimitOr404(params.projectId, params.policyId);
      const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      assertRejections(rejectRateLimitBody(input, 'update'));
      const settings = assertRateLimitCoherent({
        limit: typeof input.limit === 'number' ? input.limit : policy.limit,
        window_seconds:
          typeof input.window_seconds === 'number' ? input.window_seconds : policy.window_seconds,
        burst: 'burst' in input ? (typeof input.burst === 'number' ? input.burst : null) : policy.burst,
      });

      // Identity. A scope change that leaves a stale non-null resource_id
      // unstated is refused rather than carried over: an endpoint id under
      // organization scope would resolve against the wrong table.
      const nextScope = (typeof input.scope === 'string' ? input.scope : policy.scope) as RateLimitScope;
      const scopeChanged = nextScope !== policy.scope;
      if (scopeChanged && !('resource_id' in input) && policy.resource_id !== null) {
        fail(
          400,
          'invalid_request',
          'Changing `scope` while this policy has a `resource_id` requires stating the new ' +
            'resource_id too (or null): the existing one names a ' +
            `${rateLimitResourceKind(policy.scope)}, which is not what ${nextScope} scope refers to.`,
          { field: 'resource_id' },
        );
      }
      const requested =
        'resource_id' in input
          ? typeof input.resource_id === 'string'
            ? input.resource_id
            : null
          : policy.resource_id;
      const resourceId = resolveRateLimitResource(params.projectId, nextScope, requested);
      if (scopeChanged || resourceId !== policy.resource_id) {
        requireUniqueRateLimit(params.projectId, nextScope, resourceId, policy.id);
      }

      policy.scope = nextScope;
      policy.resource_id = resourceId;
      policy.limit = settings.limit;
      policy.window_seconds = settings.window_seconds;
      policy.burst = settings.burst;
      policy.updated_at = new Date().toISOString();
      return policy;
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/projects/:projectId/rate-limits/:policyId',
    handle: ({ params }) => {
      charge('rate-limits.write');
      const policy = rateLimitOr404(params.projectId, params.policyId);
      // Hard, with no preconditions: nothing in the ledger references it.
      db.rateLimitPolicies.splice(db.rateLimitPolicies.indexOf(policy), 1);
      return undefined;
    },
  },

  /*
   * Analytics: FOUR routes, computed from the ledger above. The shapes are the
   * DTOs in apps/control-api/src/analytics/dto/ and the arithmetic mirrors
   * `AnalyticsService` — see `./analytics.ts`. `window_hours` above 720 is a
   * 400 with a per-property message, as the global ValidationPipe answers.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics/deliveries',
    handle: ({ params, query }) => {
      const parsed = parseAnalyticsQuery(query, false);
      if (!parsed.ok) fail(400, 'invalid_request', parsed.messages);
      return analytics.deliveryOutcomes(params.projectId, parsed.windowHours);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics/deliveries/series',
    handle: ({ params, query }) => {
      const parsed = parseSeriesQuery(query);
      if (!parsed.ok) fail(400, 'invalid_request', parsed.messages);
      return analytics.deliverySeries(params.projectId, parsed.windowHours, parsed.bucket);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics/endpoints',
    handle: ({ params, query }) => {
      const parsed = parseAnalyticsQuery(query, true);
      if (!parsed.ok) fail(400, 'invalid_request', parsed.messages);
      return analytics.failingEndpoints(params.projectId, parsed.windowHours, parsed.limit);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics/latency',
    handle: ({ params, query }) => {
      const parsed = parseAnalyticsQuery(query, false);
      if (!parsed.ok) fail(400, 'invalid_request', parsed.messages);
      return analytics.attemptLatency(params.projectId, parsed.windowHours);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/analytics/events',
    handle: ({ params, query }) => {
      const parsed = parseAnalyticsQuery(query, true);
      if (!parsed.ok) fail(400, 'invalid_request', parsed.messages);
      return analytics.eventVolume(params.projectId, parsed.windowHours, parsed.limit);
    },
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
      offsetEnvelope<DeliveryListItem>(
        filterDeliveries(params.projectId, query).map(toListItem),
        query,
      ),
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
      // Operator intent, recorded and attributed. What the data plane does
      // next: a delivery already queued for this endpoint is finished
      // `cancelled` when a worker claims it (`worker/deliver.go`), and the
      // router skips the endpoint at routing (`router/plan.go` `gate()`), so
      // new events produce no rows for it. Nothing waits.
      endpoint.disabled_reason = reason
        ? `Paused by ${db.user.email}: ${reason}`
        : `Paused by ${db.user.email}.`;
      endpoint.disabled_at = new Date().toISOString();
      endpoint.updated_at = endpoint.disabled_at;
      return endpoint;
    },
  },
  /*
   * `EndpointsService.remove` — a SOFT delete, and idempotent. The row is kept
   * forever (`deliveries.endpoint_id` is ON DELETE RESTRICT), disappears from
   * the default listing, and every later write against it answers 409 through
   * `assertNotDeleted`. Its secrets stop signing with it, which is what
   * `has_live_secret: false` on the deleted fixture already states.
   */
  {
    method: 'DELETE',
    pattern: '/v1/projects/:projectId/endpoints/:endpointId',
    handle: ({ params }) => {
      const endpoint = endpointOr404(params.projectId, params.endpointId);
      if (endpoint.status === 'deleted') return undefined;
      endpoint.status = 'deleted';
      endpoint.enabled = false;
      endpoint.has_live_secret = false;
      endpoint.updated_at = new Date().toISOString();
      for (const secret of db.endpointSecrets[endpoint.id] ?? []) secret.active = false;
      return undefined;
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
      offsetEnvelope<DeliveryListItem>(deliveriesForEvent(params.eventId).map(toListItem), query),
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

  /*
   * The outbox — the router's record of what it still owes an accepted event,
   * and the way back when it parks one. Nested under the project like events
   * and deliveries. Bulk requeue is declared BEFORE `:outboxId/requeue`; the
   * paths are different depths so the matcher cannot confuse them, but the
   * order documents the intent.
   */
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/outbox',
    handle: ({ params, query }) => {
      rejectUnknownQuery(query, ['status', 'event_id', 'limit', 'offset']);
      const status = query.get('status');
      if (status !== null && !(OUTBOX_STATUSES as readonly string[]).includes(status)) {
        fail(400, 'invalid_request', [
          `status: must be one of the following values: ${OUTBOX_STATUSES.join(', ')}`,
        ]);
      }
      const eventId = query.get('event_id');
      const rows = outboxInProject(params.projectId)
        .filter((entry) => (status ? entry.status === status : true))
        .filter((entry) => (eventId ? entry.event_id === eventId : true))
        // Newest first, as the controller orders it.
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return offsetEnvelope<OutboxEntry>(rows, query);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/outbox/requeue',
    handle: ({ params, body }): RequeueResult => {
      // The guard runs before the pipe, so the throttle is charged first.
      charge('outbox.requeue');
      const dto = readRequeueBody(body, true);
      const owned = outboxInProject(params.projectId);

      // The event is resolved FIRST, so an id from another tenant is the
      // shared 404 rather than an empty result that reads as "nothing parked".
      if (
        dto.event_id !== undefined &&
        !owned.some((entry) => entry.event_id === dto.event_id)
      ) {
        fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      }

      const parked = owned
        .filter((entry) => entry.status === 'failed')
        .filter((entry) => (dto.event_id ? entry.event_id === dto.event_id : true))
        // OLDEST first: those consumers have been waiting longest.
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      const page = parked.slice(0, MAX_REQUEUE_BATCH);
      const requeued = returnToQueue(page);
      return {
        requeued: requeued.length,
        has_more: parked.length > page.length,
        data: requeued.map((row) => ({ ...row })),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/outbox/:outboxId',
    handle: ({ params }) =>
      outboxInProject(params.projectId).find((entry) => entry.id === params.outboxId) ??
      fail(404, 'not_found', CROSS_TENANT_MESSAGE),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/outbox/:outboxId/requeue',
    handle: ({ params, body }): OutboxEntry => {
      charge('outbox.requeue');
      readRequeueBody(body, false);
      const entry = outboxInProject(params.projectId).find(
        (candidate) => candidate.id === params.outboxId,
      );
      if (!entry) fail(404, 'not_found', CROSS_TENANT_MESSAGE);
      if (entry.status !== 'failed') {
        // The CURRENT status in `details`, so the caller can tell "a router
        // already has it" from "the routing already completed" without a
        // second request.
        fail(
          409,
          'conflict',
          entry.status === 'processed'
            ? 'This entry already routed. To send the event again, replay it.'
            : 'This entry is not parked: a router is already working on it.',
          { outbox_id: entry.id, outbox_status: entry.status },
        );
      }
      const [requeued] = returnToQueue([entry]);
      return { ...requeued };
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
