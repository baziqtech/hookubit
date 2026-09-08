/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DOMAIN NAMES FOR THE GENERATED OPENAPI TYPES.
 *
 * `src/types/api.d.ts` is written by `pnpm --filter @webhook/dashboard
 * generate:api` from the control API's live `/docs-json`. It is the contract.
 * NOTHING in this file re-states a field name or a field type by hand — every
 * alias below is `components['schemas'][…]`, so a rename on the wire is a
 * compile error here rather than an `undefined` on a page.
 *
 * THE `Patch<>` REPAIR LAYER IS GONE. Twenty-one types used to re-declare
 * fields the document described wrongly — almost all of them `X | null`
 * properties that arrived as `Record<string, never> | null`, because there is
 * no @nestjs/swagger CLI plugin and TypeScript's `design:type` reflection emits
 * `Object` for any union. The control API now states the type of every nullable
 * property explicitly and gets required-ness right per field, so the generated
 * types say what the wire says and there is nothing left to repair. The
 * generator flag that produced the last two repairs — `defaultNonNullable`,
 * which makes any property carrying a `default` non-optional — is turned off in
 * the `generate:api` script.
 *
 * WHAT SURVIVES BY HAND, AND WHY. Each is something the OpenAPI document
 * cannot carry, not something that was too tedious to migrate:
 *
 *   1. `OffsetPage<T>` — a GENERIC. The document declares thirteen concrete
 *      `*ListDto` schemas; a type parameterised over its row type is not
 *      expressible in OpenAPI, and it is what every caller and `offsetPage()`
 *      read. Its fields still match the generated envelopes exactly.
 *   2. CLIENT-SIDE MIRRORS OF SERVER LIMITS — numbers a form uses to refuse a
 *      value before spending a round trip. openapi-typescript does not emit
 *      `minLength`/`maximum`/`pattern` into the type at all, so these cannot be
 *      derived. They are conveniences; the server stays the authority, and a
 *      stale one costs a 400 rather than corruption.
 *   3. MOCK-ONLY VIEW MODELS at the bottom of this file — two screens the
 *      control API has no module for. Not drift: no route, no schema.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { components } from './api.d';

type S = components['schemas'];

/* ── Errors ───────────────────────────────────────────────────────────────── */

/**
 * `ApiErrorResponse` — the body of EVERY non-2xx response.
 *
 * This used to be hand-written, mirrored from control-api
 * `src/common/errors.ts`, because Nest's Swagger module documents 2xx bodies
 * only. The envelope is now a declared schema attached to all 150 error
 * responses, so the eleven codes are a real union: an unhandled one is a
 * compile error rather than a string that quietly falls through to "Request
 * failed".
 */
export type ApiErrorBody = S['ApiErrorResponse'];

/**
 * The `error` object itself — what `ApiRequestError` is constructed from and
 * what `AppExceptionFilter` writes.
 *
 * `message` is `string | string[]`: an array on a 400 from the global
 * `ValidationPipe`, one entry per rejected property reading
 * `"<property>: <reason>"`. That array is the only field map this API returns,
 * so it must be narrowed rather than flattened — see `src/lib/api-errors.ts`.
 */
export type ApiErrorPayload = ApiErrorBody['error'];

/**
 * The eleven values of `ERROR_CODES`. Codes are additive and never repurposed;
 * `normaliseApiError` maps anything it does not recognise to `internal_error`
 * so this stays a CLOSED union on the client side — which is what lets a
 * `switch` over it be checked for exhaustiveness.
 */
export type ApiErrorCode = ApiErrorPayload['code'];

/**
 * The same eleven values at RUNTIME, which a type alone cannot give.
 *
 * `satisfies Record<ApiErrorCode, true>` is the load-bearing part: a code added
 * to the control API's enum makes THIS OBJECT a compile error, so the narrowing
 * below cannot silently start folding a real code into `internal_error`. It is
 * not a second declaration of the union — it is checked against it.
 */
