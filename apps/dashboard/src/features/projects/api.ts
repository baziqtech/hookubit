import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateProjectBody,
  OffsetPage,
  Project,
  ProjectAnalytics,
  UpdateProjectBody,
} from '../../types/api';

/**
 * Projects are nested under the organization: `GET /v1/organizations/:orgId/projects`.
 * There is no top-level `/v1/projects?organization_id=` route — that was the
 * mock's invention, and a request to it would have 404'd against the real API.
 *
 * The hook returns the normalised page rather than a bare array: a caller
 * holding only `rows` cannot tell a full page from a complete result.
 * `ProjectListDto` no longer carries `count`; `has_more` is the only signal.
 */
export function useProjects(orgId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.projects(orgId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Project>>(
          `/v1/organizations/${orgId}/projects${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(orgId),
  });
}

/**
 * One project — NESTED UNDER THE ORGANIZATION, like the list.
 *
 * `ProjectsController` is mounted at `organizations/:orgId/projects`, so
 * `GET /v1/projects/:id` does not exist. The org id in the path is the tenant
 * anchor `TenantResolver` checks membership against; it is never taken from the
 * project row, which is why it has to be in the URL.
 */
export function useProject(orgId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/v1/organizations/${orgId}/projects/${projectId}`),
    enabled: Boolean(orgId && projectId),
  });
}

/**
 * `PATCH /v1/organizations/:orgId/projects/:projectId` — name and slug.
 *
 * `environment` is NOT accepted and must never be sent. The global
 * `ValidationPipe` runs `forbidNonWhitelisted`, so a body carrying it is a 400
 * `invalid_request` — and `ProjectsService.update` checks the key again so the
 * refusal explains WHY rather than reading like a typo. Offering the field in a
 * form and letting the server say no is not honest design: it re-scopes every
 * key and endpoint underneath, and the answer is a second project.
 *
 * A taken slug is a 409 `conflict`, not a `limit_exceeded`.
 */
export function useUpdateProject(orgId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectBody) =>
      api.patch<Project>(`/v1/organizations/${orgId}/projects/${projectId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      // The switcher and the breadcrumb read the LIST, not the row, so a rename
      // that only invalidated the row would leave the old name on screen.
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectsRoot(orgId) });
    },
  });
}

export function useCreateProject(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectBody) =>
      api.post<Project>(`/v1/organizations/${orgId}/projects`, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectsRoot(orgId) }),
  });
}

/**
 * MOCK-ONLY. `GET /v1/projects/:id/analytics` IS NOT IN THE OPENAPI DOCUMENT —
 * there is no analytics module at all, not one whose shape drifted. Against the
 * real transport this 404s, so `AnalyticsPage` refuses to run it and says so
 * instead of rendering an error or, worse, fabricated numbers.
 */
export function useAnalytics(projectId: string) {
  return useQuery({
    queryKey: queryKeys.analytics(projectId),
    queryFn: () => api.get<ProjectAnalytics>(`/v1/projects/${projectId}/analytics`),
    enabled: Boolean(projectId),
  });
}
