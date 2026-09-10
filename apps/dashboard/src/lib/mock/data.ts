/**
 * Deterministic mock dataset for the control API.
 *
 * Seeded, so the dashboard looks identical on every reload and a screenshot in
 * a bug report is reproducible. The shape of the data matters more than the
 * volume: it deliberately contains the states that are hard to render well —
 * an endpoint with an open circuit breaker, deliveries exhausted after eight
 * attempts, an attempt still in flight, a payload past the inline limit and one
 * past its retention window, DNS and TLS failures with no status code at all —
 * because those are the cases a demo dataset of happy paths lets you ship
 * broken.
 *
 * EVERY ROW HERE IS TYPED FROM `src/types/api.d.ts`, which is generated from the
 * live OpenAPI document. That is not a formality. The fixtures previously
 * carried `Delivery.event_type`, `Delivery.last_status_code`,
 * `Subscription.endpoint_name` and a nested audit `actor` — none of which exist
 * on the wire — and every screen built against them read fields the API will
 * never send. Where a field is gone, the information it held is joined from
 * where it actually lives: the event for the type, the last ATTEMPT for the
 * status code, the endpoint list for the name.
 */
import type {
  ApiKey,
  AuditLogEntry,
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Endpoint,
  EndpointSecret,
  EventDetail,
  EventPayload,
  EventStatus,
  Member,
  Organization,
  Role,
  OutboxEntry,
  Project,
  RetryPolicy,
  Subscription,
  User,
} from '../../types/api';
import type { RateLimit } from '../../types/api';

/** mulberry32 — small, fast, and stable across runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260906);
const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
/** A W3C trace id: 32 lowercase hex characters, never all zeros. */
const traceId = () =>
  Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('') ||
  '0';
/** A plausible lowercase-hex digest. Seeded, so it is stable across reloads. */
const digest = () =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');

/**
 * "Now", anchored ONCE at module load.
 *
 * It used to be a hard-coded 2026-09-06. That made the fixtures reproducible
 * across days, but it also meant every relative timestamp in the product drifted
 * further into the past the longer the file sat unedited — the delivery detail
 * page ended up rendering a scheduled FUTURE retry as "2 days ago", which is the
 * exact fact that screen exists to state correctly.
 *
 * Anchoring at import time keeps the property that actually mattered (stable for
 * the whole life of a page, so a screenshot is internally consistent and nothing
 * reflows between renders) while letting "next attempt in 14 minutes" read as
 * what it is. The seeded RNG is untouched, so the shape of the data — which
 * endpoint is broken, which chains are exhausted — is still identical every run.
 */
export const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

let counter = 0;
const id = (prefix: string) =>
  `${prefix}_01JQ${(counter++).toString(36).padStart(4, '0').toUpperCase()}${Math.floor(random() * 1e9)
    .toString(36)
    .toUpperCase()
    .padStart(6, 'X')}`;

/* ── Identity ─────────────────────────────────────────────────────────────── */

/**
 * `AuthUserDto`. `email_verified` is a BOOLEAN — there is no
 * `email_verified_at` and no `created_at` on the session user.
 *
 * `onboarding_completed_at` is `string | null` and now assignable either way —
 * it used to be pinned to null because the schema emitted it as an untyped
 * nullable. It stays null, but as a CHOICE: the demo operator has not finished
 * the product tour, which is what makes the first-run experience visible under
 * the mock transport.
 */
export const user: User = {
  id: 'usr_01JQOPERATOR',
  email: 'najib@shaqexpress.com',
  name: 'Najib Alhassan',
  email_verified: true,
  onboarding_completed_at: null,
};

export const organizations: Organization[] = [
  {
    id: 'org_01JQSHAQ',
    name: 'ShaQ Express',
    slug: 'shaq-express',
    status: 'active',
    role: 'owner',
    created_at: minutesAgo(60 * 24 * 120),
    updated_at: minutesAgo(60 * 24 * 3),
  },
  {
    id: 'org_01JQKWIK',
    name: 'Kwik Logistics',
    slug: 'kwik-logistics',
    status: 'active',
    role: 'admin',
    created_at: minutesAgo(60 * 24 * 30),
    updated_at: minutesAgo(60 * 24 * 30),
  },
];

/**
 * Identity is FLAT and nullable, matching `MemberDto`. `mem_05` deliberately has
 * a null email: that is a membership whose user row is gone, which the API
 * returns rather than hides so an operator can see the integrity problem.
 *
 * There are no "invited" rows, because an invitation creates no member row —
 * the invitee redeems a token at POST /v1/invitations/accept.
 */
export const members: Record<string, Member[]> = {
  'org_01JQSHAQ': [
    {
      id: 'mem_01',
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: 'owner',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 120),
    },
    {
      id: 'mem_02',
      user_id: 'usr_02',
      email: 'ama@shaqexpress.com',
      name: 'Ama Boateng',
      role: 'admin',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 64),
    },
    {
      id: 'mem_03',
      user_id: 'usr_03',
      email: 'finance@shaqexpress.com',
      name: 'Finance Systems',
      role: 'viewer',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 20),
    },
    {
      id: 'mem_04',
      user_id: 'usr_04',
      email: 'kofi@shaqexpress.com',
      name: 'Kofi Mensah',
      role: 'developer',
      disabled: true,
      created_at: minutesAgo(60 * 24 * 14),
    },
    {
      id: 'mem_05',
      user_id: 'usr_05_deleted',
      email: null,
      name: null,
      role: 'developer',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 55),
    },
  ],
  'org_01JQKWIK': [
    {
      id: 'mem_06',
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: 'admin',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 30),
    },
    // The demo user is an ADMIN here, and this is the owner they cannot touch:
    // the "you may not change the role of an owner" refusal has to be visible
    // somewhere, and it cannot be in the organization they own.
    {
      id: 'mem_07',
      user_id: 'usr_07',
      email: 'yaw@kwiklogistics.example',
      name: 'Yaw Darko',
      role: 'owner',
      disabled: false,
      created_at: minutesAgo(60 * 24 * 200),
    },
  ],
};

/**
 * `environment` is `test | live` — there is no `production`, `staging` or
 * `development` on the wire. `status` carries the soft delete.
 */
/**
 * Invitation tokens, keyed by the raw token the emailed link carries as
 * `?token=`. Not a DTO: the real API never returns an invitation, only the
 * organization on redemption, so this is the server-side state the mock needs
 * to answer `POST /v1/invitations/accept` the way `MembersService.accept` does.
 *
 * Tokens are 20–200 characters because `AcceptInvitationDto` validates that
 * length. `org_01JQNORTH` is deliberately NOT in `organizations`: it is the one
 * org the demo user can actually JOIN, so accepting `inv_live_...` visibly adds
 * a row rather than returning one that was already there.
 */
export interface MockInvitation {
  token: string;
  email: string;
  organization_id: string;
  role: Role;
  expires_at: string;
  consumed_at: string | null;
  /** The inviting membership no longer exists — the 409 branch. */
  inviter_gone?: boolean;
}

export const invitableOrganization: Organization = {
  id: 'org_01JQNORTH',
  name: 'Northline Freight',
  slug: 'northline-freight',
  status: 'active',
  role: 'developer',
  created_at: minutesAgo(60 * 24 * 45),
  updated_at: minutesAgo(60 * 24 * 2),
};

