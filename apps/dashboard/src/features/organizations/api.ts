import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { AuditLogEntry, Member, Organization, Page, UsageSummary } from '../../types/api';

export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.organizations(),
    queryFn: async () => (await api.get<{ data: Organization[] }>('/v1/organizations')).data,
  });
}

export function useOrganization(orgId: string) {
  return useQuery({
    queryKey: queryKeys.organization(orgId),
    queryFn: () => api.get<Organization>(`/v1/organizations/${orgId}`),
    enabled: Boolean(orgId),
  });
}

export function useMembers(orgId: string) {
  return useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: async () =>
      (await api.get<{ data: Member[] }>(`/v1/organizations/${orgId}/members`)).data,
    enabled: Boolean(orgId),
  });
}

export function useAuditLogs(orgId: string) {
  return useQuery({
    queryKey: queryKeys.auditLogs(orgId),
    queryFn: async () =>
      (await api.get<Page<AuditLogEntry>>(`/v1/organizations/${orgId}/audit-logs`)).data,
    enabled: Boolean(orgId),
  });
}

export function useUsage(orgId: string) {
  return useQuery({
    queryKey: queryKeys.usage(orgId),
    queryFn: () => api.get<UsageSummary>(`/v1/organizations/${orgId}/usage`),
    enabled: Boolean(orgId),
  });
}