const API_ERROR_CODES = {
  invalid_request: true,
  unauthenticated: true,
  forbidden: true,
  email_not_verified: true,
  not_found: true,
  conflict: true,
  limit_exceeded: true,
  idempotency_key_reused: true,
  payload_too_large: true,
  rate_limited: true,
  internal_error: true,
} satisfies Record<ApiErrorCode, true>;

/**
 * Narrows a value off the wire to the union.
 *
 * `hasOwnProperty` rather than `in`, because `'toString' in {}` is true and an
 * error code of `"constructor"` must not pass.
 */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(API_ERROR_CODES, value)
  );
}

/**
 * `error.details` — structured, code-specific context, absent on most errors.
 *
 * Two shapes are contract: `limit_exceeded` always carries
 * `{ limit, current, resource }` and `rate_limited` carries
 * `retry_after_seconds`. The schema declares those four and stays open
 * (`additionalProperties`), so reading an undeclared key is `unknown`.
 */
export type ApiErrorDetails = NonNullable<ApiErrorPayload['details']>;

/* ── Pagination ───────────────────────────────────────────────────────────── */

/**
 * ONE list envelope, not three — `{ data, has_more, next_offset }` on all
 * thirteen `*ListDto` schemas, with `next_offset` NULL (never absent, never 0)
 * on the last page.
 *
 * Generic over the row type, which is why it is written here rather than
 * aliased: OpenAPI has no type parameters. `offsetPage()` in
 * `src/lib/pagination.ts` is the only thing that touches the raw envelope.
 */
export interface OffsetPage<T> {
  data: T[];
  has_more: boolean;
  next_offset: number | null;
}

/** Page size bounds from control-api `src/authz/tenant-scope.ts`. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/* ── Identity ─────────────────────────────────────────────────────────────── */

export type Role = S['OrganizationDto']['role'];

/** `AuthUserDto`. `email_verified` is a BOOLEAN; there is no `created_at`. */
export type User = S['AuthUserDto'];

/**
 * `SessionResponseDto` — `{ user }` and NOTHING ELSE. There is no
 * `organizations` here; callers read `GET /v1/organizations`.
 */
export type Session = S['SessionResponseDto'];

/** `OrganizationDto`. `role` is the CALLER's role, not a property of the org. */
export type Organization = S['OrganizationDto'];

/**
 * `MemberDto`. Identity is FLAT and nullable — a membership whose user row is
 * gone is a data-integrity problem an operator must see, not one the API hides.
 * There is no `status` and no `joined_at`: an invitation creates no member row,
 * so a pending invite is simply not in this list.
 */
export type Member = S['MemberDto'];

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
export type ApiKey = S['ApiKeyDto'];

/**
 * `CreatedApiKeyDto` — the ONLY response that ever carries `key`.
 *
 * Only the SHA-256 hash is stored, so nothing can reproduce the plaintext: not
 * the API, not the database, not an operator with psql. It must never be
 * written to a query cache, a URL or `localStorage`.
 */
export type CreatedApiKey = S['CreatedApiKeyDto'];

/* ── Endpoints ────────────────────────────────────────────────────────────── */

export type EndpointStatus = S['EndpointDto']['status'];

/**
 * `EndpointDto`.
 *
 * There is no `circuit_state`, no `rate_limit_per_second` and no
 * `success_rate_24h`: the breaker reports through `status` + `disabled_reason`
 * + `disabled_at`, and the token bucket is `rate_limit` per
 * `rate_limit_window_seconds`. `has_live_secret` IS here now.
 */
export type Endpoint = S['EndpointDto'];

/**
 * `CreatedEndpointDto`.
 *
 * A caller WITHOUT `endpoint-secrets.write` creates an endpoint that is PAUSED
 * with `secret: null` and `secret_pending: true`. It is not delivering and will
 * not deliver until an owner or admin rotates its secret and enables it. Going
 * live instead would sign every delivery with a key nobody holds.
 */
