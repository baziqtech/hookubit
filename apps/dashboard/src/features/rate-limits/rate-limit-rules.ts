import type { ApiKey, Endpoint, RateLimit, RateLimitScope } from '../../types/api';

/**
 * The rate-limit rules the form and the table need, as pure data.
 *
 * Two things live here, and the second is the one that earns the file:
 *
 *   1. The cross-field rule from control-api `src/rate-limits/rate-limit-rules.ts`
 *      (`burst >= limit`), in the server's words, so the form can put the
 *      reason under the input before the round trip.
 *   2. WHICH SCOPES THE DATA PLANE ACTUALLY ENFORCES. A table of ceilings that
 *      nothing reads is worse than no table — an operator sees a row, believes
 *      a limit is in force, and stops looking for why a partner is being
 *      flooded — so every row carries a verdict, and the verdict is read from
 *      the Go code rather than from the DTO's description of intent.
 */
export interface RateLimitSettings {
  limit: number;
  window_seconds: number;
  burst: number | null;
}

export interface RateLimitCoherenceIssue {
  field: 'burst';
  reason: string;
}

/** Mirrors `assertRateLimitSettings`' one cross-field rule. Bounds are per-field. */
export function rateLimitCoherenceIssues(settings: RateLimitSettings): RateLimitCoherenceIssue[] {
  if (settings.burst !== null && settings.burst < settings.limit) {
    return [
      {
        field: 'burst',
        reason:
          `burst (${settings.burst}) must be at least limit (${settings.limit}): the bucket ` +
          'would never hold one window’s worth of tokens, so the configured limit could never ' +
          'actually be reached.',
      },
    ];
  }
  return [];
}

/**
 * Where each scope is enforced TODAY, verified in the data plane rather than
 * inferred from the DTO — `CreateRateLimitDto` describes `project` and
 * `organization` as bounding OUTBOUND delivery, and the code does not do that.
 *
 * Ingest path — `services/data-plane/internal/ingest/handler.go:242` calls
 * the policy limiter; `cmd/webhookd/ratelimit.go:26` routes it to
 * `ratelimit.Limiter.AllowIngest`; `internal/ratelimit/policy.go:139-154`
 * (`ResolveIngest`) charges the `ingest` row (line 142), then the `project`
 * row (148), then the `organization` row (151). So all three scopes ARE in
 * force when an event is accepted.
 *
 * Delivery path — `internal/worker/deliver.go:173-175` charges ONLY
 * `job.Endpoint.RateLimit`, which `internal/worker/store.go:239` loads from
 * `endpoints.rate_limit`; no policy row is read. `internal/ratelimit/limiter.go:121-128`
 * says so in as many words ("the delivery path in internal/worker does NOT go
 * through here"), `policy.go:161` marks `ResolveDelivery` "Nothing wires this
 * yet", and `cmd/webhookd/roles.go:398` builds the delivery limiter with "No
 * policy Source". So `endpoint`-scope rows are stored and never read, and
 * `project`/`organization` rows bound ingestion, not delivery.
 */
export interface ScopeEnforcement {
  /** Charged when an event is accepted by the ingest API. */
  ingest: boolean;
  /** Charged when a delivery is attempted by the workers. */
  delivery: boolean;
}

export const RATE_LIMIT_ENFORCEMENT: Record<RateLimitScope, ScopeEnforcement> = {
  ingest: { ingest: true, delivery: false },
  project: { ingest: true, delivery: false },
  organization: { ingest: true, delivery: false },
  endpoint: { ingest: false, delivery: false },
};

export type EnforcementVerdict =
  | { kind: 'enforced'; label: 'Enforced on ingest' }
  | { kind: 'partial'; label: 'Ingest only' }
  | { kind: 'inert'; label: 'Not enforced' };

