import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { CountedOffsetPage, Project, ProjectAnalytics } from '../../types/api';

/**
 * Projects are nested under the organization: `GET /v1/organizations/:orgId/projects`.
 * There is no top-level `/v1/projects?organization_id=` route — that was the
 * mock's invention, and a request to it would have 404'd against the real API.
 *
 * The response is a `CountedOffsetPage`, so the hook returns the normalised
 * page rather than a bare array: a caller holding only `rows` cannot tell a
 * full page from a complete result.
 */
export function useProjects(orgId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.projects(orgId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<CountedOffsetPage<Project>>(
          `/v1/organizations/${orgId}/projects${queryString(pageParams(offset))}`,
        ),
      ),
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

export function useCreateProject(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug?: string; environment?: 'test' | 'live' }) =>
      api.post<Project>(`/v1/organizations/${orgId}/projects`, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectsRoot(orgId) }),
  });
}

/** SPECULATIVE — no analytics module exists in the control API yet. */
export function useAnalytics(projectId: string) {
  return useQuery({
    queryKey: queryKeys.analytics(projectId),
    queryFn: () => api.get<ProjectAnalytics>(`/v1/projects/${projectId}/analytics`),
    enabled: Boolean(projectId),
  });
}
