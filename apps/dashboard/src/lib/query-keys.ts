/**
 * One key factory for the whole app. Keys are built here rather than inline so
 * an invalidation after a mutation cannot silently miss a cache entry because
 * two call sites spelled the same query differently.
 */
export const queryKeys = {
  session: () => ['session'] as const,
  organizations: () => ['organizations'] as const,
  organization: (orgId: string) => ['organization', orgId] as const,
  members: (orgId: string) => ['organization', orgId, 'members'] as const,
  auditLogs: (orgId: string) => ['organization', orgId, 'audit-logs'] as const,
  usage: (orgId: string) => ['organization', orgId, 'usage'] as const,
  projects: (orgId: string) => ['projects', orgId] as const,
  project: (projectId: string) => ['project', projectId] as const,
  endpoints: (projectId: string) => ['project', projectId, 'endpoints'] as const,
  subscriptions: (projectId: string) => ['project', projectId, 'subscriptions'] as const,
  apiKeys: (projectId: string) => ['project', projectId, 'api-keys'] as const,
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