export const invitations: MockInvitation[] = [
  {
    token: 'inv_live_northline_developer_01',
    email: user.email,
    organization_id: invitableOrganization.id,
    role: 'developer',
    expires_at: minutesFromNow(60 * 24 * 6),
    consumed_at: null,
  },
  // Already a member of this one: redemption returns it unchanged, at the
  // role the membership already holds, NOT the role on the token.
  {
    token: 'inv_live_shaq_already_member_02',
    email: user.email,
    organization_id: 'org_01JQSHAQ',
    role: 'viewer',
    expires_at: minutesFromNow(60 * 24 * 6),
    consumed_at: null,
  },
  {
    token: 'inv_expired_northline_000000_03',
    email: user.email,
    organization_id: invitableOrganization.id,
    role: 'developer',
    expires_at: minutesAgo(60 * 24),
    consumed_at: null,
  },
  {
    token: 'inv_used_northline_00000000_04',
    email: user.email,
    organization_id: invitableOrganization.id,
    role: 'developer',
    expires_at: minutesFromNow(60 * 24 * 3),
    consumed_at: minutesAgo(30),
  },
  // Issued to a different mailbox than the one signed in.
  {
    token: 'inv_live_northline_other_addr_05',
    email: 'ama@shaqexpress.com',
    organization_id: invitableOrganization.id,
    role: 'admin',
    expires_at: minutesFromNow(60 * 24 * 6),
    consumed_at: null,
  },
  {
    token: 'inv_live_northline_inviter_gone_06',
    email: user.email,
    organization_id: invitableOrganization.id,
    role: 'developer',
    expires_at: minutesFromNow(60 * 24 * 6),
    consumed_at: null,
    inviter_gone: true,
  },
];

export const projects: Project[] = [
  {
    id: 'proj_01JQPAYPROD',
    organization_id: 'org_01JQSHAQ',
    name: 'Payments',
    slug: 'payments',
    environment: 'live',
    status: 'active',
    created_at: minutesAgo(60 * 24 * 118),
    updated_at: minutesAgo(60 * 24 * 2),
  },
  {
    id: 'proj_01JQPAYSTG',
    organization_id: 'org_01JQSHAQ',
    name: 'Payments Staging',
    slug: 'payments-staging',
    environment: 'test',
    status: 'active',
    created_at: minutesAgo(60 * 24 * 118),
    updated_at: minutesAgo(60 * 24 * 118),
  },
  {
    id: 'proj_01JQRIDER',
    organization_id: 'org_01JQSHAQ',
    name: 'Rider Dispatch',
    slug: 'rider-dispatch',
    environment: 'live',
    status: 'active',
    created_at: minutesAgo(60 * 24 * 41),
    updated_at: minutesAgo(60 * 24 * 41),
  },
  {
    id: 'proj_01JQKWIKMAIN',
    organization_id: 'org_01JQKWIK',
    name: 'Fulfilment',
    slug: 'fulfilment',
    environment: 'live',
    status: 'active',
    created_at: minutesAgo(60 * 24 * 29),
    updated_at: minutesAgo(60 * 24 * 29),
  },
];

const PROD = projects[0].id;

/* ── Retry policies ───────────────────────────────────────────────────────── */

/**
 * `RetryPolicyDto`, scoped to the project — which is the whole reason the
 * endpoint form has a picker rather than an id box. Only the first project owns
 * any, so the "this project has no retry policies" branch is reachable.
 *
 * Exactly one carries `is_default`, as the schema promises, and its
 * `max_attempts` is the 8 every delivery chain below is built against: a
 * fixture whose policy and whose deliveries disagreed would make the retry
 * arithmetic on the delivery page unverifiable.
 */
export const retryPolicies: RetryPolicy[] = [
  {
    id: 'rp_01JQDEFAULT',
    project_id: PROD,
    name: 'Default — exponential, 8 attempts',
    is_default: true,
    strategy: 'exponential',
    max_attempts: 8,
    initial_delay_ms: 30_000,
    max_delay_ms: 3_600_000,
    multiplier: 2,
    jitter_ratio: 0.2,
    max_retry_duration_ms: 86_400_000,
    created_at: minutesAgo(60 * 24 * 118),
    updated_at: minutesAgo(60 * 24 * 118),
  },
  {
    id: 'rp_01JQTIGHT',
    project_id: PROD,
    name: 'Impatient — 3 attempts, constant 30s',
    is_default: false,
    strategy: 'constant',
    max_attempts: 3,
    initial_delay_ms: 30_000,
    max_delay_ms: 30_000,
    multiplier: 1,
    jitter_ratio: 0,
    max_retry_duration_ms: 300_000,
    created_at: minutesAgo(60 * 24 * 40),
    updated_at: minutesAgo(60 * 24 * 40),
  },
  {
    id: 'rp_01JQPATIENT',
    project_id: PROD,
    name: 'Overnight — linear, 12 attempts over a week',
    is_default: false,
    strategy: 'linear',
    max_attempts: 12,
    initial_delay_ms: 60_000,
    max_delay_ms: 900_000,
    multiplier: 1,
    jitter_ratio: 0.1,
    max_retry_duration_ms: 604_800_000,
    created_at: minutesAgo(60 * 24 * 21),
    updated_at: minutesAgo(60 * 24 * 21),
  },
];

/* ── Rate-limit policies ──────────────────────────────────────────────────── */

/**
 * `RateLimitDto`. One row per shape the Policies page has to render honestly:
 * the every-key ingest budget, one key with its own ceiling, the project row,
 * the organization row, and an `endpoint`-scope row — which the data plane
 * does not read (the delivery workers charge only `endpoints.rate_limit`), so
 * the "Not enforced" badge is reachable rather than theoretical.
 *
 * `resource_id`s point at fixture rows that exist, because the mock resolves
 * them through the same lookups the API does and a dangling id would 404 on
 * every edit.
 */
export const rateLimitPolicies: RateLimit[] = [
  {
    id: 'rl_01JQINGESTALL',
    project_id: PROD,
    scope: 'ingest',
    resource_id: null,
    limit: 500,
    window_seconds: 1,
    burst: 1_000,
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'rl_01JQBACKFILLKEY',
    project_id: PROD,
    scope: 'ingest',
    resource_id: 'key_01JQBACKFILL',
    limit: 50,
    window_seconds: 1,
    burst: null,
    created_at: minutesAgo(60 * 24 * 12),
    updated_at: minutesAgo(60 * 24 * 2),
  },
  {
    id: 'rl_01JQPROJECT',
    project_id: PROD,
    scope: 'project',
    resource_id: null,
    limit: 2_000,
    window_seconds: 1,
    burst: null,
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'rl_01JQORG',
    project_id: PROD,
    scope: 'organization',
    resource_id: null,
    limit: 10_000,
    window_seconds: 60,
    burst: 20_000,
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 30),
  },
  {
    id: 'rl_01JQPARTNERCAP',
    project_id: PROD,
    scope: 'endpoint',
    resource_id: 'ep_01JQPARTNER',
    limit: 20,
    window_seconds: 1,
    burst: 40,
    created_at: minutesAgo(60 * 24 * 5),
    updated_at: minutesAgo(60 * 24 * 5),
  },
];

/* ── Endpoints ────────────────────────────────────────────────────────────── */

