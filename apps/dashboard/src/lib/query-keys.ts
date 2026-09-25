/**
 * One key factory for the whole app. Keys are built here rather than inline so
 * an invalidation after a mutation cannot silently miss a cache entry because
 * two call sites spelled the same query differently.
 *
 * Paged lists carry their `offset` in the key, so each page is cached
 * separately — and each therefore has a `*Root` prefix key that a mutation
 * invalidates to drop EVERY page at once. Invalidating only the current page
 * would leave page 2 holding a key that has since been revoked.
 */
export const queryKeys = {
  session: () => ['session'] as const,

  organizationsRoot: () => ['organizations'] as const,
  organizations: (offset = 0) => ['organizations', { offset }] as const,
  organization: (orgId: string) => ['organization', orgId] as const,

  membersRoot: (orgId: string) => ['organization', orgId, 'members'] as const,
  members: (orgId: string, offset = 0) => ['organization', orgId, 'members', { offset }] as const,

  auditLogsRoot: (orgId: string) => ['organization', orgId, 'audit-logs'] as const,
  auditLogs: (orgId: string, filters: Record<string, string>, offset = 0) =>
    ['organization', orgId, 'audit-logs', filters, { offset }] as const,

  projectsRoot: (orgId: string) => ['projects', orgId] as const,
  projects: (orgId: string, offset = 0) => ['projects', orgId, { offset }] as const,
  project: (projectId: string) => ['project', projectId] as const,

  endpointsRoot: (projectId: string) => ['project', projectId, 'endpoints'] as const,
  endpoints: (projectId: string, offset = 0, includeDeleted?: boolean) =>
    ['project', projectId, 'endpoints', { offset, includeDeleted: includeDeleted ?? false }] as const,

  endpoint: (endpointId: string) => ['endpoint', endpointId] as const,

  endpointSecretsRoot: (endpointId: string) => ['endpoint', endpointId, 'secrets'] as const,
  endpointSecrets: (endpointId: string, offset = 0) =>
    ['endpoint', endpointId, 'secrets', { offset }] as const,

  apiKeysRoot: (projectId: string) => ['project', projectId, 'api-keys'] as const,
  apiKeys: (projectId: string, offset = 0) =>
    ['project', projectId, 'api-keys', { offset }] as const,

  subscriptionsRoot: (projectId: string) => ['project', projectId, 'subscriptions'] as const,
  subscriptions: (projectId: string, offset = 0) =>
    ['project', projectId, 'subscriptions', { offset }] as const,

  retryPoliciesRoot: (projectId: string) => ['project', projectId, 'retry-policies'] as const,
  retryPolicies: (projectId: string, offset = 0) =>
    ['project', projectId, 'retry-policies', { offset }] as const,
  retryPolicy: (projectId: string, policyId: string) =>
    ['project', projectId, 'retry-policy', policyId] as const,

  rateLimitsRoot: (projectId: string) => ['project', projectId, 'rate-limits'] as const,
  rateLimits: (projectId: string, offset = 0) =>
    ['project', projectId, 'rate-limits', { offset }] as const,
  /*
   * Analytics: four routes, one key each, with the window (and limit) in the
   * key so 24h and 7d are separate cache entries rather than one overwriting
   * the other. `analyticsRoot` is the prefix a replay or requeue can drop.
   */
  analyticsRoot: (projectId: string) => ['project', projectId, 'analytics'] as const,
  analyticsDeliveries: (projectId: string, windowHours: number) =>
    ['project', projectId, 'analytics', 'deliveries', { windowHours }] as const,
  billing: (orgId: string) => ['org', orgId, 'billing'] as const,
  notificationDestinations: (projectId: string) =>
    ['project', projectId, 'notification-destinations'] as const,
  analyticsSeries: (projectId: string, windowHours: number, bucket: string | undefined) =>
    ['project', projectId, 'analytics', 'deliveries', 'series', { windowHours, bucket }] as const,
  analyticsEndpoints: (projectId: string, windowHours: number, limit: number) =>
    ['project', projectId, 'analytics', 'endpoints', { windowHours, limit }] as const,
  analyticsLatency: (projectId: string, windowHours: number) =>
    ['project', projectId, 'analytics', 'latency', { windowHours }] as const,
  analyticsEvents: (projectId: string, windowHours: number, limit: number) =>
    ['project', projectId, 'analytics', 'events', { windowHours, limit }] as const,
  eventsRoot: (projectId: string) => ['project', projectId, 'events'] as const,
  events: (projectId: string, filters: Record<string, string>, offset = 0) =>
    ['project', projectId, 'events', filters, { offset }] as const,
  event: (projectId: string, eventId: string) => ['project', projectId, 'event', eventId] as const,
  eventDeliveries: (projectId: string, eventId: string) =>
    ['project', projectId, 'event', eventId, 'deliveries'] as const,
  deliveriesRoot: (projectId: string) => ['project', projectId, 'deliveries'] as const,
  deliveries: (projectId: string, filters: Record<string, string>, offset = 0) =>
    ['project', projectId, 'deliveries', filters, { offset }] as const,
  delivery: (projectId: string, deliveryId: string) =>
    ['project', projectId, 'delivery', deliveryId] as const,
  deliveryAttempts: (projectId: string, deliveryId: string) =>
    ['project', projectId, 'delivery', deliveryId, 'attempts'] as const,

  outboxRoot: (projectId: string) => ['project', projectId, 'outbox'] as const,
  outbox: (projectId: string, filters: Record<string, string>, offset = 0) =>
    ['project', projectId, 'outbox', filters, { offset }] as const,
  outboxEntry: (projectId: string, outboxId: string) =>
    ['project', projectId, 'outbox-entry', outboxId] as const,
};
