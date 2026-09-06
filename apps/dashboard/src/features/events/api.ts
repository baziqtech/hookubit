import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { Delivery, EventDetail, Page, WebhookEvent } from '../../types/api';

export interface EventFilters {
  event_type?: string;
  status?: string;
  search?: string;
}

export function useEvents(projectId: string, filters: EventFilters) {
  return useQuery({
    queryKey: queryKeys.events(projectId, filters as Record<string, string>),
    queryFn: () =>
      api.get<Page<WebhookEvent>>(`/v1/projects/${projectId}/events${queryString({ ...filters })}`),
    enabled: Boolean(projectId),
  });
}

export function useEvent(eventId: string) {
  return useQuery({
    queryKey: queryKeys.event(eventId),
    queryFn: () => api.get<EventDetail>(`/v1/events/${eventId}`),
    enabled: Boolean(eventId),
  });
}

export function useEventDeliveries(eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventDeliveries(eventId),
    queryFn: async () =>
      (await api.get<{ data: Delivery[] }>(`/v1/events/${eventId}/deliveries`)).data,
    enabled: Boolean(eventId),
  });
}

/** Replay fans the event out again; every affected delivery row must be refetched. */
export function useReplayEvent(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ replayed: number }>(`/v1/events/${eventId}/replay`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.eventDeliveries(eventId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
    },
  });
}