/**
 * `EndpointDto`, field for field. There is no `circuit_state`, no
 * `rate_limit_per_second` and no `success_rate_24h` on the wire — the breaker
 * reports through `status`/`disabled_reason`/`disabled_at`, and the token
 * bucket is `rate_limit` per `rate_limit_window_seconds`.
 *
 * `has_live_secret` is DERIVED from `endpointSecrets` below and never asserted
 * independently: it is true exactly when some secret row is active and unexpired,
 * which is the pair the data plane's secret loader uses. The two facts have to
 * agree, because `POST /enable` refuses with 409 on the secrets and the table
 * offers "Resume" on the flag — a fixture where they disagreed would make the
 * button lie.
 *
 * Filler rows take the list past one page on purpose: a list screen that has
 * never been rendered with `has_more: true` is a list screen that silently
 * truncates.
 */
const namedEndpoints: Endpoint[] = [
  {
    id: 'ep_01JQFINANCE',
    project_id: PROD,
    name: 'finance-api',
    url: 'https://finance.shaqexpress.internal/v1/webhooks/payments',
    description: 'Settlement postings into the finance ledger.',
    status: 'active',
    enabled: true,
    disabled_reason: null,
    disabled_at: null,
    timeout_ms: 10_000,
    max_concurrency: 32,
    rate_limit: 50,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: { 'x-shaq-source': 'webhooks' },
    has_live_secret: true,
    created_at: minutesAgo(60 * 24 * 118),
    updated_at: minutesAgo(60 * 24 * 4),
  },
  {
    id: 'ep_01JQLEDGER',
    project_id: PROD,
    name: 'ledger-service',
    url: 'https://ledger.shaqexpress.internal/hooks/settlement',
    description: null,
    status: 'active',
    enabled: true,
    disabled_reason: null,
    disabled_at: null,
    timeout_ms: 15_000,
    max_concurrency: 16,
    rate_limit: 25,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: null,
    has_live_secret: true,
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'ep_01JQPARTNER',
    project_id: PROD,
    // The problem endpoint: 30s timeouts, auto-disabled by the breaker. Its
    // secret is fine — nothing about the credential is why it stopped — so
    // `has_live_secret` stays true and "Resume anyway" is a real option.
    name: 'partner-reconciliation',
    url: 'https://api.partner-bank.example.com/inbound/shaq',
    description: 'Partner bank reconciliation feed.',
    status: 'disabled',
    enabled: true,
    // The real sentence `autoDisableReason()` writes (control-api
    // `maintenance/auto-disable-policy.ts`): the breaker opens at 5 consecutive
    // failures and the endpoint is switched off only after it has stayed open
    // for days. A fixture that named a threshold the platform does not have was
    // teaching operators the wrong number.
    disabled_reason:
      'auto-disabled: the circuit breaker had been open for 3d 2h (430 consecutive failures, ' +
      'last successful delivery: ' +
      minutesAgo(60 * 74 + 158) +
      '). New events are no longer queued for this endpoint. Re-enable it once the endpoint is ' +
      'answering.',
    disabled_at: minutesAgo(158),
    timeout_ms: 30_000,
    max_concurrency: 4,
    rate_limit: 5,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: null,
    has_live_secret: true,
    created_at: minutesAgo(60 * 24 * 60),
    updated_at: minutesAgo(158),
  },
  {
    id: 'ep_01JQANALYTICS',
    project_id: PROD,
    name: 'analytics-sink',
    url: 'https://ingest.analytics.shaqexpress.internal/webhooks',
    description: null,
    status: 'paused',
    enabled: false,
    disabled_reason: 'Paused by najib@shaqexpress.com during warehouse migration.',
    disabled_at: minutesAgo(60 * 30),
    timeout_ms: 5_000,
    max_concurrency: 16,
    rate_limit: null,
    rate_limit_window_seconds: 1,
    // The one endpoint on a non-default policy, so the picker has a selected
    // value to render and not only a placeholder.
    retry_policy_id: 'rp_01JQTIGHT',
    custom_headers: null,
    // Paused by a human, not by a missing credential: v2 still signs.
    has_live_secret: true,
    created_at: minutesAgo(60 * 24 * 12),
    updated_at: minutesAgo(60 * 30),
  },
  {
    id: 'ep_01JQPENDING',
    project_id: PROD,
    /*
     * THE `has_live_secret: false` CASE, which is why the field exists.
     *
     * Created by a developer, who may not be handed a signing secret. It is
     * PAUSED and holds no secret at all, so it cannot deliver: the data plane
     * fails closed rather than sign with a key nobody has. The endpoints table
     * offers "Resume" here, and `POST /enable` answers 409 until an owner or
     * admin rotates a secret — which is the only honest sequence, and the one
     * an operator has to be able to see before meeting it in production.
     */
    name: 'warehouse-sync',
    url: 'https://warehouse.shaqexpress.internal/hooks/inventory',
    description: null,
    status: 'paused',
    enabled: false,
    disabled_reason:
      'Awaiting a signing secret. Created by a developer, who may not receive one.',
    disabled_at: minutesAgo(90),
    timeout_ms: 30_000,
    max_concurrency: 16,
    rate_limit: null,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: null,
    has_live_secret: false,
    created_at: minutesAgo(90),
    updated_at: minutesAgo(90),
  },
  {
    id: 'ep_01JQREMOVED',
    project_id: PROD,
    // Soft-deleted. Hidden unless `?include_deleted=true`; kept forever so the
    // delivery ledger stays readable. Its secrets went with the deletion, so
    // nothing here signs anything.
    name: 'old-recon-endpoint',
    url: 'https://legacy.partner.example.com/hooks',
    description: null,
    status: 'deleted',
    enabled: false,
    disabled_reason: 'Deleted by najib@shaqexpress.com.',
    disabled_at: minutesAgo(60 * 24 * 6),
    timeout_ms: 30_000,
    max_concurrency: 16,
    rate_limit: null,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: null,
    has_live_secret: false,
    created_at: minutesAgo(60 * 24 * 200),
    updated_at: minutesAgo(60 * 24 * 6),
  },
];

/** Enough rows that the default page size is genuinely exceeded. */
const fillerEndpoints: Endpoint[] = Array.from({ length: 56 }, (_, index) => ({
  id: `ep_01JQFILL${index.toString().padStart(3, '0')}`,
  project_id: PROD,
  name: `merchant-${(index + 1).toString().padStart(3, '0')}-callback`,
  url: `https://merchant-${index + 1}.partners.example.com/shaq/webhooks`,
  description: null,
  status: 'active' as const,
  enabled: true,
  disabled_reason: null,
  disabled_at: null,
  timeout_ms: 30_000,
  max_concurrency: 16,
  rate_limit: null,
  rate_limit_window_seconds: 1,
  retry_policy_id: null,
  custom_headers: null,
  has_live_secret: true,
  created_at: minutesAgo(60 * 24 * (5 + index)),
  updated_at: minutesAgo(60 * 24 * (5 + index)),
}));

export const endpoints: Endpoint[] = [...namedEndpoints, ...fillerEndpoints];

/**
 * Secret METADATA per endpoint. No plaintext lives here and there is no field
 * it could occupy — a plaintext secret exists only in a create or rotate
 * response, once.
 *
 * `ep_01JQPENDING` and the deleted `ep_01JQREMOVED` are absent from this map on
 * purpose, and that absence is the same fact their `has_live_secret: false`
 * states.
 */
