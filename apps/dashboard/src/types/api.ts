/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DOMAIN TYPES, DERIVED FROM THE GENERATED OPENAPI DOCUMENT.
 *
 * `src/types/api.d.ts` is written by `pnpm --filter @webhook/dashboard
 * generate:api` from the control API's live `/docs-json`. It is the contract.
 * NOTHING in this file re-states a field name or a field type by hand — every
 * alias below is `components['schemas'][…]`, so a rename on the wire is a
 * compile error here rather than an `undefined` on a page.
 *
 * That is the whole point. Three rounds of drift were found in the previous
 * hand-written version of this file, every one of them only by calling the real
 * API, because TypeScript believes whatever a hand-written type asserts.
 *
 * WHAT SURVIVES BY HAND, AND WHY. Each of the three groups below is something
 * the OpenAPI document does not carry, not something that was too tedious to
 * migrate:
 *
 *   1. THE ERROR ENVELOPE. Nest's Swagger module documents 2xx bodies only —
 *      there is no error schema in the document at all. `ApiErrorBody` and
 *      `ApiErrorCode` are therefore still mirrored from control-api
 *      `src/common/errors.ts`. See HANDOFF.md: publishing the envelope is a
 *      real backend ask, and until it lands this is the one type that can
 *      silently drift again.
 *   2. NULLABILITY REPAIRS (`Patch<>` below).
 *   3. CLIENT-SIDE MIRRORS OF SERVER LIMITS — numbers a form uses to refuse a
 *      value before spending a round trip. They are conveniences; the server
 *      stays the authority, and a stale one costs a 400 rather than corruption.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { components } from './api.d';

type S = components['schemas'];

/**
 * Repairs one specific defect in the generated output.
 *
 * The control API decorates nullable properties with `@ApiProperty({ nullable:
 * true })` and no `type`, so the emitted schema is `{ nullable: true }` with no
 * type at all — and openapi-typescript renders that, correctly, as
 * `Record<string, never> | null`. A field like `rate_limit`, which is a
 * `number | null`, therefore arrives as a type no number can be assigned to,
 * and `expires_at` as one no string can.
 *
 * The repair is deliberately EXPLICIT and per-field rather than a blanket
 * `Record<string, never> → unknown` sweep, because the key names are still
 * being taken from the generated type: `Patch` constrains every key it is given
 * to a key that exists on the source schema, so if `rate_limit` is renamed or
 * dropped upstream, this file stops compiling. The types are hand-supplied; the
 * FIELD SET is not.
 *
 * These properties are also emitted OPTIONAL (`?`) rather than required, for
 * the same reason — `nullable` without `type` loses `required` in the Nest
 * emitter. They are always present on the wire (a DTO class assigns every
 * property), so the repair makes them required-and-nullable, which is what the
 * reading code already assumes.
 *
 * HANDOFF.md carries the backend ask: `@ApiProperty({ type: String, nullable:
 * true })` on every nullable property deletes this helper entirely.
 */
type Patch<T, O extends { [K in keyof O]: K extends keyof T ? O[K] : never }> = Omit<T, keyof O> & O;

/* ── Errors ────────────────────────────── NOT IN THE OPENAPI DOCUMENT ────── */

/**
 * Error envelope, identical on every non-2xx response.
 *
 * `details` is load-bearing: it is where the throttle guard puts
 * `retry_after_seconds` and where a resource ceiling puts `limit`/`current`.
 * Without it the UI cannot tell "slow down" from "you have hit a limit" — see
 * `src/lib/api-errors.ts`.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /**
     * A STRING, except on a 400 raised by the global `ValidationPipe`, where
     * Nest puts the array of per-field messages here and `AppExceptionFilter`
     * passes it through untouched. Each entry reads `"<property>: <reason>"`,
     * which is the only place the server says WHICH field it refused.
     */
    message: string | string[];
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

/**
 * The key set of `ERROR_CODES` in control-api `src/common/errors.ts`.
 * Codes are additive; treat an unknown string as `internal_error`.
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  /** 403 on login when the address has not been confirmed yet. */
  | 'email_not_verified'
  | 'not_found'
  | 'conflict'
  /** 409. A per-tenant resource ceiling, with `{ limit, current, resource }`. */
  | 'limit_exceeded'
  | 'idempotency_key_reused'
  | 'payload_too_large'
  /** 429. Every write route carries a `@Throttle`. */
  | 'rate_limited'
  | 'internal_error';

