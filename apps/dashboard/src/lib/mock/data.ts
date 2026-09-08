/**
 * Deterministic mock dataset for the control API.
 *
 * Seeded, so the dashboard looks identical on every reload and a screenshot in
 * a bug report is reproducible. The shape of the data matters more than the
 * volume: it deliberately contains the states that are hard to render well —
 * an endpoint with an open circuit breaker, deliveries exhausted after eight
 * attempts, a payload well past the inline display limit, DNS failures with no
 * status code at all — because those are the cases a demo dataset of happy
 * paths lets you ship broken.
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
  Member,
  Organization,
  Project,
  ProjectAnalytics,
  Subscription,
  UsageSummary,
  User,
} from '../../types/api';
import { summarizeDeliveries } from '../delivery-status';

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
const minutesAhead = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

let counter = 0;
const id = (prefix: string) =>
  `${prefix}_01JQ${(counter++).toString(36).padStart(4, '0').toUpperCase()}${Math.floor(random() * 1e9)
    .toString(36)
    .toUpperCase()
    .padStart(6, 'X')}`;

/* ── Identity ─────────────────────────────────────────────────────────────── */

export const user: User = {
  id: 'usr_01JQOPERATOR',
  email: 'najib@shaqexpress.com',
  name: 'Najib Alhassan',
  email_verified_at: minutesAgo(60 * 24 * 90),
  created_at: minutesAgo(60 * 24 * 120),
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
  ],
};

/**
 * `environment` is `test | live` — there is no `production`, `staging` or
 * `development` on the wire. `status` carries the soft delete.
 */
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

/* ── Endpoints ────────────────────────────────────────────────────────────── */

/**
 * `EndpointDto`, field for field. There is no `circuit_state`, no
 * `rate_limit_per_second` and no `success_rate_24h` on the wire — the breaker
 * reports through `status`/`disabled_reason`/`disabled_at`, and the token
 * bucket is `rate_limit` per `rate_limit_window_seconds`.
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
    created_at: minutesAgo(60 * 24 * 90),
    updated_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'ep_01JQPARTNER',
    project_id: PROD,
    // The problem endpoint: 30s timeouts, auto-disabled by the breaker.
    name: 'partner-reconciliation',
    url: 'https://api.partner-bank.example.com/inbound/shaq',
    description: 'Partner bank reconciliation feed.',
    status: 'disabled',
    enabled: true,
    disabled_reason:
      'Circuit breaker opened after 20 consecutive failures (connect timeout).',
    disabled_at: minutesAgo(158),
    timeout_ms: 30_000,
    max_concurrency: 4,
    rate_limit: 5,
    rate_limit_window_seconds: 1,
    retry_policy_id: null,
    custom_headers: null,
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
    retry_policy_id: null,
    custom_headers: null,
    created_at: minutesAgo(60 * 24 * 12),
    updated_at: minutesAgo(60 * 30),
  },
  {
    id: 'ep_01JQPENDING',
    project_id: PROD,
    // Created by a developer, who may not receive a signing secret. It is
    // PAUSED and has no live secret: it will not deliver until an owner or
    // admin rotates one and enables it.
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
    created_at: minutesAgo(90),
    updated_at: minutesAgo(90),
  },
  {
    id: 'ep_01JQREMOVED',
    project_id: PROD,
    // Soft-deleted. Hidden unless `?include_deleted=true`; kept forever so the
    // delivery ledger stays readable.
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
  created_at: minutesAgo(60 * 24 * (5 + index)),
  updated_at: minutesAgo(60 * 24 * (5 + index)),
}));

export const endpoints: Endpoint[] = [...namedEndpoints, ...fillerEndpoints];

/**
 * Secret METADATA per endpoint. No plaintext lives here and there is no field
 * it could occupy — a plaintext secret exists only in a create or rotate
 * response, once.
 *
 * `ep_01JQPENDING` is absent from this map on purpose: that is the endpoint
 * with no live secret, which is why it is paused.
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

export const subscriptions: Subscription[] = [
  {
    id: 'sub_01JQFIN',
    project_id: PROD,
    endpoint_id: 'ep_01JQFINANCE',
    endpoint_name: 'finance-api',
    name: 'Finance — settlements',
    event_types: ['payment.settled', 'payment.refunded', 'payout.completed'],
    filter: { data: { currency: 'GHS' } },
    enabled: true,
    created_at: minutesAgo(60 * 24 * 118),
  },
  {
    id: 'sub_01JQLED',
    project_id: PROD,
    endpoint_id: 'ep_01JQLEDGER',
    endpoint_name: 'ledger-service',
    name: 'Ledger — all payment events',
    event_types: ['payment.settled', 'payment.failed', 'payment.refunded'],
    filter: null,
    enabled: true,
    created_at: minutesAgo(60 * 24 * 90),
  },
  {
    id: 'sub_01JQPTR',
    project_id: PROD,
    endpoint_id: 'ep_01JQPARTNER',
    endpoint_name: 'partner-reconciliation',
    name: 'Partner — settled only',
    event_types: ['payment.settled'],
    filter: null,
    enabled: true,
    created_at: minutesAgo(60 * 24 * 60),
  },
  {
    id: 'sub_01JQANL',
    project_id: PROD,
    endpoint_id: 'ep_01JQANALYTICS',
    endpoint_name: 'analytics-sink',
    name: 'Analytics — firehose',
    event_types: ['*'],
    filter: null,
    enabled: false,
    created_at: minutesAgo(60 * 24 * 12),
  },
];

/**
 * `ApiKeyDto`. `masked_key` does not exist — the wire field is `key_prefix`,
 * the first 12 characters. `status` is derived from the two timestamps at read
 * time, revoked outranking expired, exactly as the ingest path derives it.
 */