export const endpointSecrets: Record<string, EndpointSecret[]> = {
  ep_01JQFINANCE: [
    {
      id: 'sec_01JQFIN2',
      endpoint_id: 'ep_01JQFINANCE',
      version: 2,
      active: true,
      expires_at: null,
      rotated_at: null,
      created_at: minutesAgo(60 * 20),
    },
    {
      id: 'sec_01JQFIN1',
      endpoint_id: 'ep_01JQFINANCE',
      version: 1,
      // Still signing: the overlap window has not closed, so deliveries carry
      // both v1 components and consumers can be rolled without dropping one.
      active: true,
      expires_at: minutesAhead(60 * 4),
      rotated_at: minutesAgo(60 * 20),
      created_at: minutesAgo(60 * 24 * 118),
    },
  ],
  ep_01JQLEDGER: [
    {
      id: 'sec_01JQLED1',
      endpoint_id: 'ep_01JQLEDGER',
      version: 1,
      active: true,
      expires_at: null,
      rotated_at: null,
      created_at: minutesAgo(60 * 24 * 90),
    },
  ],
  ep_01JQPARTNER: [
    {
      id: 'sec_01JQPTR1',
      endpoint_id: 'ep_01JQPARTNER',
      version: 1,
      active: true,
      expires_at: null,
      rotated_at: null,
      created_at: minutesAgo(60 * 24 * 60),
    },
  ],
  ep_01JQANALYTICS: [
    {
      id: 'sec_01JQANL2',
      endpoint_id: 'ep_01JQANALYTICS',
      version: 2,
      active: true,
      expires_at: null,
      rotated_at: null,
      created_at: minutesAgo(60 * 24 * 12),
    },
    {
      id: 'sec_01JQANL1',
      endpoint_id: 'ep_01JQANALYTICS',
      version: 1,
      // Expired: `active` reads false even though nothing has swept the column.
      active: false,
      expires_at: minutesAgo(60 * 24 * 11),
      rotated_at: minutesAgo(60 * 24 * 12),
      created_at: minutesAgo(60 * 24 * 40),
    },
  ],
};

// The filler endpoints are active and delivering, so each holds a live secret.
// Generated rather than hand-written only because there are 56 of them; the
// point is that no active endpoint in the fixtures claims a secret it lacks.
for (const endpoint of fillerEndpoints) {
  endpointSecrets[endpoint.id] = [
    {
      id: `sec_${endpoint.id.slice(3)}`,
      endpoint_id: endpoint.id,
      version: 1,
      active: true,
      expires_at: null,
      rotated_at: null,
      created_at: endpoint.created_at,
    },
  ];
}

/**
 * `SubscriptionDto`.
 *
 * There is NO `endpoint_name`: a subscription carries `endpoint_id` and nothing
 * else identifying, so the screens that show a name join against the endpoint
 * list. The filter field is `payload_filter`, and the fan-out below deliberately
 * IGNORES it, because the data plane does: a subscription with a payload filter
 * currently behaves as if it had none. Materialising a filtered fan-out here
 * would show an operator deliveries the platform does not actually suppress.
 */
export const subscriptions: Subscription[] = [
  {
    id: 'sub_01JQFIN',
    project_id: PROD,
    endpoint_id: 'ep_01JQFINANCE',
    name: 'Finance — settlements',
    event_types: ['payment.settled', 'payment.refunded', 'payout.completed'],
    payload_filter: { data: { currency: 'GHS' } },
    enabled: true,
    created_at: minutesAgo(60 * 24 * 118),
    updated_at: minutesAgo(60 * 24 * 30),
  },
  {
    id: 'sub_01JQLED',
    project_id: PROD,
    endpoint_id: 'ep_01JQLEDGER',
    name: 'Ledger — all payment events',
    event_types: ['payment.settled', 'payment.failed', 'payment.refunded'],
    payload_filter: null,
    enabled: true,
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'sub_01JQPTR',
    project_id: PROD,
    endpoint_id: 'ep_01JQPARTNER',
    name: 'Partner — settled only',
    event_types: ['payment.settled'],
    payload_filter: null,
    enabled: true,
    created_at: minutesAgo(60 * 24 * 60),
    updated_at: minutesAgo(60 * 24 * 60),
  },
  {
    id: 'sub_01JQANL',
    project_id: PROD,
    endpoint_id: 'ep_01JQANALYTICS',
    name: 'Analytics — firehose',
    event_types: ['*'],
    payload_filter: null,
    // A disabled subscription matches no events at all, which is why the
    // analytics endpoint has no deliveries anywhere in the ledger.
    enabled: false,
    created_at: minutesAgo(60 * 24 * 12),
    updated_at: minutesAgo(60 * 30),
  },
];

/**
 * `ApiKeyDto`. `masked_key` does not exist — the wire field is `key_prefix`,
 * the first 12 characters. `status` is derived from the two timestamps at read
 * time, revoked outranking expired, exactly as the ingest path derives it.
 *
 * `effective_scopes` is the field that matters and the one a UI must read for
 * any authorization question: it is `scopes` intersected with what the ISSUER
 * may do right now. `key_01JQBACKFILL` was minted by someone since demoted to
 * viewer and reports fewer scopes than it holds; `key_01JQEXPIRED`'s issuer has
 * left the organization entirely, so it reports none at all while `scopes`
 * still lists what it was minted with. Both are the drift this pair exists to
 * expose, and a fixture where the two lists always matched would hide it.
 *
 * `created_by_user_id` and `created_by_membership_id` are now real ids, which
 * they could not be while the schema emitted them as untyped nullables. They
 * carry the same story the scope pair does: `key_01JQLIVE` was minted by the
 * owner who is still an owner; `key_01JQBACKFILL`'s issuer holds the same
 * membership but reads back as a viewer, because `created_by_role` is the
 * role AS IT IS NOW rather than at mint time; `key_01JQEXPIRED`'s issuer has
 * left, so the membership is null and the role with it — the going-null IS the
 * signal, and it is why `effective_scopes` is empty. `key_01JQOLD` predates the
 * column entirely, which is the other reason these are nullable at all.
 */