/* ── Pagination ───────────────────────────────────────────────────────────── */

/**
 * ONE list envelope, not three.
 *
 * Every `*ListDto` in the document is now `{ data, has_more, next_offset }` —
 * including organizations and members, which used to be
 * `{ data, total, limit, offset }`, and projects and API keys, which used to
 * carry a `count`. Both of those older shapes were still modelled here and
 * still being read. See HANDOFF.md.
 *
 * `next_offset` is `number | null` on organizations, members, projects, API
 * keys, endpoints, endpoint secrets and audit logs, and the untyped-nullable
 * `Record<string, never> | null` on the newer modules (subscriptions, retry
 * policies, rate limits, events, deliveries, attempts). The generic below is
 * what every caller reads, and `offsetPage()` in `src/lib/pagination.ts` is the
 * only thing that touches the raw envelope.
 */
export interface OffsetPage<T> {
  data: T[];
  has_more: boolean;
  next_offset?: number | Record<string, never> | null;
}

/** Page size bounds from control-api `src/authz/tenant-scope.ts`. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/* ── Identity ─────────────────────────────────────────────────────────────── */

export type Role = S['OrganizationDto']['role'];

/**
 * `AuthUserDto`.
 *
 * `email_verified` is a BOOLEAN. The hand-written type had
 * `email_verified_at: string | null`, and there is no `created_at` here at all.
 */
export type User = Patch<S['AuthUserDto'], { name: string | null }>;

/**
 * `SessionResponseDto` — `{ user }` and NOTHING ELSE.
 *
 * The hand-written type also carried `organizations: Organization[]`, and the
 * login redirect and the landing route both read `session.organizations[0]`.
 * That property does not exist. Callers now read `GET /v1/organizations`.
 */
export type Session = Patch<S['SessionResponseDto'], { user: User }>;

/** `OrganizationDto`. `role` is the CALLER's role, not a property of the org. */
export type Organization = S['OrganizationDto'];

/**
 * `MemberDto`. Identity is FLAT and nullable — a membership whose user row is
 * gone is a data-integrity problem an operator must see, not one the API hides.
 * There is no `status` and no `joined_at`: an invitation creates no member row,
 * so a pending invite is simply not in this list.
 */
export type Member = Patch<S['MemberDto'], { email: string | null; name: string | null }>;

/* ── Projects ─────────────────────────────────────────────────────────────── */

/** Two values, not three, and neither is "production". */
export type Environment = S['Environment'];
export type ProjectStatus = S['ProjectStatus'];
export type Project = S['ProjectDto'];

/**
 * `UpdateProjectDto` — name and slug, and NOTHING else.
 *
 * `environment` is absent and its absence is the enforcement: `ValidationPipe`
 * runs `forbidNonWhitelisted`, so a body carrying it is refused before the DTO
 * is reached. `status` is absent too — a soft delete is `DELETE`.
 */
export type UpdateProjectBody = S['UpdateProjectDto'];
export type CreateProjectBody = S['CreateProjectDto'];
export type UpdateOrganizationBody = S['UpdateOrganizationDto'];

/**
 * Slug rules. The pattern and the floor are shared; THE CEILINGS ARE NOT —
 * organizations cap at 48 and projects at 64. Kept apart rather than averaged,
 * because a shared constant would silently start refusing a legal project slug.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN_LENGTH = 2;
export const ORGANIZATION_SLUG_MAX_LENGTH = 48;
export const PROJECT_SLUG_MAX_LENGTH = 64;
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_NAME_MIN_LENGTH = 1;
export const ORGANIZATION_NAME_MAX_LENGTH = 200;
export const ORGANIZATION_NAME_MIN_LENGTH = 2;

/* ── API keys ─────────────────────────────────────────────────────────────── */

export type ApiKeyState = S['ApiKeyDto']['status'];

/** `key_prefix` — the first 12 characters. There is no `masked_key`. */
export type ApiKey = Patch<
  S['ApiKeyDto'],
  { expires_at: string | null; last_used_at: string | null; revoked_at: string | null }
>;

/**
 * `CreatedApiKeyDto` — the ONLY response that ever carries `key`.
 *
 * Only the SHA-256 hash is stored, so nothing can reproduce the plaintext: not
 * the API, not the database, not an operator with psql. It must never be
 * written to a query cache, a URL or `localStorage`.
 */