export type CreatedEndpoint = S['CreatedEndpointDto'];

/**
 * `CreateEndpointDto`. `required` is `["name","url"]` — everything else is
 * optional and the server supplies the default, which is why `generate:api`
 * passes `--default-non-nullable false`. With the flag on its default, the
 * three properties carrying a `default` came out REQUIRED and the create dialog
 * would have sent three numbers the operator never chose.
 */
export type CreateEndpointBody = S['CreateEndpointDto'];

/**
 * `UpdateEndpointDto` — `status` is DELIBERATELY not here. Enabling, disabling
 * and deleting have their own routes because each carries a precondition a
 * PATCH would walk past.
 *
 * `custom_headers` IS NOT NULLABLE, unlike `rate_limit` and `retry_policy_id`.
 * Unsetting them is therefore `{}` and not `null` — the service stores an empty
 * map as NULL so that "unset" has one representation.
 */
export type UpdateEndpointBody = S['UpdateEndpointDto'];

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
export type EndpointSecret = S['EndpointSecretDto'];

/**
 * `RotatedSecretDto`. Overlapping validity is the point: during rotation every
 * active secret emits its own `v1=` component, a consumer matching any one of
 * them verifies, and `previous_secrets_expire_at` is the deadline for rolling.
 */
export type RotatedSecret = S['RotatedSecretDto'];

/** `RotateSecretDto` — `overlap_seconds` only, and optional. */
export type RotateSecretBody = S['RotateSecretDto'];

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
export type Subscription = S['SubscriptionDto'];

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
 */
export type WebhookEvent = S['EventDto'];

/**
 * `EventPayloadDto` — the payload is an ENVELOPE, not the raw body.
 *
 * It says where the bytes came from (`inline`, `object_storage`, `unavailable`)
 * and carries a `notice` explaining the case, because an event whose payload
 * was offloaded to object storage and is not currently readable must not render
 * as an empty code block.
 */
export type EventPayload = S['EventPayloadDto'];

export type EventDetail = S['EventDetailDto'];

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
 * `is_replay`, `replay_of_delivery_id` and `replayed_by` are real and matter: a
 * replay is a real delivery row, and hiding it would make the ledger lie.
 */
export type Delivery = S['DeliveryDto'];

export type DeliveryEventRef = S['DeliveryEventRefDto'];
export type DeliveryEndpointRef = S['DeliveryEndpointRefDto'];

/**
 * `DeliveryAttemptDto`.
 *
 * `status_code` is `http_status`; `error` is `error_message` (plus a separate
 * `error_code`); `attempted_at` is `started_at`; `response_truncated` is gone
 * in favour of `response_size` and `response_body_location`. `duration_ms` is
 * NULLABLE — an attempt that is still in flight has not got one.
 */
export type DeliveryAttempt = S['DeliveryAttemptDto'];

/**
 * `DeliveryDetailDto` — the row, plus the nested refs and the attempt history.
 *
 * `attempts` is EMBEDDED, and `attempts_truncated` says whether the embedded
 * list is complete. The separate `…/attempts` route is the pager for when it is
 * not; a detail page must read the flag rather than assume the array is whole.
 */
export type DeliveryDetail = S['DeliveryDetailDto'];

export type ReplayResult = S['ReplayResultDto'];

/* ── Audit log ────────────────────────────────────────────────────────────── */

/**
 * `AuditLogDto`.
 *
 * There is no nested `actor` object: the actor is `user_id` OR `api_key_id`,
 * either of which may be null (a platform action has neither). `target` is
 * `resource_type` + `resource_id`, and `ip` is `ip_address`. NOTE that only IDS
 * are returned — there is no email or display name on the row, so a screen
 * cannot show "who" without a second lookup.
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
 * register form still asks for both, which is a product choice rather than a
 * contract.
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
