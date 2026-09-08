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

  auditLogs: (orgId: string) => ['organization', orgId, 'audit-logs'] as const,
  usage: (orgId: string) => ['organization', orgId, 'usage'] as const,

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

  subscriptions: (projectId: string) => ['project', projectId, 'subscriptions'] as const,
  analytics: (projectId: string) => ['project', projectId, 'analytics'] as const,
  events: (projectId: string, filters: Record<string, string>) =>
    ['project', projectId, 'events', filters] as const,
  event: (eventId: string) => ['event', eventId] as const,
  eventDeliveries: (eventId: string) => ['event', eventId, 'deliveries'] as const,
  deliveries: (projectId: string, filters: Record<string, string>) =>
    ['project', projectId, 'deliveries', filters] as const,
  delivery: (deliveryId: string) => ['delivery', deliveryId] as const,
  deliveryAttempts: (deliveryId: string) => ['delivery', deliveryId, 'attempts'] as const,
};