export const apiKeys: ApiKey[] = [
  {
    id: 'key_01JQLIVE',
    project_id: PROD,
    name: 'payment-gateway (production)',
    key_prefix: 'wk_live_a91f',
    environment: 'live',
    status: 'active',
    // An ingest key. The ingest path does not consult scopes at all, so an
    // empty list here is normal and not a misconfiguration.
    scopes: [],
    effective_scopes: [],
    created_by_user_id: user.id,
    created_by_membership_id: 'mem_01',
    created_by_role: 'owner',
    expires_at: null,
    last_used_at: minutesAgo(1),
    revoked_at: null,
    created_at: minutesAgo(60 * 24 * 118),
  },
  {
    id: 'key_01JQBACKFILL',
    project_id: PROD,
    name: 'backfill-runner',
    key_prefix: 'wk_live_33c2',
    environment: 'live',
    status: 'active',
    scopes: ['endpoints.read', 'deliveries.replay'],
    // Its issuer is a viewer now, and a viewer cannot replay. The key still
    // authenticates; the replay it was minted for would be refused.
    effective_scopes: ['endpoints.read'],
    created_by_user_id: 'usr_03',
    created_by_membership_id: 'mem_03',
    created_by_role: 'viewer',
    expires_at: minutesAhead(60 * 24 * 20),
    last_used_at: minutesAgo(60 * 26),
    revoked_at: null,
    created_at: minutesAgo(60 * 24 * 9),
  },
  {
    id: 'key_01JQEXPIRED',
    project_id: PROD,
    name: 'seasonal-importer',
    key_prefix: 'wk_live_c0de',
    environment: 'live',
    status: 'expired',
    scopes: ['events.publish'],
    // The issuer's membership is gone, so the derivation has nothing to
    // intersect with: this key may do nothing, whatever it was minted with.
    effective_scopes: [],
    // The USER id survives — it is the membership going null that says the
    // issuer has left, and it is what emptied `effective_scopes` above.
    created_by_user_id: 'usr_departed',
    created_by_membership_id: null,
    created_by_role: null,
    expires_at: minutesAgo(60 * 24 * 3),
    last_used_at: minutesAgo(60 * 24 * 4),
    revoked_at: null,
    created_at: minutesAgo(60 * 24 * 70),
  },
  {
    id: 'key_01JQOLD',
    project_id: PROD,
    name: 'legacy-gateway (rotated out)',
    key_prefix: 'wk_live_7b40',
    environment: 'live',
    status: 'revoked',
    scopes: [],
    effective_scopes: [],
    // Minted before the column existed. Null here means "unknown", not
    // "nobody" — the other reason all three of these are nullable.
    created_by_user_id: null,
    created_by_membership_id: null,
    created_by_role: null,
    expires_at: null,
    last_used_at: minutesAgo(60 * 24 * 31),
    revoked_at: minutesAgo(60 * 24 * 30),
    created_at: minutesAgo(60 * 24 * 110),
  },
];

/* ── Events and deliveries ────────────────────────────────────────────────── */

const EVENT_TYPES = [
  'payment.settled',
  'payment.failed',
  'payment.refunded',
  'payout.completed',
  'order.created',
] as const;

/**
 * The failure catalogue, in the shape an ATTEMPT actually records it.
 *
 * `http_status` is null for everything that never reached an HTTP server, and
 * those rows carry a `status` of `timeout` or `error` rather than `failure` —
 * the data plane's own verdict, and the first thing to look at in an incident.
 * `error_code` is the low-cardinality classification derived from the error
 * TYPE, never from its message.
 */
interface Failure {
  http_status: number | null;
  status: 'failure' | 'timeout' | 'error';
  error_code: string;
  error_message: string;
  body: string | null;
  /** Set instead of `body` when the response was too large to inline. */
  body_location?: string;
  /** Bytes the endpoint sent, before truncation. */
  size?: number;
}

const ERRORS: Failure[] = [
  {
    http_status: 504,
    status: 'failure',
    error_code: 'http_504',
    error_message: 'endpoint responded 504 Gateway Time-out',
    body: '<html><head><title>504 Gateway Time-out</title></head><body>',
  },
  {
    http_status: 500,
    status: 'failure',
    error_code: 'http_500',
    error_message: 'endpoint responded 500 Internal Server Error',
    body: '{"error":"internal server error","trace":"a1f2..."}',
  },
  {
    http_status: 429,
    status: 'failure',
    error_code: 'http_429',
    error_message: 'endpoint responded 429 Too Many Requests',
    body: '{"message":"too many requests","retry_after":30}',
  },
  {
    // A response too large to inline: the row carries a location and the count,
    // and the detail page has to say so rather than render an empty block.
    http_status: 502,
    status: 'failure',
    error_code: 'http_502',
    error_message: 'endpoint responded 502 Bad Gateway',
    body: null,
    body_location: 's3://shaq-webhooks-responses/2026/09/502-nginx-debug-page.html',
    size: 2_097_152,
  },
  {
    http_status: null,
    status: 'timeout',
    error_code: 'timeout',
    error_message: 'dial tcp 203.0.113.44:443: i/o timeout after 30000ms',
    body: null,
  },
  {
    http_status: null,
    status: 'error',
    error_code: 'dns',
    error_message: 'lookup api.partner-bank.example.com: no such host',
    body: null,
  },
  {
    http_status: null,
    status: 'error',
    error_code: 'transport',
    error_message: 'tls: handshake failure — remote error: bad certificate',
    body: null,
  },
  {
    http_status: 403,
    status: 'failure',
    error_code: 'http_403',
    error_message: 'endpoint responded 403 Forbidden (signature verification failed)',
    body: '{"error":"signature verification failed"}',
  },
];

/** Payloads above this are offloaded to object storage rather than stored inline. */
const INLINE_PAYLOAD_LIMIT = 262_144;
/** The event whose payload is big enough to be offloaded. */
const OFFLOADED_EVENT = 11;
/** The event whose raw bytes are past the retention window and simply gone. */
const AGED_OUT_EVENT = 29;
/** Ingested moments ago; the fan-out has not run, so it has no deliveries yet. */
const JUST_RECEIVED_EVENT = 47;
/** The fan-out itself failed. Also no deliveries — and NOT a delivery outcome. */
const FANOUT_FAILED_EVENT = 53;

/**
 * THE INCIDENT. Indices from here up are events accepted during a database
 * failover that outlasted the router's retry window, so every one of them is
 * PARKED: answered 202, never fanned out, no delivery rows. There are more of
 * them than one bulk requeue may return (`MAX_REQUEUE_BATCH`, 100), which is
 * the only way the `has_more` loop on the outbox page is reachable in the
 * mock — a loop that only ever runs once is a loop the UI never exercised.
 */
const INCIDENT_START = 64;
const INCIDENT_SIZE = 101;

function payloadFor(type: string, index: number): unknown {
  const base = {
    id: `evt_seq_${index}`,
    type,
    created_at: minutesAgo(index * 7),
    data: {
      transaction_id: `txn_${(1_000_000 + index).toString(36)}`,
      reference: `SHQ-${240_000 + index}`,
      amount: Number((between(500, 480_000) / 100).toFixed(2)),
      currency: 'GHS',
      channel: pick(['mobile_money', 'card', 'bank_transfer']),
      customer: {
        id: `cus_${(index * 977).toString(36)}`,
        msisdn: `+2335${between(10_000_000, 59_999_999)}`,
      },
      settled_at: minutesAgo(index * 7),
    },
  };

  // Two bulk payout runs, sized either side of the inline limit: one large
  // enough to exercise the scrollable viewer, one large enough to be offloaded
  // so the "this is not readable here" branch is reachable.
  const legs = index === 3 ? 420 : index === OFFLOADED_EVENT ? 2_400 : 0;
  if (legs > 0) {
    return {
      ...base,
      data: {
        ...base.data,
        batch: Array.from({ length: legs }, (_, leg) => ({
          leg_id: `leg_${leg.toString().padStart(4, '0')}`,
          rider_id: `rdr_${(leg * 31).toString(36)}`,
          amount: Number((between(1_000, 40_000) / 100).toFixed(2)),
          status: leg % 37 === 0 ? 'failed' : 'settled',
          note: 'Weekly rider payout run, region GA-Accra-Central',
        })),
      },
    };
  }
  return base;
}

