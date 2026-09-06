import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { Endpoint, Subscription } from '../../types/api';

export function useEndpoints(projectId: string) {
  return useQuery({
    queryKey: queryKeys.endpoints(projectId),
    queryFn: async () =>
      (await api.get<{ data: Endpoint[] }>(`/v1/projects/${projectId}/endpoints`)).data,
    enabled: Boolean(projectId),
  });
}

export function useSubscriptions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.subscriptions(projectId),
    queryFn: async () =>
      (await api.get<{ data: Subscription[] }>(`/v1/projects/${projectId}/subscriptions`)).data,
    enabled: Boolean(projectId),
  });
}
