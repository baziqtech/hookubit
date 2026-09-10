import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateSubscriptionBody,
  DisableSubscriptionBody,
  OffsetPage,
  Subscription,
  UpdateSubscriptionBody,
} from '../../types/api';

/**
 * `GET /v1/projects/:projectId/subscriptions` — a real module, offset paged
 * like everything else. It used to be read as a bare `{ data }` array, which
 * would have silently truncated at the page size.
 *
 * A row carries `endpoint_id` and NOT `endpoint_name`, and its filter field is
 * `payload_filter`, not `filter`. Callers wanting a name join against
 * `useEndpoints`.
 *
 * This is the ONE source for the list; `features/endpoints/api.ts` re-exports
 * it for the callers that imported it from there.
 */
export function useSubscriptions(projectId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.subscriptions(projectId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Subscription>>(
          `/v1/projects/${projectId}/subscriptions${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * Every page of the project's subscription list. The first-run checklist
 * derives "is anything routed" from the same key, so this also keeps the
 * Overview honest after a create or a disable.
 */
function useSubscriptionInvalidation(projectId: string) {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionsRoot(projectId) });
}

/**
 * `POST /v1/projects/:projectId/subscriptions`.
 *
 * The filter is stored EXACTLY as sent. A pattern the router cannot honour is
 * a 400 — never coerced to `*` — and the message is the reason, verbatim, so
 * the form puts it under the event-types field. Two 409s, told apart by
 * `error.code`: `limit_exceeded` with `{ limit, current, resource }` at the
 * per-project ceiling, and `conflict` when the endpoint has been deleted.
 */
export function useCreateSubscription(projectId: string) {
  const invalidate = useSubscriptionInvalidation(projectId);
  return useMutation({
    mutationFn: (body: CreateSubscriptionBody) =>
      api.post<Subscription>(`/v1/projects/${projectId}/subscriptions`, body),
    onSuccess: invalidate,
  });
}

/**
 * `PATCH /v1/projects/:projectId/subscriptions/:subscriptionId`.
 *
 * `event_types` and `payload_filter` are REPLACED wholesale. `enabled` is not
 * in the body type because it is not in the DTO: enabling and disabling have
 * their own routes so a pause is a separately audited act. A caller must send
 * only what changed — restating an unchanged `endpoint_id` re-runs the
 * deleted-endpoint check against a value nobody touched.
 */
export function useUpdateSubscription(projectId: string, subscriptionId: string) {
  const invalidate = useSubscriptionInvalidation(projectId);
  return useMutation({
    mutationFn: (body: UpdateSubscriptionBody) =>
      api.patch<Subscription>(`/v1/projects/${projectId}/subscriptions/${subscriptionId}`, body),
    onSuccess: invalidate,
  });
}

/** `POST …/enable` — resume matching. Idempotent; the filter is untouched. */
export function useEnableSubscription(projectId: string, subscriptionId: string) {
  const invalidate = useSubscriptionInvalidation(projectId);
  return useMutation({
    mutationFn: () =>
      api.post<Subscription>(
        `/v1/projects/${projectId}/subscriptions/${subscriptionId}/enable`,
      ),
    onSuccess: invalidate,
  });
}

/**
 * `POST …/disable` — stop matching, keep the filter.
 *
 * A disabled subscription is skipped before the event-type test, so it matches
 * nothing at all. Deliveries already queued are not discarded. The reason goes
 * to the audit log, which is what makes the delivery gap explainable later.
 */
export function useDisableSubscription(projectId: string, subscriptionId: string) {
  const invalidate = useSubscriptionInvalidation(projectId);
  return useMutation({
    mutationFn: (body: DisableSubscriptionBody = {}) =>
      api.post<Subscription>(
        `/v1/projects/${projectId}/subscriptions/${subscriptionId}/disable`,
        body,
      ),
    onSuccess: invalidate,
  });
}

/**
 * `DELETE …/:subscriptionId` — a HARD delete, unlike endpoints and projects.
 *
 * The row really goes. Nothing has a foreign key to it, the delivery ledger
 * keeps its own `endpoint_id` and `event_id`, and the whole routing rule is
 * written to the audit log on the way out. Answers 204, and 204 again for a
 * row that is already gone.
 */
export function useDeleteSubscription(projectId: string, subscriptionId: string) {
  const invalidate = useSubscriptionInvalidation(projectId);
  return useMutation({
    mutationFn: () =>
      api.delete<void>(`/v1/projects/${projectId}/subscriptions/${subscriptionId}`),
    onSuccess: invalidate,
  });
}
