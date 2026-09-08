import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  DeliveryStatus,
  OffsetPage,
} from '../../types/api';

/**
 * Filters `DeliveriesController` actually accepts.
 *
 * There is NO `search`. The page offered a free-text box that was sent as
 * `?search=` and would have been rejected by `forbidNonWhitelisted`, or at best
 * ignored; the real API filters by exact `status`, `endpoint_id`, `event_id`,
 * `event_type`, a date range, and `origin`.
 *
 * `failing_now` is the one worth knowing about: `retrying`, `failed` and
 * `exhausted` in one query — "everything that has broken and not recovered" —
 * and the API REFUSES it combined with `status` rather than silently picking
 * one, so the UI must not send both.
 */
export interface DeliveryFilters {
  status?: DeliveryStatus | '';
  failing_now?: boolean;
  endpoint_id?: string;
  event_id?: string;
  event_type?: string;
  created_after?: string;
  created_before?: string;
  origin?: 'original' | 'replay' | '';
}

/**
 * `GET /v1/projects/:projectId/deliveries` — OFFSET paged, like everything
 * else. The dashboard modelled this as cursor paged (`{ has_more, next_cursor
 * }`); `next_cursor` does not exist anywhere in the document.
 */
export function useDeliveries(projectId: string, filters: DeliveryFilters, offset = 0) {
  return useQuery({
    queryKey: queryKeys.deliveries(projectId, filters as Record<string, string>, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Delivery>>(
          `/v1/projects/${projectId}/deliveries${queryString({
            ...filters,
            failing_now: filters.failing_now ? 'true' : undefined,
            ...pageParams(offset),
          })}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * NESTED UNDER THE PROJECT. `DeliveriesController` is mounted at
 * `projects/:projectId/deliveries`, so `GET /v1/deliveries/:id` — which is what
 * this hook used to call — does not exist. The project id in the path is what
 * the tenant resolver reads the organization off; it is a lookup key, never an
 * authorization claim.
 *
 * The detail response EMBEDS the attempt history, plus `event` and `endpoint`
 * reference objects. One request answers the whole page.
 */
export function useDelivery(projectId: string, deliveryId: string) {
  return useQuery({
    queryKey: queryKeys.delivery(projectId, deliveryId),
    queryFn: () =>
      api.get<DeliveryDetail>(`/v1/projects/${projectId}/deliveries/${deliveryId}`),
    enabled: Boolean(projectId && deliveryId),
  });
}

/**
 * The pager for an attempt history the detail response had to truncate.
 *
 * `DeliveryDetailDto.attempts_truncated` says whether the embedded array is
 * complete. A page that ignored the flag and rendered the embedded array would
 * show a partial history as a whole one — which, on the screen whose entire job
 * is "what happened to this delivery", is the worst possible place to be
 * quietly incomplete.
 */
export function useDeliveryAttempts(projectId: string, deliveryId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.deliveryAttempts(projectId, deliveryId),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<DeliveryAttempt>>(
          `/v1/projects/${projectId}/deliveries/${deliveryId}/attempts${queryString(pageParams(0))}`,
        ),
      ),
    enabled: Boolean(projectId && deliveryId) && enabled,
  });
}

/**
 * `POST …/deliveries/:id/replay` — a NEW delivery row, not a reset of this one.
 *
 * The response is the created delivery, and it carries `replay_of_delivery_id`
 * pointing back here while this row gains `replayed_by`. Both rows stay in the
 * ledger, which is why the list is invalidated too: a replay that only appeared
 * on the detail page would leave the deliveries table one row short.
 */
export function useReplayDelivery(projectId: string, deliveryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason?: string } = {}) =>
      api.post<Delivery>(`/v1/projects/${projectId}/deliveries/${deliveryId}/replay`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.delivery(projectId, deliveryId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.deliveryAttempts(projectId, deliveryId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deliveriesRoot(projectId) });
    },
  });
}