/**
 * The badge for a row. `ingest`-scope policies only ever meant ingest, so
 * they are fully in force; `project`/`organization` were described as
 * delivery ceilings and are charged on ingest instead, which is "partial";
 * `endpoint` rows are read by nothing.
 */
export function enforcementVerdict(scope: RateLimitScope): EnforcementVerdict {
  const where = RATE_LIMIT_ENFORCEMENT[scope];
  if (scope === 'ingest' && where.ingest) return { kind: 'enforced', label: 'Enforced on ingest' };
  if (where.ingest && !where.delivery) return { kind: 'partial', label: 'Ingest only' };
  if (!where.ingest && !where.delivery) return { kind: 'inert', label: 'Not enforced' };
  return { kind: 'enforced', label: 'Enforced on ingest' };
}

/** What a policy at each scope bounds, as the data plane reads it today. */
export function describeScope(scope: RateLimitScope): string {
  switch (scope) {
    case 'ingest':
      return 'Events accepted by the ingest API, per API key or for every key in this project.';
    case 'project':
      return 'Events accepted for this project, whichever key published them. Charged on ingest; the delivery workers do not read it.';
    case 'organization':
      return 'Events accepted across every project in this organization. Charged on ingest; the delivery workers do not read it.';
    case 'endpoint':
      return 'Outbound delivery to one endpoint or every endpoint in this project. Stored and validated, but the delivery workers only read the endpoint’s own Rate limit setting today.';
  }
}

/** What a non-null `resource_id` names at each scope — `resourceKindFor` on the server. */
export function resourceKindFor(scope: RateLimitScope): string {
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

export interface ResolvedResource {
  /** What to print in the table. */
  label: string;
  /** True when the id could not be matched on the loaded page — printed as the id. */
  unresolved: boolean;
}

/**
 * The "Applies to" cell. Endpoint and API-key ids are joined against the
 * lists the page already loads; the project and the organization are named as
 * "this project" / "this organization" because a row can only ever name its
 * own (`resolveRateLimitResource` refuses a sibling project with a 400 and
 * another organization with a 404).
 *
 * An id not on the loaded page is printed as the id and flagged, never
 * dropped: the lists are one page, and a project past the page size is
 * exactly when this happens.
 */
export function describeResource(
  policy: Pick<RateLimit, 'scope' | 'resource_id'>,
  lookup: { endpoints: Pick<Endpoint, 'id' | 'name'>[]; apiKeys: Pick<ApiKey, 'id' | 'name'>[] },
): ResolvedResource {
  if (policy.resource_id === null) {
    switch (policy.scope) {
      case 'endpoint':
        return { label: 'Every endpoint in this project', unresolved: false };
      case 'ingest':
        return { label: 'Every API key in this project (one shared budget)', unresolved: false };
      case 'project':
        return { label: 'This project', unresolved: false };
      case 'organization':
        return { label: 'This organization', unresolved: false };
    }
  }
  switch (policy.scope) {
    case 'endpoint': {
      const endpoint = lookup.endpoints.find((row) => row.id === policy.resource_id);
      return endpoint
        ? { label: endpoint.name, unresolved: false }
        : { label: policy.resource_id, unresolved: true };
    }
    case 'ingest': {
      const key = lookup.apiKeys.find((row) => row.id === policy.resource_id);
      return key
        ? { label: key.name, unresolved: false }
        : { label: policy.resource_id, unresolved: true };
    }
    case 'project':
      return { label: 'This project', unresolved: false };
    case 'organization':
      return { label: 'This organization', unresolved: false };
  }
}

/** "100 / 1s" — the limit and the window it is counted over. */
export function formatRate(limit: number, windowSeconds: number): string {
  const window =
    windowSeconds % 3_600 === 0
      ? `${windowSeconds / 3_600}h`
      : windowSeconds % 60 === 0
        ? `${windowSeconds / 60}m`
        : `${windowSeconds}s`;
  return `${limit.toLocaleString()} / ${window}`;
}
