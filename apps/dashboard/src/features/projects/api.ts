import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateProjectBody,
  OffsetPage,
  Project,
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

/**
 * `POST /v1/organizations/:orgId/projects` — `projects.write` (owner or admin).
 *
 * `environment` is chosen HERE and never again: the DTO defaults it to `test`
 * so nothing is created live by omission, and `UpdateProjectDto` refuses it.
 * A supplied `slug` is validated, never rewritten; an omitted one is derived
 * from the name and comes back in the response. Two 409s, told apart by
 * `error.code`: `limit_exceeded` with `{ limit, current, resource }` at the
 * per-organization ceiling, and `conflict` for a slug already taken in this
 * organization — deleted projects keep theirs.
 */
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
 * `DELETE /v1/organizations/:orgId/projects/:projectId` — a SOFT delete.
 *
 * Sets `status = deleted` and returns the row in that state. Nothing is
 * erased: endpoints, API keys and the whole delivery ledger survive. The
 * project stops being visible to this API, the ingest path refuses its keys
 * (they are deliberately NOT revoked — the "project is not active" rule
 * already covers them and needs no undoing if this was a mistake), and the
 * slug stays taken. Audited as `project.deleted`. There is no undelete.
 *
 * Both the row and the LIST are dropped: the switcher and the breadcrumb read
 * the list, and a deleted project still in the menu reads as "the delete did
 * not happen".
 */
export function useDeleteProject(orgId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete<Project>(`/v1/organizations/${orgId}/projects/${projectId}`),
    onSuccess: () => {
      // REMOVED, not invalidated. The caller navigates to the organization
      // landing, which redirects to the first project in the list it reads -
      // and an invalidated list still serves its cached rows while it refetches,
      // so the landing page sent the operator straight back into the project
      // they had just deleted. Dropping the entries makes it wait for the truth.
      queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
      queryClient.removeQueries({ queryKey: queryKeys.projectsRoot(orgId) });
    },
  });
}