export type CreatedApiKey = Patch<
  S['CreatedApiKeyDto'],
  { expires_at: string | null; last_used_at: string | null; revoked_at: string | null }
>;

/* ── Endpoints ────────────────────────────────────────────────────────────── */

export type EndpointStatus = S['EndpointDto']['status'];

/**
 * `EndpointDto`.
 *
 * There is no `circuit_state`, no `rate_limit_per_second` and no
 * `success_rate_24h`: the breaker reports through `status` + `disabled_reason`
 * + `disabled_at`, and the token bucket is `rate_limit` per
 * `rate_limit_window_seconds`.
 *
 * There is also no `has_live_secret`, despite the commit that added one — see
 * HANDOFF.md; the property is not in the published document.
 */
export type Endpoint = Patch<
  S['EndpointDto'],
  {
    description: string | null;
    disabled_reason: string | null;
    disabled_at: string | null;
    rate_limit: number | null;
    retry_policy_id: string | null;
  }
>;

/**
 * `CreatedEndpointDto`.
 *
 * A caller WITHOUT `endpoint-secrets.write` creates an endpoint that is PAUSED
 * with `secret: null` and `secret_pending: true`. It is not delivering and will
 * not deliver until an owner or admin rotates its secret and enables it. Going
 * live instead would sign every delivery with a key nobody holds.
 */
export type CreatedEndpoint = Patch<
  S['CreatedEndpointDto'],
  {
    description: string | null;
    disabled_reason: string | null;
    disabled_at: string | null;
    rate_limit: number | null;
    retry_policy_id: string | null;
    secret: string | null;
  }
>;

/**
 * `CreateEndpointDto`.
 *
 * `timeout_ms`, `max_concurrency` and `rate_limit_window_seconds` are restored
 * to OPTIONAL here, and that is a generator repair rather than a contract
 * disagreement: the published schema's `required` array is `["name","url"]`,
 * exactly right, but each of those three carries a `default`, and
 * openapi-typescript's `defaultNonNullable` (on by default) renders any
 * property with a default as required. Left alone it would make the create
 * dialog send three numbers the operator never chose, overriding server
 * defaults that exist precisely so it does not have to.
 */
export type CreateEndpointBody = Patch<
  S['CreateEndpointDto'],
  {
    timeout_ms?: number;
    max_concurrency?: number;
    rate_limit_window_seconds?: number;
    rate_limit?: number | null;
    retry_policy_id?: string | null;
  }
>;

/**
 * `UpdateEndpointDto` — `status` is DELIBERATELY not here. Enabling, disabling
 * and deleting have their own routes because each carries a precondition a
 * PATCH would walk past.
 *
 * The same `default`-implies-required generator repair as the create body. The
 * schema has no `required` array at all here, which is `PartialType` doing
 * exactly what it should.
 *
 * `custom_headers` IS NOT NULLABLE in the schema, unlike `rate_limit` and
 * `retry_policy_id`. Unsetting them is therefore `{}` and not `null` — the
 * service stores an empty map as NULL so that "unset" has one representation.
 */
export type UpdateEndpointBody = Patch<
  S['UpdateEndpointDto'],
  {
    timeout_ms?: number;
    max_concurrency?: number;
    rate_limit_window_seconds?: number;
    rate_limit?: number | null;
    retry_policy_id?: string | null;
  }
>;

export type DisableEndpointBody = S['DisableEndpointDto'];

/**
 * `ENDPOINT_LIMITS` in control-api `src/endpoints/endpoint-limits.ts`, mirrored
 * so a form can refuse an out-of-range value before spending a round trip.
 * These are bounds on a lever into the SHARED data plane, not cosmetic
 * validation — `timeout_ms` is how long one tenant may hold a worker slot.
 */
export const ENDPOINT_LIMITS = {
  timeout_ms: { min: 1_000, max: 120_000, default: 30_000 },
  max_concurrency: { min: 1, max: 256, default: 16 },
  rate_limit: { min: 1, max: 100_000 },
  rate_limit_window_seconds: { min: 1, max: 3_600, default: 1 },
} as const;

export const MAX_ENDPOINT_NAME_LENGTH = 200;
export const MAX_ENDPOINT_DESCRIPTION_LENGTH = 1_000;
export const MAX_ENDPOINT_URL_LENGTH = 2_048;
export const MAX_CUSTOM_HEADERS = 20;

