/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TEMPORARY — hand-written against the contract in docs/API.md.
 *
 * The control API (@webhook/control-api) does not publish its OpenAPI document
 * yet. The moment `/docs-json` is live, run:
 *
 *     pnpm --filter @webhook/dashboard generate:api
 *
 * which writes `src/types/api.d.ts`, and then DELETE this file, re-pointing
 * `src/types/index.ts` at the generated `components['schemas'][...]` types.
 * ARCHITECTURE.md 7: request and response types are never hand-duplicated.
 * Everything here is a placeholder for exactly that reason — do not grow it
 * into a second source of truth.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Error envelope, identical on every non-2xx response (ARCHITECTURE.md 48). */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    request_id?: string;
  };
}

/** Codes are additive; treat an unknown string as `internal_error`. */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'idempotency_key_reused'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

/** Cursor pagination. The control API returns opaque cursors, never offsets. */
export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/* ── Identity ─────────────────────────────────────────────────────────────── */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer' | 'billing';

export interface User {
  id: string;
  email: string;
  name: string;
  email_verified_at: string | null;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'starter' | 'growth' | 'enterprise';
  role: Role;
  created_at: string;
}

export interface Member {
  id: string;
  user: Pick<User, 'id' | 'email' | 'name'>;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  joined_at: string | null;
}

export interface Session {
  user: User;
  organizations: Organization[];
}

/* ── Projects ─────────────────────────────────────────────────────────────── */

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  environment: 'production' | 'staging' | 'development';
  created_at: string;
}

export interface ApiKey {
  id: string;
  project_id: string;
  name: string;
  /** Non-secret display form, e.g. `wk_live_…7f3a`. */
  masked_key: string;
  /** Full key, returned exactly once at creation and never again. */
  key?: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

/* ── Endpoints ────────────────────────────────────────────────────────────── */

export type EndpointStatus = 'active' | 'paused' | 'disabled';

/** ARCHITECTURE.md 26 — a breaker is per-endpoint, not global. */
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface Endpoint {
  id: string;
  project_id: string;
  name: string;
  url: string;
  status: EndpointStatus;
  circuit_state: CircuitState;
  /** Set when the breaker tripped or an operator paused the endpoint. */
  disabled_reason: string | null;
  rate_limit_per_second: number | null;
  timeout_ms: number;
  /** Rolling health over the retention window, 0–1. */
  success_rate_24h: number;
  created_at: string;
}

/**
 * Overlapping validity is the point: during rotation two secrets are active,
 * the endpoint receives two `v1` signatures, and consumers roll without
 * dropping a delivery (docs/API.md, ARCHITECTURE.md 28).
 */
export interface EndpointSecret {
  id: string;
  masked_secret: string;
  secret?: string;
  created_at: string;
  expires_at: string | null;
}

/* ── Subscriptions ────────────────────────────────────────────────────────── */

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

/* ── Events ───────────────────────────────────────────────────────────────── */

export type EventStatus = 'received' | 'processing' | 'processed' | 'failed';

export interface WebhookEvent {
  id: string;
  project_id: string;
  event_type: string;
  status: EventStatus;
  ordering_key: string | null;
  idempotency_key: string | null;
  /** Bytes of the raw body as received; payloads over the inline limit spill to object storage (ARCHITECTURE.md 32). */
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

/* ── Deliveries ───────────────────────────────────────────────────────────── */

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
  attempt_count: number;
  max_attempts: number;
  /** Last observed HTTP status, null if the request never completed. */
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
  /** Truncated by the platform; `response_truncated` says so explicitly. */
  response_body: string | null;
  response_truncated: boolean;
  attempted_at: string;
}

/* ── Analytics, usage, audit ──────────────────────────────────────────────── */

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

/* ── Auth request bodies ──────────────────────────────────────────────────── */

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