/**
 * `EventPayloadDto` — an ENVELOPE, not the raw body.
 *
 * `body` is non-null only for `inline`. The other two cases are TOLD: an
 * offloaded payload keeps its jsonb copy, so the viewer still has something to
 * show alongside a warning that it is not the delivered bytes; an aged-out one
 * has neither, and the screen has to say so rather than render an empty block.
 */
function payloadEnvelope(
  index: number,
  payload: unknown,
  body: string,
  size: number,
  sha256: string,
): EventPayload {
  const normalised = payload as Record<string, unknown>;

  if (index === OFFLOADED_EVENT) {
    return {
      source: 'object_storage',
      body: null,
      encoding: null,
      location: `s3://shaq-webhooks-payloads/${PROD}/${index}.json`,
      size_bytes: size,
      sha256,
      normalised_json: normalised,
      notice:
        `This payload is ${size} bytes, above the ${INLINE_PAYLOAD_LIMIT}-byte inline limit, ` +
        'so the authoritative bytes live in object storage. It was delivered in full. The JSON ' +
        'below is the normalised copy, not what was signed.',
    };
  }

  if (index === AGED_OUT_EVENT) {
    return {
      source: 'unavailable',
      body: null,
      encoding: null,
      location: null,
      size_bytes: size,
      sha256,
      normalised_json: null,
      notice:
        'The raw bytes are past the payload retention window and have been dropped. The size and ' +
        'hash are kept, so this delivery can still be identified and its signature reasoned about.',
    };
  }

  return {
    source: 'inline',
    body,
    encoding: 'utf-8',
    location: null,
    size_bytes: size,
    sha256,
    normalised_json: normalised,
    notice:
      'The JSON shown is the stored jsonb copy. PostgreSQL normalises it, so key order and ' +
      'whitespace differ from the bytes that were signed — never verify a signature against it.',
  };
}

interface Fixture {
  event: EventDetail;
  deliveries: Delivery[];
  attempts: Record<string, DeliveryAttempt[]>;
}

/**
 * The INGEST state of an event, which is not a delivery outcome.
 *
 * The fixtures used to set `status: 'failed'` whenever one of an event's
 * deliveries was exhausted. `EventDto.status` is the fan-out state — `processed`
 * means the fan-out committed and says nothing about whether any endpoint
 * accepted anything — so that row could not occur, and it taught the events
 * list to report a healthy ingest as a failure. Failure here means the fan-out
 * itself failed, and such an event has no deliveries at all.
 */
function ingestStateFor(index: number): {
  status: EventStatus;
  processed: boolean;
  fansOut: boolean;
} {
  if (index === JUST_RECEIVED_EVENT) return { status: 'received', processed: false, fansOut: false };
  if (index === FANOUT_FAILED_EVENT) return { status: 'failed', processed: false, fansOut: false };
  if (index >= INCIDENT_START) return { status: 'failed', processed: false, fansOut: false };
  // Fan-out in flight: some rows are written, `processed_at` is not set yet.
  if (index === 2) return { status: 'processing', processed: false, fansOut: true };
  return { status: 'processed', processed: true, fansOut: true };
}

/**
 * The event types that are NOT left to the seeded RNG.
 *
 * `payment.settled` is the only type all three enabled subscriptions match, so
 * pinning it is what makes the interesting rows reachable at all: the fan-out
 * of one event across three endpoints (index 0), the two replays of an
 * exhausted partner delivery (6 and 13), and a healthy in-flight attempt on the
 * ledger (14). Leaving them to chance meant those rows silently vanished
 * whenever the RNG dealt a type nobody subscribes to.
 */
const FORCED_EVENT_TYPES: Record<number, string> = {
  0: 'payment.settled',
  6: 'payment.settled',
  13: 'payment.settled',
  14: 'payment.settled',
};

/**
 * Fan-out is materialised exactly as the platform does it: one event becomes
 * one delivery row per matching subscription, each with an independent retry
 * chain. That is what makes "did finance ever receive this?" answerable.
 */
function buildFixture(index: number): Fixture {
  const eventType = FORCED_EVENT_TYPES[index] ?? pick([...EVENT_TYPES]);
  const eventId = id('evt');
  const createdAt = minutesAgo(index * 7 + 2);
  const payload = payloadFor(eventType, index);
  const body = JSON.stringify(payload);
  const size = new TextEncoder().encode(body).length;
  const sha256 = digest();
  const orderingKey = index % 4 === 0 ? `customer_${index}` : null;
  const ingest = ingestStateFor(index);

  const matching = ingest.fansOut
    ? subscriptions.filter(
        (subscription) =>
          subscription.enabled &&
          (subscription.event_types.includes('*') ||
            subscription.event_types.includes(eventType)),
      )
    : [];

  const deliveries: Delivery[] = [];
  const attempts: Record<string, DeliveryAttempt[]> = {};

  const materialise = (
    endpointId: string,
    subscriptionId: string | null,
    status: DeliveryStatus,
    replayOf: string | null,
  ): Delivery => {
    const deliveryId = id('del');
    const maxAttempts = 8;
    const attemptCount = attemptCountFor(status, maxAttempts);
    const chain = buildAttempts(deliveryId, status, attemptCount, createdAt);
    const last = chain[chain.length - 1];
    const terminal =
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'exhausted' ||
      status === 'cancelled';
    const completedAt = terminal
      ? new Date(new Date(createdAt).getTime() + between(200, 900_000)).toISOString()
      : null;

    /*
     * A crashed worker, kept on purpose: a row stuck in `processing` whose
     * `locked_until` is in the PAST is exactly what the scheduler reclaims, and
     * a fixture with only healthy locks never shows an operator that state.
     */
    const crashed = status === 'processing' && index === 0;

    const delivery: Delivery = {
      id: deliveryId,
      event_id: eventId,
      endpoint_id: endpointId,
      // These fixtures are all inside the retention window, so their attempts
      // are still on the ledger. See DeliveryDto.attempts_pruned_at.
      attempts_pruned_at: null,
      subscription_id: subscriptionId,
      project_id: PROD,
      status,
      terminal,
      attempt_count: attemptCount,
      max_attempts: maxAttempts,
      next_attempt_at:
        status === 'retrying' || status === 'scheduled' ? minutesAhead(between(1, 24)) : null,
      last_attempt_at: last?.started_at ?? null,
      completed_at: completedAt,
      // Carried from the event onto every delivery it fanned out to. Ordering
      // is NOT enforced yet, so this promises nothing about delivery order.
      ordering_key: orderingKey,
      // The status code is NOT here. `last_error` is all a list row carries;
      // the code exists only on an attempt, as `http_status`.
      last_error: last?.error_message ?? null,
      locked_by: status === 'processing' ? `worker-${between(1, 6)}` : null,
      locked_until:
        status === 'processing' ? (crashed ? minutesAgo(4) : minutesAhead(2)) : null,
      replay_of_delivery_id: replayOf,
      replayed_by: replayOf ? user.id : null,
      is_replay: replayOf !== null,
      created_at: createdAt,
      updated_at: completedAt ?? last?.started_at ?? createdAt,
    };

    deliveries.push(delivery);
    attempts[deliveryId] = chain;
    return delivery;
  };

  for (const subscription of matching) {
    const endpoint = endpoints.find((candidate) => candidate.id === subscription.endpoint_id);
    if (!endpoint) continue;

    const original = materialise(
      endpoint.id,
      subscription.id,
      statusFor(endpoint.id, index),
      null,
    );

    /*
     * REPLAYS ARE REAL DELIVERY ROWS. Both stay in the ledger — the exhausted
     * original is not rewritten — so an event can show two rows against one
     * endpoint, which is the only way "we tried again, and here is what
     * happened the second time" is answerable.
     */
    if (endpoint.id === 'ep_01JQPARTNER' && original.status === 'exhausted') {
      // index 6: replayed after the partner came back. index 13: replayed into
      // an endpoint that was still broken, and exhausted a second time.
      if (index === 6) materialise(endpoint.id, subscription.id, 'succeeded', original.id);
      if (index === 13) materialise(endpoint.id, subscription.id, 'exhausted', original.id);
    }
  }

  return {
    event: {
      id: eventId,
      project_id: PROD,
      event_type: eventType,
      idempotency_key: index % 3 === 0 ? `txn_${index}_settled_v1` : null,
      ordering_key: orderingKey,
      status: ingest.status,
      payload_size: size,
      payload_hash: sha256,
      payload_inline: index !== OFFLOADED_EVENT && index !== AGED_OUT_EVENT,
      payload_location:
        index === OFFLOADED_EVENT ? `s3://shaq-webhooks-payloads/${PROD}/${index}.json` : null,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'shaq-payment-gateway/2.4.1',
        // Credential-shaped values arrive already redacted; the KEY stays, so
        // "did the producer authenticate?" is still answerable.
        authorization: '[redacted]',
        'idempotency-key': index % 3 === 0 ? `txn_${index}_settled_v1` : '',
      },
      created_at: createdAt,
      processed_at: ingest.processed
        ? new Date(new Date(createdAt).getTime() + between(40, 900)).toISOString()
        : null,
      payload: payloadEnvelope(index, payload, body, size, sha256),
    },
    deliveries,
    attempts,
  };
}