/**
 * Header names the platform refuses, mirrored from
 * `src/endpoints/endpoint-headers.ts`. `Webhook-*` is the whole namespace: it
 * carries the signature and the delivery identity, so a tenant able to restate
 * one could forge a webhook into their own consumer.
 */
export const RESERVED_HEADER_NAMES: readonly string[] = [
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
];
export const RESERVED_HEADER_PREFIX = 'webhook-';

/* ── Endpoint secrets ─────────────────────────────────────────────────────── */

/**
 * `EndpointSecretDto` — METADATA ONLY. There is no field here that could hold
 * a secret, and that is the point: this is the type every read path returns, so
 * a plaintext value has nowhere to leak into even by accident.
 */
export type EndpointSecret = Patch<
  S['EndpointSecretDto'],
  { expires_at: string | null; rotated_at: string | null }
>;

/**
 * `RotatedSecretDto`. Overlapping validity is the point: during rotation every
 * active secret emits its own `v1=` component, a consumer matching any one of
 * them verifies, and `previous_secrets_expire_at` is the deadline for rolling.
 */
export type RotatedSecret = Patch<
  S['RotatedSecretDto'],
  {
    expires_at: string | null;
    rotated_at: string | null;
    previous_secrets_expire_at: string | null;
  }
>;

/** Default `overlap_seconds` on the control API. */
export const DEFAULT_OVERLAP_SECONDS = 86_400;

/* ── Subscriptions ────────────────────────────────────────────────────────── */

/**
 * `SubscriptionDto`.
 *
 * `endpoint_name` does not exist — the row carries `endpoint_id` only, so a
 * screen that shows a name has to join against the endpoint list. The filter
 * field is `payload_filter`, not `filter`, and there is an `updated_at`.
 */
export type Subscription = Patch<S['SubscriptionDto'], { name: string | null }>;

/* ── Retry policies ───────────────────────────────────────────────────────── */

export type RetryPolicy = S['RetryPolicyDto'];
export type RetryStrategy = S['RetryPolicyDto']['strategy'];

/* ── Events ───────────────────────────────────────────────────────────────── */

export type EventStatus = S['EventDto']['status'];

/**
 * `EventDto`.
 *
 * The size field is `payload_size`, not `payload_size_bytes`, and there is NO
 * `delivery_counts` — the fan-out roll-up an event row showed was invented.
 * `payload_hash`, `payload_inline`, `payload_location`, `headers` and
 * `processed_at` are all new.
 */
export type WebhookEvent = Patch<
  S['EventDto'],
  {
    idempotency_key: string | null;
    ordering_key: string | null;
    payload_location: string | null;
    processed_at: string | null;
  }
>;

/**
 * `EventPayloadDto` — the payload is an ENVELOPE, not the raw body.
 *
 * It says where the bytes came from (`inline`, `object_storage`, `unavailable`)
 * and carries a `notice` explaining the case, because an event whose payload
 * was offloaded to object storage and is not currently readable must not render
 * as an empty code block.
 */
export type EventPayload = Patch<
  S['EventPayloadDto'],
  { body: string | null; location: string | null }
>;

export type EventDetail = Patch<
  S['EventDetailDto'],
  {
    idempotency_key: string | null;
    ordering_key: string | null;
    payload_location: string | null;
    processed_at: string | null;
    payload: EventPayload;
  }
>;

/* ── Deliveries ───────────────────────────────────────────────────────────── */

export type DeliveryStatus = S['DeliveryDto']['status'];

/**
 * `DeliveryDto`.
 *
 * `event_type`, `endpoint_name`, `endpoint_url` and `last_status_code` DO NOT
 * EXIST on a list row. The list carries ids; the identifying detail lives on
 * `DeliveryDetailDto` as nested `event` and `endpoint` objects, and the last
 * status code only ever existed on an attempt (`http_status`).
 *
 * `is_replay`, `replay_of_delivery_id` and `replayed_by` are new and matter: a
 * replay is a real delivery row, and hiding it would make the ledger lie.
 */
export type Delivery = Patch<
  S['DeliveryDto'],
  {
    subscription_id: string | null;
    next_attempt_at: string | null;
    last_attempt_at: string | null;
    completed_at: string | null;
    ordering_key: string | null;
    last_error: string | null;
    locked_by: string | null;
    locked_until: string | null;
    replay_of_delivery_id: string | null;
    replayed_by: string | null;
  }
