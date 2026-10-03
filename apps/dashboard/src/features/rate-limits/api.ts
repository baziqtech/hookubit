import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateRateLimitBody,
  OffsetPage,
  RateLimit,
  UpdateRateLimitBody,
} from '../../types/api';

/**
 * `GET /v1/projects/:projectId/rate-limits` — scoped to the project, offset
 * paged like every other list.
 *
 * Organization-scoped rows are still filed under whichever project created
 * them (`project_id` is NOT NULL on the table), so a policy covering the
 * whole organization made from a sibling project is NOT in this list even
 * though it applies here. The data plane joins across the organization for
 * that reason (`internal/ratelimit/source.go`); this list cannot, and the
 * page says so rather than implying it is the complete set of ceilings in
 * force.
 */
export function useRateLimits(projectId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.rateLimits(projectId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<RateLimit>>(
          `/v1/projects/${projectId}/rate-limits${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

function useRateLimitInvalidation(projectId: string) {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.rateLimitsRoot(projectId) });
}

/**
 * `POST /v1/projects/:projectId/rate-limits`.
 *
 * One policy per `(scope, resource_id)`, and the `resource_id: null` row
 * counts: a second "every endpoint in this project" policy is a 409
 * `conflict` carrying `{ scope, resource_id, existing_policy_id }`, because
 * two rows would give the data plane two answers to one question. A
 * `resource_id` from another tenant is the shared 404. `burst` below `limit`
 * is a 400 whose `details.field` is `burst`.
 */
export function useCreateRateLimit(projectId: string) {
  const invalidate = useRateLimitInvalidation(projectId);
  return useMutation({
    mutationFn: (body: CreateRateLimitBody) =>
      api.post<RateLimit>(`/v1/projects/${projectId}/rate-limits`, body),
    onSuccess: invalidate,
  });
}

/**
 * `PATCH /v1/projects/:projectId/rate-limits/:policyId`.
 *
 * `scope` and `resource_id` are the row's identity and ARE patchable; changing
 * either re-resolves the resource and re-checks uniqueness in one transaction,
 * which is safer than the delete-then-recreate it would otherwise push a
 * caller toward (a window with no limit in force at all). The numeric half is
 * validated merged with the stored row, so raising `limit` above a stored
 * `burst` is refused even though the body only carried `limit`.
 */
export function useUpdateRateLimit(projectId: string, policyId: string) {
  const invalidate = useRateLimitInvalidation(projectId);
  return useMutation({
    mutationFn: (body: UpdateRateLimitBody) =>
      api.patch<RateLimit>(`/v1/projects/${projectId}/rate-limits/${policyId}`, body),
    onSuccess: invalidate,
  });
}

/**
 * `DELETE /v1/projects/:projectId/rate-limits/:policyId` — a hard delete with
 * no preconditions. Nothing in the delivery ledger references a rate-limit
 * policy; removing the last row covering a resource means it falls back to
 * the next scope up (or, on ingest, to the installation's configured ceiling).
 */
export function useDeleteRateLimit(projectId: string) {
  const invalidate = useRateLimitInvalidation(projectId);
  return useMutation({
    mutationFn: (policyId: string) =>
      api.delete<void>(`/v1/projects/${projectId}/rate-limits/${policyId}`),
    onSuccess: invalidate,
  });
}