function statusFor(endpointId: string, index: number): DeliveryStatus {
  // The partner endpoint is the one that is genuinely broken; the others are
  // mostly healthy with a realistic tail.
  if (endpointId === 'ep_01JQPARTNER') {
    if (index < 2) return 'retrying';
    return index % 5 === 0 ? 'cancelled' : 'exhausted';
  }
  if (endpointId === 'ep_01JQLEDGER') {
    // index 0 is the crashed-worker row; index 14 is a healthy in-flight one.
    if (index === 0 || index === 14) return 'processing';
    if (index % 11 === 0) return 'exhausted';
    if (index % 7 === 0) return 'retrying';
    if (index % 13 === 0) return 'failed';
    return 'succeeded';
  }
  if (index === 1) return 'queued';
  if (index % 17 === 0) return 'retrying';
  return 'succeeded';
}

function attemptCountFor(status: DeliveryStatus, maxAttempts: number): number {
  switch (status) {
    case 'exhausted':
      return maxAttempts;
    case 'retrying':
      return between(2, maxAttempts - 1);
    case 'failed':
      return 1;
    case 'succeeded':
      return random() < 0.85 ? 1 : between(2, 3);
    case 'processing':
      return 1;
    default:
      return 0;
  }
}

/**
 * `DeliveryAttemptDto` rows — append-only, ascending by `attempt_number`.
 *
 * The last attempt of a `processing` delivery is STILL IN FLIGHT: no
 * `completed_at`, no `duration_ms`, no status code and no error. Nothing in the
 * enum means "in flight" — `error` is the closest, since it is defined as "we
 * never got an answer" — but the nullable `duration_ms` is what the detail page
 * reads to say so, and a fixture without one leaves that branch unrendered.
 */
function buildAttempts(
  deliveryId: string,
  status: DeliveryStatus,
  count: number,
  createdAt: string,
): DeliveryAttempt[] {
  const chain: DeliveryAttempt[] = [];
  const start = new Date(createdAt).getTime();

  for (let n = 1; n <= count; n += 1) {
    const isLast = n === count;
    const succeeded = isLast && status === 'succeeded';
    const inFlight = isLast && status === 'processing';
    const failure = ERRORS[(n + count) % ERRORS.length];
    // Exponential backoff with jitter, as the retry engine schedules it.
    const offset = Math.round(2 ** n * 30_000 * (0.8 + random() * 0.4));
    const startedAt = new Date(start + offset);
    const duration = succeeded
      ? between(40, 320)
      : failure.http_status !== null
        ? between(180, 4_800)
        : 30_000;
    const responseBody = succeeded ? '{"received":true}' : failure.body;

    chain.push({
      id: id('att'),
      delivery_id: deliveryId,
      attempt_number: n,
      status: succeeded ? 'success' : inFlight ? 'error' : failure.status,
      http_status: succeeded ? 200 : inFlight ? null : failure.http_status,
      started_at: startedAt.toISOString(),
      completed_at: inFlight ? null : new Date(startedAt.getTime() + duration).toISOString(),
      duration_ms: inFlight ? null : duration,
      /*
       * The data plane records a trace id only when the attempt's span was
       * SAMPLED - NULL honestly means "no trace was kept". Head sampling is a
       * few percent; retries are sampled in unconditionally because they exist
       * because something went wrong. An in-flight attempt has no id yet.
       */
      trace_id: !inFlight && (n > 1 || random() < 0.05) ? traceId() : null,
      /*
       * What we sent. Credential-shaped VALUES are redacted and the keys kept.
       * The signature is NOT redacted: it is an HMAC over the payload, not the
       * key, and it is the one thing a consumer can compare against when
       * verification fails.
       */
      request_headers: {
        'content-type': 'application/json',
        'user-agent': 'hookubit-worker/0.4.2',
        'webhook-id': deliveryId,
        'webhook-timestamp': Math.floor(startedAt.getTime() / 1000).toString(),
        'webhook-signature': `v1=${digest().slice(0, 44)}`,
        authorization: '[redacted]',
      },
      response_headers:
        succeeded || inFlight
          ? succeeded
            ? { 'content-type': 'application/json', 'x-request-id': id('rq').toLowerCase() }
            : null
          : failure.http_status !== null
            ? { 'content-type': failure.http_status === 429 ? 'application/json' : 'text/html' }
            : null,
      response_body: inFlight ? null : responseBody,
      response_body_location: succeeded || inFlight ? null : (failure.body_location ?? null),
      response_size: inFlight
        ? null
        : succeeded
          ? 17
          : (failure.size ?? (failure.body ? failure.body.length : null)),
      error_code: succeeded || inFlight ? null : failure.error_code,
      error_message: succeeded || inFlight ? null : failure.error_message,
      worker_id: `worker-${((n + count) % 6) + 1}`,
      created_at: startedAt.toISOString(),
    });
  }
  return chain;
}

const fixtures: Fixture[] = Array.from({ length: INCIDENT_START + INCIDENT_SIZE }, (_, index) =>
  buildFixture(index),
);

export const events: EventDetail[] = fixtures.map((fixture) => fixture.event);
export const deliveries: Delivery[] = fixtures.flatMap((fixture) => fixture.deliveries);
export const attempts: Record<string, DeliveryAttempt[]> = Object.assign(
  {},
  ...fixtures.map((fixture) => fixture.attempts),
);

/* ── Outbox ───────────────────────────────────────────────────────────────── */

