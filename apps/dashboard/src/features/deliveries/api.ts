import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { Delivery, DeliveryAttempt, DeliveryDetail, CursorPage } from '../../types/api';

export interface DeliveryFilters {
  status?: string;
  endpoint_id?: string;
  search?: string;
}

export function useDeliveries(projectId: string, filters: DeliveryFilters) {
  return useQuery({
    queryKey: queryKeys.deliveries(projectId, filters as Record<string, string>),
    queryFn: () =>
      api.get<CursorPage<Delivery>>(`/v1/projects/${projectId}/deliveries${queryString({ ...filters })}`),
    enabled: Boolean(projectId),
  });
}

export function useDelivery(deliveryId: string) {
  return useQuery({
    queryKey: queryKeys.delivery(deliveryId),
    queryFn: () => api.get<DeliveryDetail>(`/v1/deliveries/${deliveryId}`),
    enabled: Boolean(deliveryId),
  });
}

export function useDeliveryAttempts(deliveryId: string) {
  return useQuery({
    queryKey: queryKeys.deliveryAttempts(deliveryId),
    queryFn: async () =>
      (await api.get<{ data: DeliveryAttempt[] }>(`/v1/deliveries/${deliveryId}/attempts`)).data,
    enabled: Boolean(deliveryId),
  });
}

export function useReplayDelivery(deliveryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ status: string }>(`/v1/deliveries/${deliveryId}/replay`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.delivery(deliveryId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deliveryAttempts(deliveryId) });
    },
  });
}