export const apiKeys: ApiKey[] = [
  {
    id: 'key_01JQLIVE',
    project_id: PROD,
    name: 'payment-gateway (production)',
    key_prefix: 'wk_live_a91f',
    environment: 'live',
    status: 'active',
    scopes: [],
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
    scopes: ['endpoints.read'],
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
    scopes: [],
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

const ERRORS = [
  { code: 504, error: null, body: '<html><head><title>504 Gateway Time-out</title></head><body>' },
  { code: 500, error: null, body: '{"error":"internal server error","trace":"a1f2..."}' },
  { code: 429, error: null, body: '{"message":"too many requests","retry_after":30}' },
  { code: 502, error: null, body: '<html>502 Bad Gateway — nginx/1.24.0</html>' },
  { code: null, error: 'dial tcp 203.0.113.44:443: i/o timeout after 30000ms', body: null },
  { code: null, error: 'lookup api.partner-bank.example.com: no such host', body: null },
  { code: null, error: 'tls: handshake failure — remote error: bad certificate', body: null },
  { code: 403, error: null, body: '{"error":"signature verification failed"}' },
];

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

  // One deliberately large payload — a bulk payout with hundreds of legs —
  // so the payload viewer is exercised against something real.
  if (index === 3) {
    return {
      ...base,
      data: {
        ...base.data,
        batch: Array.from({ length: 420 }, (_, leg) => ({
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

interface Fixture {
  event: EventDetail;
  deliveries: Delivery[];
  attempts: Record<string, DeliveryAttempt[]>;
}

/**
 * Fan-out is materialised exactly as the platform does it: one event becomes
 * one delivery row per matching subscription, each with an independent retry
 * chain. That is what makes "did finance ever receive this?" answerable.
 */
function buildFixture(index: number): Fixture {
  const eventType = index === 0 ? 'payment.settled' : pick([...EVENT_TYPES]);
  const eventId = id('evt');
  const createdAt = minutesAgo(index * 7 + 2);
  const payload = payloadFor(eventType, index);

  const matching = subscriptions.filter(
    (subscription) =>
      subscription.enabled &&
      (subscription.event_types.includes('*') || subscription.event_types.includes(eventType)),
  );

  const deliveries: Delivery[] = [];
  const attempts: Record<string, DeliveryAttempt[]> = {};

  for (const subscription of matching) {
    const endpoint = endpoints.find((candidate) => candidate.id === subscription.endpoint_id);
    if (!endpoint) continue;

    const status = statusFor(endpoint.id, index);
    const deliveryId = id('del');
    const maxAttempts = 8;
    const attemptCount = attemptCountFor(status, maxAttempts);
    const chain = buildAttempts(deliveryId, status, attemptCount, createdAt);
    const last = chain[chain.length - 1];

    deliveries.push({
      id: deliveryId,
      project_id: PROD,
      event_id: eventId,
      event_type: eventType,
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.name,
      endpoint_url: endpoint.url,
      status,
      terminal: status === 'succeeded' || status === 'failed' || status === 'exhausted' || status === 'cancelled',
      attempt_count: attemptCount,
      max_attempts: maxAttempts,
      last_status_code: last?.status_code ?? null,
      last_error: last?.error ?? null,
      next_attempt_at:
        status === 'retrying' || status === 'scheduled' ? minutesAhead(between(1, 24)) : null,
      created_at: createdAt,
      completed_at:
        status === 'succeeded' || status === 'exhausted' || status === 'cancelled'
          ? new Date(new Date(createdAt).getTime() + between(200, 900_000)).toISOString()
          : null,
    });
    attempts[deliveryId] = chain;
  }

  return {
    event: {
      id: eventId,
      project_id: PROD,
      event_type: eventType,
      status: deliveries.some((delivery) => delivery.status === 'exhausted')
        ? 'failed'
        : deliveries.every((delivery) => delivery.status === 'succeeded')
          ? 'processed'
          : 'processing',
      ordering_key: index % 4 === 0 ? `customer_${index}` : null,
      idempotency_key: index % 3 === 0 ? `txn_${index}_settled_v1` : null,
      payload_size_bytes: new TextEncoder().encode(JSON.stringify(payload)).length,
      delivery_counts: summarizeDeliveries(deliveries),
      created_at: createdAt,
      payload,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'shaq-payment-gateway/2.4.1',
        'idempotency-key': index % 3 === 0 ? `txn_${index}_settled_v1` : '',
      },
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
    if (index === 0) return 'processing';
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
    const failure = ERRORS[(n + count) % ERRORS.length];
    // Exponential backoff with jitter, as the retry engine schedules it.
    const offset = Math.round(2 ** n * 30_000 * (0.8 + random() * 0.4));

    chain.push({
      id: id('att'),
      delivery_id: deliveryId,
      attempt_number: n,
      status_code: succeeded ? 200 : status === 'processing' && isLast ? null : failure.code,
      duration_ms: succeeded ? between(40, 320) : failure.code ? between(180, 4_800) : 30_000,
      error: succeeded ? null : status === 'processing' && isLast ? null : failure.error,
      response_headers: succeeded
        ? { 'content-type': 'application/json', 'x-request-id': id('rq').toLowerCase() }
        : failure.code
          ? { 'content-type': failure.code === 429 ? 'application/json' : 'text/html' }
          : null,
      response_body: succeeded ? '{"received":true}' : failure.body,
      response_truncated: false,
      attempted_at: new Date(start + offset).toISOString(),
    });
  }
  return chain;
}

const fixtures: Fixture[] = Array.from({ length: 64 }, (_, index) => buildFixture(index));

export const events: EventDetail[] = fixtures.map((fixture) => fixture.event);
export const deliveries: Delivery[] = fixtures.flatMap((fixture) => fixture.deliveries);
export const attempts: Record<string, DeliveryAttempt[]> = Object.assign(
  {},
  ...fixtures.map((fixture) => fixture.attempts),
);

/* ── Aggregates ───────────────────────────────────────────────────────────── */

export const analytics: ProjectAnalytics = (() => {
  const points = Array.from({ length: 24 }, (_, hour) => {
    const succeeded = between(1_800, 3_400);
    return {
      bucket: minutesAgo((23 - hour) * 60),
      succeeded,
      failed: between(20, 240),
      retrying: between(0, 90),
      p95_latency_ms: between(120, 780),
    };
  });
  const totals = points.reduce(
    (accumulator, point) => ({
      total: accumulator.total + point.succeeded + point.failed,
      succeeded: accumulator.succeeded + point.succeeded,
      failed: accumulator.failed + point.failed,
      pending: accumulator.pending + point.retrying,
      exhausted: accumulator.exhausted + Math.round(point.failed * 0.18),
    }),
    { total: 0, succeeded: 0, failed: 0, pending: 0, exhausted: 0 },
  );
  return {
    window: '24h' as const,
    points,
    totals,
    p95_latency_ms: 412,
    success_rate: totals.succeeded / totals.total,
  };
})();

const periodStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const periodEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 0, 23, 59, 59));

/**
 * Analytics for one project.
 *
 * A project with no deliveries reports zeroes rather than borrowing the busy
 * project's numbers. That matters more than it sounds: the overview for a
 * brand-new project is the screen the first-run experience has to render, and
 * a fabricated 95% success rate on a project that has never received an event
 * hides the very state the guided setup exists to resolve.
 */
export function analyticsFor(projectId: string): ProjectAnalytics {
  if (projectId === PROD) return analytics;
  return {
    window: '24h',
    points: Array.from({ length: 24 }, (_, hour) => ({
      bucket: minutesAgo((23 - hour) * 60),
      succeeded: 0,
      failed: 0,
      retrying: 0,
      p95_latency_ms: 0,
    })),
    totals: { total: 0, succeeded: 0, failed: 0, pending: 0, exhausted: 0 },
    p95_latency_ms: 0,
    success_rate: 0,
  };
}

export const usage: UsageSummary = {
  period_start: periodStart.toISOString(),
  period_end: periodEnd.toISOString(),
  events_ingested: 1_284_930,
  deliveries_attempted: 3_402_118,
  included_events: 1_000_000,
  overage_events: 284_930,
};

export const auditLogs: AuditLogEntry[] = [
  {
    id: 'aud_01',
    actor: { id: 'sys', email: 'system', type: 'system' },
    action: 'endpoint.auto_disabled',
    target: 'ep_01JQPARTNER (partner-reconciliation)',
    ip: null,
    metadata: { consecutive_failures: 20, breaker: 'open' },
    created_at: minutesAgo(158),
  },
  {
    id: 'aud_02',
    actor: { id: user.id, email: user.email, type: 'user' },
    action: 'endpoint.paused',
    target: 'ep_01JQANALYTICS (analytics-sink)',
    ip: '41.66.12.9',
    metadata: { reason: 'warehouse migration' },
    created_at: minutesAgo(640),
  },
  {
    id: 'aud_03',
    actor: { id: user.id, email: user.email, type: 'user' },
    action: 'endpoint.secret_rotated',
    target: 'ep_01JQFINANCE (finance-api)',
    ip: '41.66.12.9',
    metadata: { overlap_hours: 24 },
    created_at: minutesAgo(60 * 26),
  },
  {
    id: 'aud_04',
    actor: { id: 'key_01JQBACKFILL', email: 'backfill-runner', type: 'api_key' },
    action: 'delivery.replayed',
    target: '412 deliveries',
    ip: '10.4.2.18',
    metadata: { endpoint: 'ledger-service' },
    created_at: minutesAgo(60 * 30),
  },
  {
    id: 'aud_05',
    actor: { id: user.id, email: user.email, type: 'user' },
    action: 'member.invited',
    target: 'kofi@shaqexpress.com',
    ip: '41.66.12.9',
    metadata: { role: 'developer' },
    created_at: minutesAgo(60 * 24 * 3),
  },
];
