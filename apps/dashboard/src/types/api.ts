/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TEMPORARY — hand-written, now realigned against the CONTROL API SOURCE
 * (apps/control-api/src/{organizations,members,projects,api-keys,endpoints,
 * endpoint-secrets}/dto/**) rather than against docs/API.md.
 *
 * The control API does not publish its OpenAPI document yet. The moment
 * `/docs-json` is live, run:
 *
 *     pnpm --filter @webhook/dashboard generate:api
 *
 * which writes `src/types/api.d.ts`, and then DELETE this file, re-pointing
 * consumers at the generated `components['schemas'][...]` types.
 * ARCHITECTURE.md 7: request and response types are never hand-duplicated.
 *
 * Types below are split into two groups, and the split is the important part:
 *
 *   VERIFIED — copied field-for-field from a DTO class that exists and is
 *   mounted. If one of these is wrong, the control API changed.
 *
 *   SPECULATIVE — no module exists yet (events, deliveries, subscriptions,
 *   analytics, usage, audit). These are the mock's invention and WILL drift.
 *   Nothing here should be trusted as a contract; see HANDOFF.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ── Errors ───────────────────────────────────────────────── VERIFIED ────── */

/**
 * Error envelope, identical on every non-2xx response.
 *
 * `details` was missing from this type and is load-bearing: it is where the
 * throttle guard puts `retry_after_seconds` and where a resource ceiling puts
 * `limit`/`current`. Without it the UI cannot tell "slow down" from "you have
 * hit a limit" — see `src/lib/api-errors.ts`.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

/**
 * The exact key set of `ERROR_CODES` in control-api `src/common/errors.ts`.
 * Codes are additive; treat an unknown string as `internal_error`.
 *
 * NOTE: there is no `limit_exceeded` code. A resource ceiling is reported as
 * `conflict` (409) with a prose message, which is why the dashboard has to
 * classify it — see `classifyWriteError`.
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  /** 403 on login when the address has not been confirmed yet. */
  | 'email_not_verified'
  | 'not_found'
  | 'conflict'
  | 'idempotency_key_reused'
  | 'payload_too_large'
  /** 429. Every write route carries a `@Throttle`. */
  | 'rate_limited'
  | 'internal_error';

/* ── Pagination ───────────────────────────────────────────── VERIFIED ────── */

/**
 * The control API pages by OFFSET, not by cursor, and it returns THREE
 * different envelopes. They are modelled separately on purpose: collapsing them
 * into one optional-everything type is exactly how a missing `has_more` becomes
 * `undefined` and a truncated list renders as a complete one.
 *
 * Page size is bounded by `MAX_PAGE_SIZE` (200) in control-api
 * `src/authz/tenant-scope.ts`; the default is `DEFAULT_PAGE_SIZE` (50). Asking
 * for more is a 400, not a silent clamp.
 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * `EndpointListDto`, `EndpointSecretListDto`. No `count` — the array length is
 * the count, and the DTO deliberately does not repeat it.
 */
export interface OffsetPage<T> {
  data: T[];
  has_more: boolean;
  next_offset: number | null;
}

/**
 * `ProjectListDto`, `ApiKeyListDto`. Same as `OffsetPage` plus `count`, which
 * is the number of rows in THIS page — not a total. The DTO comment is explicit
 * that comparing it against `limit` to detect the last page is the bug
 * `has_more` exists to close.
 */
export interface CountedOffsetPage<T> extends OffsetPage<T> {
  count: number;
}

/**
 * `OrganizationListDto`, `MemberListDto`. A different shape again: a genuine
 * `total` across the whole collection, and the echoed `limit`/`offset` — but NO
 * `has_more` and NO `next_offset`. The caller derives both from the arithmetic;
 * `totalPage()` in `src/lib/pagination.ts` is the only place that does.
 */
export interface TotalPage<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Cursor paging, kept ONLY for the mock-only routes (events, deliveries, audit
 * logs). No control-plane module returns this shape. When those modules land
 * they will almost certainly return an offset envelope like everything else.
 */
export interface CursorPage<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/* ── Identity ─────────────────────────────────────────────── VERIFIED ────── */

/** `MemberRole` in the Prisma schema. */
export type Role = 'owner' | 'admin' | 'developer' | 'viewer' | 'billing';

export interface User {
  id: string;
  email: string;
  name: string;
  email_verified_at: string | null;
  created_at: string;
}

/** `OrganizationDto`. `role` is the CALLER's role, not a property of the org. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'deleted';
  role: Role;
  created_at: string;
  updated_at: string;
}

/**
 * `MemberDto`. Identity is FLAT (`user_id`/`email`/`name`), not a nested `user`
 * object, and `email`/`name` are nullable — a membership whose user row is gone
 * is a data-integrity problem an operator must see, not one the API hides.
 *
 * There is no `status` and no `joined_at`. An invitation creates no member row
 * at all: the invitee redeems a token at `POST /v1/invitations/accept`, so a
 * pending invite is simply not in this list.
 */
export interface Member {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: Role;
  /** True when the account is disabled platform-wide. */
  disabled: boolean;
  created_at: string;
}

export interface Session {
  user: User;
  organizations: Organization[];
}

/* ── Projects ─────────────────────────────────────────────── VERIFIED ────── */

/** Prisma `Environment`. Two values, not three, and neither is "production". */
export type Environment = 'test' | 'live';

/** Prisma `ProjectStatus`. `deleted` is a soft delete; the row and ledger survive. */
export type ProjectStatus = 'active' | 'suspended' | 'deleted';

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  /** IMMUTABLE after creation — it re-scopes every key and endpoint underneath. */
  environment: Environment;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

/* ── API keys ─────────────────────────────────────────────── VERIFIED ────── */

/**
 * Derived from `revoked_at`/`expires_at` at read time, exactly as the Go ingest
 * path derives it. `active` still does not mean the key works: a suspended or
 * deleted project refuses every key under it.
 */
export type ApiKeyState = 'active' | 'expired' | 'revoked';

export interface ApiKey {
  id: string;
  project_id: string;
  name: string;
  /** First 12 characters, e.g. `wk_live_a9Kd`. Safe to display and to log. */
  key_prefix: string;
  environment: Environment;
  status: ApiKeyState;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * `CreatedApiKeyDto` — the ONLY response that ever carries `key`.
 *
 * Only the SHA-256 hash is stored, so nothing in the system can reproduce the
 * plaintext: not the API, not the database, not an operator with psql. A caller
 * that loses it revokes and re-issues. It must never be written to a query
 * cache, a URL or `localStorage`.
 */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

/* ── Endpoints ────────────────────────────────────────────── VERIFIED ────── */

/** Prisma `EndpointStatus`. `deleted` is a soft delete and is filtered out by default. */
export type EndpointStatus = 'active' | 'paused' | 'disabled' | 'deleted';

/**
 * `EndpointDto`.
 *
 * `circuit_state`, `rate_limit_per_second` and `success_rate_24h` do NOT exist
 * on the wire — they were hand-written inventions. The breaker reports through
 * `status` + `disabled_reason` + `disabled_at` instead ("Operator intent. The
 * circuit breaker uses `status`."), and the token bucket is
 * `rate_limit` per `rate_limit_window_seconds`, not a per-second scalar.
 */
export interface Endpoint {
  id: string;
  project_id: string;
  name: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  /** Operator intent, independent of the breaker's `status`. */
  enabled: boolean;
  /** Set by the circuit breaker. */
  disabled_reason: string | null;
  disabled_at: string | null;
  timeout_ms: number;
  max_concurrency: number;
  /** Tokens per `rate_limit_window_seconds`. Null means unlimited. */
  rate_limit: number | null;
  rate_limit_window_seconds: number;
  retry_policy_id: string | null;
  custom_headers: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

/**
 * `CreatedEndpointDto`.
 *
 * The half of the contract the UI must never paper over: a caller WITHOUT
 * `endpoint-secrets.write` (i.e. a developer, not an owner or admin) creates an
 * endpoint that is PAUSED with `secret: null` and `secret_pending: true`. It is
 * not delivering and will not deliver until an owner or admin rotates its
 * secret and enables it. Going live instead would sign every delivery with a
 * key nobody holds — the consumer would reject all of them, and the rotation
 * that fixed it would change the secret again: two verification outages
 * instead of none.
 */
export interface CreatedEndpoint extends Endpoint {
  /** Plaintext v1 signing secret, returned HERE AND NOWHERE ELSE, or null. */
  secret: string | null;
  secret_pending: boolean;
  secret_version: number;
}

export interface CreateEndpointBody {
  name: string;
  url: string;
  description?: string;
  timeout_ms?: number;
  max_concurrency?: number;
  rate_limit?: number;
  rate_limit_window_seconds?: number;
}

/* ── Endpoint secrets ─────────────────────────────────────── VERIFIED ────── */

/**
 * `EndpointSecretDto` — METADATA ONLY. There is no field here that could hold a
 * secret, and that is the point: this is the type every read path returns, so a
 * plaintext value has nowhere to leak into even by accident. There is no
 * `masked_secret`; that was invented.
 */
export interface EndpointSecret {
  id: string;
  endpoint_id: string;
  /** Monotonic per endpoint. Highest version is the newest. */
  version: number;
  /** Signing right now: the stored flag AND an `expires_at` that has not passed. */
  active: boolean;
  expires_at: string | null;
  rotated_at: string | null;
  created_at: string;
}

/**
 * `RotatedSecretDto`. Overlapping validity is the point: during rotation every
 * active secret emits its own `v1=` component, a consumer matching any one of
 * them verifies, and `previous_secrets_expire_at` is the deadline for rolling.
 */
export interface RotatedSecret extends EndpointSecret {
  /** Plaintext, returned exactly once, in this response. */
  secret: string;
  previous_secrets_expire_at: string | null;
  /** Every prior version that still signs, newest first. */
  overlapping_versions: number[];
}

/** Default `overlap_seconds` on the control API. */
export const DEFAULT_OVERLAP_SECONDS = 86_400;

/* ── Auth request bodies ──────────────────────────────────── VERIFIED ────── */

export interface LoginBody {
  email: string;
  password: string;
}

export interface RegisterBody {
  name: string;
  email: string;
  password: string;
  organization_name: string;
}

export interface ForgotPasswordBody {
  email: string;
}

export interface ResetPasswordBody {
  token: string;
  password: string;
}

/**
 * `POST /v1/auth/register` answers `202 {"status":"accepted"}` with no body of
 * substance and NO `Set-Cookie`, identically whether or not the address was
 * already taken. A distinguishable response — a 409, or a session cookie on the
 * success path alone — turns registration into an account-enumeration oracle.
 * Registering does not sign the user in: they verify by email, then log in.
 */
export interface RegistrationAccepted {
  status: 'accepted';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SPECULATIVE — no control-plane module exists for anything below this line.
 * The mock invented these shapes. Do not treat them as a contract.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface Subscription {
  id: string;
  project_id: string;
  endpoint_id: string;
  endpoint_name: string;
  name: string;
  /** `['*']` means every event type in the project. */
  event_types: string[];
  filter: Record<string, unknown> | null;
  enabled: boolean;
  created_at: string;
}

export type EventStatus = 'received' | 'processing' | 'processed' | 'failed';

export interface WebhookEvent {
  id: string;
  project_id: string;
  event_type: string;
  status: EventStatus;
  ordering_key: string | null;
  idempotency_key: string | null;
  payload_size_bytes: number;
  delivery_counts: DeliveryCounts;
  created_at: string;
}

export interface EventDetail extends WebhookEvent {
  payload: unknown;
  headers: Record<string, string>;
}

export interface DeliveryCounts {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  exhausted: number;
}

/** ARCHITECTURE.md 19 — explicit states, never a bag of booleans. */
export type DeliveryStatus =
  | 'pending'
  | 'scheduled'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'retrying'
  | 'exhausted'
  | 'cancelled';

export interface Delivery {
  id: string;
  project_id: string;
  event_id: string;
  event_type: string;
  endpoint_id: string;
  endpoint_name: string;
  endpoint_url: string;
  status: DeliveryStatus;
  /**
   * Whether the delivery has finished, from the server. Do NOT re-derive it by
   * testing next_attempt_at for null: a terminal delivery now carries a
   * timestamp there rather than NULL, because the column is becoming NOT NULL -
   * the claim query orders NULLS FIRST, so any row written NULL silently jumps
   * ahead of work that is actually due.
   */
  terminal: boolean;
  attempt_count: number;
  max_attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DeliveryDetail extends Delivery {
  payload: unknown;
  request_headers: Record<string, string>;
}

export interface DeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt_number: number;
  status_code: number | null;
  duration_ms: number;
  error: string | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
  response_truncated: boolean;
  attempted_at: string;
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

export interface AuditLogEntry {
  id: string;
  actor: { id: string; email: string; type: 'user' | 'api_key' | 'system' };
  action: string;
  target: string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