>;

export type DeliveryEventRef = Patch<
  S['DeliveryEventRefDto'],
  { idempotency_key: string | null }
>;
export type DeliveryEndpointRef = Patch<
  S['DeliveryEndpointRefDto'],
  { disabled_reason: string | null }
>;

/**
 * `DeliveryAttemptDto`.
 *
 * `status_code` is `http_status`; `error` is `error_message` (plus a separate
 * `error_code`); `attempted_at` is `started_at`; `response_truncated` is gone
 * in favour of `response_size` and `response_body_location`. `duration_ms` is
 * NULLABLE — an attempt that is still in flight has not got one.
 */
export type DeliveryAttempt = Patch<
  S['DeliveryAttemptDto'],
  {
    http_status: number | null;
    completed_at: string | null;
    duration_ms: number | null;
    response_body: string | null;
    response_body_location: string | null;
    response_size: number | null;
    error_code: string | null;
    error_message: string | null;
    worker_id: string | null;
  }
>;

/**
 * `DeliveryDetailDto` — the row, plus the nested refs and the attempt history.
 *
 * `attempts` is EMBEDDED, and `attempts_truncated` says whether the embedded
 * list is complete. The separate `…/attempts` route is the pager for when it is
 * not; a detail page must read the flag rather than assume the array is whole.
 */
export type DeliveryDetail = Patch<
  S['DeliveryDetailDto'],
  {
    subscription_id: string | null;
    next_attempt_at: string | null;
    last_attempt_at: string | null;
    completed_at: string | null;
    ordering_key: string | null;
    last_error: string | null;
    locked_by: string | null;
    locked_until: string | null;
    replay_of_delivery_id: string | null;
    replayed_by: string | null;
    event: DeliveryEventRef;
    endpoint: DeliveryEndpointRef;
    attempts: DeliveryAttempt[];
  }
>;

export type ReplayResult = Patch<S['ReplayResultDto'], { deliveries: Delivery[] }>;

/* ── Audit log ────────────────────────────────────────────────────────────── */

/**
 * `AuditLogDto`.
 *
 * There is no nested `actor` object: the actor is `user_id` OR `api_key_id`,
 * either of which may be null (a platform action has neither). `target` is
 * `resource_type` + `resource_id`, and `ip` is `ip_address`. `user_agent` is
 * new. NOTE that only IDS are returned — there is no email or display name on
 * the row, so a screen cannot show "who" without a second lookup.
 */
export type AuditLogEntry = S['AuditLogDto'];

/* ═══════════════════════════════════════════════════════════════════════════
 * MOCK-ONLY. No route and no schema in the OpenAPI document.
 *
 * These are NOT contracts and must not be treated as any. They are the shapes
 * `src/lib/mock/server.ts` invented for two screens the control API has no
 * module for at all — not "a module whose types drifted", a module that does
 * not exist. Both screens now say so when the real transport is on, rather than
 * rendering a 404 as an error or, worse, rendering fabricated numbers.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface DeliveryCounts {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  exhausted: number;
}

export interface AnalyticsPoint {
  bucket: string;
  succeeded: number;
  failed: number;
  retrying: number;
  p95_latency_ms: number;
}

export interface ProjectAnalytics {
  window: '24h' | '7d' | '30d';
  points: AnalyticsPoint[];
  totals: DeliveryCounts;
  p95_latency_ms: number;
  success_rate: number;
}

export interface UsageSummary {
  period_start: string;
  period_end: string;
  events_ingested: number;
  deliveries_attempted: number;
  included_events: number;
  overage_events: number;
}

/* ── Auth request bodies ──────────────────────────────────────────────────── */

export type LoginBody = S['LoginDto'];

/**
 * `RegisterDto`. `name` and `organization_name` are OPTIONAL on the wire — the
 * hand-written type required both, and the register form still asks for both,
 * which is a product choice rather than a contract.
 */
export type RegisterBody = S['RegisterDto'];
export type ForgotPasswordBody = S['ForgotPasswordDto'];
export type ResetPasswordBody = S['ResetPasswordDto'];

/**
 * `POST /v1/auth/register` answers `{"status":"accepted"}` with no session
 * cookie, identically whether or not the address was already taken. A
 * distinguishable response would turn registration into an account-enumeration
 * oracle. `status` is typed `string`, not the literal.
 */
export type RegistrationAccepted = S['AcknowledgedDto'];