/**
 * ONE OUTBOX ROW PER EVENT, exactly as the platform writes it: the event and
 * its outbox row commit together at ingest, and the row's status tracks what
 * the router has done with it since. `OutboxEntryDto` field for field —
 * nothing here is derived, which is what the controller promises too.
 *
 * The parked rows are the point, and they are built to be told apart:
 *
 *   - `FANOUT_FAILED_EVENT` parked HALFWAY through a fan-out — 11 of 14 claims
 *     left nothing recorded and `fan_out_cursor` points at the subscription
 *     the last committed batch stopped at.
 *   - The first two incident rows are POISON: every claim ended with the router
 *     writing nothing at all, which is what an event that kills the process
 *     looks like. Requeueing one unchanged will park it again.
 *   - The rest of the incident is `retry_duration_exceeded`: 0 unaccounted out
 *     of dozens of claims, every failure recorded, failing for longer than the
 *     hour. That is a database outage, not a bad event, and a requeue recovers
 *     it.
 *
 * `last_error` is written the way the router writes it — `"<reason>: <detail>"`
 * (`internal/router/router.go`, `park`) — because the outbox page reads the
 * reason back off that prefix and the mock must not be kinder than the wire.
 */
const ROUTER_MAX_OUTBOX_ATTEMPTS = 10;

function outboxRowFor(event: EventDetail, index: number): OutboxEntry {
  const base: OutboxEntry = {
    id: id('obx'),
    event_id: event.id,
    type: 'event.created',
    status: 'processed',
    attempts: 1,
    unaccounted_attempts: 0,
    last_error: null,
    failing_since: null,
    fan_out_cursor: null,
    available_at: event.created_at,
    locked_by: null,
    locked_until: null,
    processed_at: event.processed_at,
    created_at: event.created_at,
  };

  const acceptedAt = new Date(event.created_at).getTime();
  const after = (minutes: number) => new Date(acceptedAt + minutes * 60_000).toISOString();

  if (index === JUST_RECEIVED_EVENT) {
    return { ...base, status: 'pending', attempts: 0, processed_at: null };
  }

  if (index === 2) {
    // Mid-fan-out, healthy: a router holds the lease and has committed one
    // batch. `processing` with a cursor is NORMAL for a wide event.
    return {
      ...base,
      status: 'processing',
      attempts: 1,
      unaccounted_attempts: 1,
      fan_out_cursor: subscriptions[0].id,
      locked_by: 'router-2',
      locked_until: minutesAhead(1),
      processed_at: null,
    };
  }

  if (index === FANOUT_FAILED_EVENT) {
    return {
      ...base,
      status: 'failed',
      attempts: 14,
      unaccounted_attempts: 11,
      fan_out_cursor: subscriptions[1].id,
      last_error: `attempts_exhausted: claimed 14 times (11 of them leaving no recorded outcome, bound ${ROUTER_MAX_OUTBOX_ATTEMPTS})`,
      available_at: after(31),
      processed_at: after(31),
    };
  }

  if (index >= INCIDENT_START) {
    const offset = index - INCIDENT_START;
    if (offset < 2) {
      return {
        ...base,
        status: 'failed',
        attempts: 11,
        unaccounted_attempts: 11,
        last_error: `attempts_exhausted: claimed 11 times (11 of them leaving no recorded outcome, bound ${ROUTER_MAX_OUTBOX_ATTEMPTS})`,
        available_at: after(18),
        processed_at: after(18),
      };
    }
    const failingSince = after(1);
    const parkedAt = after(63);
    return {
      ...base,
      status: 'failed',
      attempts: 40 + (offset % 23),
      unaccounted_attempts: 0,
      failing_since: failingSince,
      last_error: `retry_duration_exceeded: failing since ${failingSince.replace(/\.\d{3}Z$/, 'Z')} (1h2m0s, bound 1h0m0s)`,
      available_at: parkedAt,
      processed_at: parkedAt,
    };
  }

  return base;
}

export const outbox: OutboxEntry[] = events.map((event, index) => outboxRowFor(event, index));

/**
 * `AuditLogDto`.
 *
 * There is no nested `actor`, no `target` and no `ip`. The actor is `user_id`
 * OR `api_key_id`, either of which may be null — a platform action such as the
 * circuit breaker firing has NEITHER, and that row is the whole reason the page
 * has to render an actor-less entry. The subject is `resource_type` +
 * `resource_id`, and only ids come back: showing "who" needs a second lookup,
 * which is why these rows carry no email.
 */
export const auditLogs: AuditLogEntry[] = [
  {
    id: 'aud_01',
    organization_id: 'org_01JQSHAQ',
    // The breaker is the platform acting on its own. No user, no key.
    user_id: null,
    api_key_id: null,
    action: 'endpoint.auto_disabled',
    resource_type: 'endpoint',
    resource_id: 'ep_01JQPARTNER',
    metadata: { consecutive_failures: 20, breaker: 'open', endpoint_name: 'partner-reconciliation' },
    ip_address: null,
    user_agent: null,
    created_at: minutesAgo(158),
  },
  {
    id: 'aud_02',
    organization_id: 'org_01JQSHAQ',
    user_id: user.id,
    api_key_id: null,
    // `endpoint.disabled` is what the disable route writes; "paused" is the
    // word the UI shows, not the action the ledger records.
    action: 'endpoint.disabled',
    resource_type: 'endpoint',
    resource_id: 'ep_01JQANALYTICS',
    // The reason an operator typed is the only thing that explains the delivery
    // gap afterwards, so it has to survive into the row and be readable back.
    metadata: { reason: 'warehouse migration', endpoint_name: 'analytics-sink' },
    ip_address: '41.66.12.9',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    created_at: minutesAgo(640),
  },
  {
    id: 'aud_03',
    organization_id: 'org_01JQSHAQ',
    user_id: user.id,
    api_key_id: null,
    action: 'endpoint.secret_rotated',
    resource_type: 'endpoint',
    resource_id: 'ep_01JQFINANCE',
    metadata: { overlap_hours: 24, version: 2, endpoint_name: 'finance-api' },
    ip_address: '41.66.12.9',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    created_at: minutesAgo(60 * 26),
  },
  {
    id: 'aud_04',
    organization_id: 'org_01JQSHAQ',
    /*
     * An API-key actor. `api_key_id` exists on the row and reads back null on
     * every path today — no writer sets it yet — so this models the column as
     * it will be, with `user_id` carrying the human who holds the key. The
     * metadata says which key it was.
     */
    user_id: user.id,
    api_key_id: null,
    action: 'delivery.replayed',
    resource_type: 'delivery',
    resource_id: null,
    metadata: { count: 412, endpoint: 'ledger-service', api_key: 'key_01JQBACKFILL' },
    ip_address: '10.4.2.18',
    user_agent: 'backfill-runner/1.2.0',
    created_at: minutesAgo(60 * 30),
  },
  {
    id: 'aud_05',
    organization_id: 'org_01JQSHAQ',
    user_id: user.id,
    api_key_id: null,
    action: 'member.invited',
    resource_type: 'member',
    // An invitation creates no member row, so there is no id to point at: the
    // address it was sent to lives in the metadata instead.
    resource_id: null,
    metadata: { role: 'developer', email: 'kofi@shaqexpress.com' },
    ip_address: '41.66.12.9',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    created_at: minutesAgo(60 * 24 * 3),
  },
];
