import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams, type Paged } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  Delivery,
  EventDetail,
  EventStatus,
  OffsetPage,
  ReplayResult,
  WebhookEvent,
} from '../../types/api';

/**
 * Filters `EventsController` actually accepts.
 *
 * There is NO `search`. The closest thing is `idempotency_key`, a
 * case-insensitive SUBSTRING of the producer-supplied key — "the producer says
 * they sent order 41f9, did we get it?" — with a three-character minimum, and
 * it is explicitly not index-supported, so it belongs next to a date range
 * rather than presented as a general search box over all of history.
 */
export interface EventFilters {
  event_type?: string;
  status?: EventStatus | '';
  idempotency_key?: string;
  created_after?: string;
  created_before?: string;
}

/** `GET /v1/projects/:projectId/events` — offset paged, not cursor paged. */
export function useEvents(
  projectId: string,
  filters: EventFilters,
  offset = 0,
  /**
   * Extra query options, merged last.
   *
   * The only caller that uses this is the setup checklist, which polls for the
   * FIRST event and stops when it arrives. It is a parameter rather than a
   * second hook so the polling caller shares this one's cache key — otherwise
   * the checklist would poll one entry while the page read another, and the
   * step would stay "waiting" after the event had landed.
   */
  options?: Partial<
    Pick<
      UseQueryOptions<Paged<WebhookEvent>>,
      'refetchInterval' | 'refetchIntervalInBackground' | 'staleTime'
    >
  >,
) {
  return useQuery({
    queryKey: queryKeys.events(projectId, filters as Record<string, string>, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<WebhookEvent>>(
          `/v1/projects/${projectId}/events${queryString({ ...filters, ...pageParams(offset) })}`,
        ),
      ),
    enabled: Boolean(projectId),
    ...options,
  });
}

/**
 * NESTED UNDER THE PROJECT — `GET /v1/events/:id` does not exist.
 *
 * The detail response's `payload` is an ENVELOPE (`EventPayloadDto`), not the
 * raw body: it says whether the bytes are inline, in object storage, or
 * unavailable, and carries a `notice` explaining which. An event whose payload
 * was offloaded must not render as an empty code block.
 */
export function useEvent(projectId: string, eventId: string) {
  return useQuery({
    queryKey: queryKeys.event(projectId, eventId),
    queryFn: () => api.get<EventDetail>(`/v1/projects/${projectId}/events/${eventId}`),
    enabled: Boolean(projectId && eventId),
  });
}

/**
 * The materialised routing for one event: one row per matching subscription,
 * each with its own retry chain. This is the query that answers "did finance
 * ever receive this?".
 */
export function useEventDeliveries(projectId: string, eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventDeliveries(projectId, eventId),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Delivery>>(
          `/v1/projects/${projectId}/events/${eventId}/deliveries${queryString(pageParams(0))}`,
        ),
      ),
    enabled: Boolean(projectId && eventId),
  });
}

/**
 * Replay routes the event AGAIN, creating new delivery rows rather than
 * resetting the old ones — `ReplayResultDto` returns them, with `replayed_count`
 * and the `replay_of` ids. `endpoint_id` narrows it to one endpoint, which is
 * usually what you want: replaying to every subscriber to fix one broken
 * consumer re-delivers to four that were fine.
 */
export function useReplayEvent(projectId: string, eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason?: string; endpoint_id?: string } = {}) =>
      api.post<ReplayResult>(`/v1/projects/${projectId}/events/${eventId}/replay`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.eventDeliveries(projectId, eventId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.event(projectId, eventId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deliveriesRoot(projectId) });
    },
  });
}
