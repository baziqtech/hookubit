import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { ApiKey, Project, ProjectAnalytics } from '../../types/api';

export function useProjects(orgId: string) {
  return useQuery({
    queryKey: queryKeys.projects(orgId),
    queryFn: async () =>
      (await api.get<{ data: Project[] }>(`/v1/projects${queryString({ organization_id: orgId })}`))
        .data,
    enabled: Boolean(orgId),
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

export function useApiKeys(projectId: string) {
  return useQuery({
    queryKey: queryKeys.apiKeys(projectId),
    queryFn: async () =>
      (await api.get<{ data: ApiKey[] }>(`/v1/projects/${projectId}/api-keys`)).data,
    enabled: Boolean(projectId),
  });
}

export function useAnalytics(projectId: string) {
  return useQuery({
    queryKey: queryKeys.analytics(projectId),
    queryFn: () => api.get<ProjectAnalytics>(`/v1/projects/${projectId}/analytics`),
    enabled: Boolean(projectId),
  });
}
