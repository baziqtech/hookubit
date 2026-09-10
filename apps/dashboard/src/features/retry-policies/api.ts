import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateRetryPolicyBody,
  OffsetPage,
  RetryPolicy,
  UpdateRetryPolicyBody,
} from '../../types/api';

/**
 * `GET /v1/projects/:projectId/retry-policies`.
 *
 * SCOPED TO THE PROJECT, and that is the reason this hook exists at all. The
 * endpoint edit form took `retry_policy_id` as free text, so an id copied from
 * another project — the obvious thing to do when two projects should retry the
 * same way — answers 404 through the tenant scope, and the operator reads that
 * as "the platform lost my policy" rather than "that id is not addressable
 * here". A list the project actually owns is the only honest input.
 */
export function useRetryPolicies(projectId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.retryPolicies(projectId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<RetryPolicy>>(
          `/v1/projects/${projectId}/retry-policies${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * "Up to 8 attempts, exponential from 1s" — the summary a picker needs.
 *
 * The delay figures are shown in seconds because the operator is reasoning
 * about how long a broken consumer stays broken, not about milliseconds, and
 * `max_attempts` leads because it is the number that decides whether a delivery
 * ends `exhausted` inside the incident or after it.
 */
export function describeRetryPolicy(policy: RetryPolicy): string {
  const attempts = `${policy.max_attempts} attempt${policy.max_attempts === 1 ? '' : 's'}`;
  const initial = formatMs(policy.initial_delay_ms);
  const max = formatMs(policy.max_delay_ms);
  switch (policy.strategy) {
    case 'exponential':
      return `${attempts}, exponential ×${policy.multiplier} from ${initial} up to ${max}`;
    case 'linear':
      return `${attempts}, linear +${initial} up to ${max}`;
    case 'constant':
      return `${attempts}, every ${initial}`;
  }
}

/** 5000 → "5s", 3_600_000 → "60m" — the unit an operator reasons in. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 90) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}m`;
  return `${Number((minutes / 60).toFixed(1))}h`;
}

/** `GET /v1/projects/:projectId/retry-policies/:policyId`. */
export function useRetryPolicy(projectId: string, policyId: string) {
  return useQuery({
    queryKey: queryKeys.retryPolicy(projectId, policyId),
    queryFn: () =>
      api.get<RetryPolicy>(`/v1/projects/${projectId}/retry-policies/${policyId}`),
    enabled: Boolean(projectId && policyId),
  });
}

/**
 * Everything a write to a retry policy has to drop from the cache.
 *
 * Every page of the list (each offset is cached under its own key), the row
 * itself when one is named, and the ENDPOINT list: the endpoint table and the
 * edit dialog's picker both render policy names and the default marker from
 * this list, and a rename or a moved default that left them stale would show
 * an endpoint on a policy called by its old name.
 */
function useRetryPolicyInvalidation(projectId: string) {
  const queryClient = useQueryClient();
  return (policyId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.retryPoliciesRoot(projectId) });
    if (policyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.retryPolicy(projectId, policyId) });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.endpointsRoot(projectId) });
  };
}

/**
 * `POST /v1/projects/:projectId/retry-policies`.
 *
 * The FIRST policy in a project becomes the default whether or not
 * `is_default` was sent — a project with policies and no default is a state
 * nothing downstream can resolve — so the response is the row to read
 * `is_default` off, not the request. Past the project ceiling the route
 * answers `limit_exceeded` with `{ limit, current, resource }`; a coherence
 * failure (initial delay above the ceiling, an exponential multiplier of 1)
 * is a 400 whose `details.field` names the input.
 */
export function useCreateRetryPolicy(projectId: string) {
  const invalidate = useRetryPolicyInvalidation(projectId);
  return useMutation({
    mutationFn: (body: CreateRetryPolicyBody) =>
      api.post<RetryPolicy>(`/v1/projects/${projectId}/retry-policies`, body),
    onSuccess: () => invalidate(),
  });
}

/**
 * `PATCH /v1/projects/:projectId/retry-policies/:policyId`.
 *
 * The patch is validated MERGED with the stored row, so lowering
 * `max_delay_ms` under a stored `initial_delay_ms` is refused even though the
 * body only carried one field. `is_default` is not accepted here at all —
 * `useSetDefaultRetryPolicy` is the only way to move it.
 */
export function useUpdateRetryPolicy(projectId: string, policyId: string) {
  const invalidate = useRetryPolicyInvalidation(projectId);
  return useMutation({
    mutationFn: (body: UpdateRetryPolicyBody) =>
      api.patch<RetryPolicy>(`/v1/projects/${projectId}/retry-policies/${policyId}`, body),
    onSuccess: () => invalidate(policyId),
  });
}

/**
 * `POST /v1/projects/:projectId/retry-policies/:policyId/default`.
 *
 * Clears the previous default and sets this one in a single SERIALIZABLE
 * transaction. Idempotent on the current default. It changes which policy
 * endpoints WITHOUT their own policy resolve to for deliveries created from
 * now on; a delivery already fanned out keeps the `max_attempts` stamped on
 * its row.
 */
export function useSetDefaultRetryPolicy(projectId: string) {
  const invalidate = useRetryPolicyInvalidation(projectId);
  return useMutation({
    mutationFn: (policyId: string) =>
      api.post<RetryPolicy>(`/v1/projects/${projectId}/retry-policies/${policyId}/default`),
    onSuccess: (_row, policyId) => invalidate(policyId),
  });
}

/**
 * `DELETE /v1/projects/:projectId/retry-policies/:policyId[?replacement_id=]`.
 *
 * Two refusals, both 409 `conflict`, and the dialog has to render both:
 *
 *   - Any LIVE endpoint still references it. `endpoints.retry_policy_id` is
 *     ON DELETE SET NULL, so the delete would silently move those endpoints
 *     onto the platform default backoff with nothing in the record to say
 *     so. `details.endpoints` carries how many. Soft-deleted endpoints do not
 *     block it; they are unlinked and the count is audited.
 *   - It is the project default and other policies remain, and no
 *     `replacement_id` named the successor. The promotion happens in the same
 *     transaction so no reader ever sees a project with policies and no
 *     default. Deleting the LAST policy needs no replacement — the project
 *     falls back to the built-in default, which is a defined state.
 *
 * A `replacement_id` sent when it is not needed is a 400 naming the field,
 * because it would silently change the default as a side effect of a delete
 * that did not need to.
 */
export function useDeleteRetryPolicy(projectId: string) {
  const invalidate = useRetryPolicyInvalidation(projectId);
  return useMutation({
    mutationFn: ({ policyId, replacementId }: { policyId: string; replacementId?: string }) =>
      api.delete<void>(
        `/v1/projects/${projectId}/retry-policies/${policyId}${queryString({
          replacement_id: replacementId,
        })}`,
      ),
    onSuccess: (_void, { policyId }) => invalidate(policyId),
  });
}
