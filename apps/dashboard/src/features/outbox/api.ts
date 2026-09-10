import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  OffsetPage,
  OutboxEntry,
  OutboxStatus,
  RequeueOutboxBody,
  RequeueParkedBody,
  RequeueResult,
} from '../../types/api';

/**
 * Filters `OutboxController.list` accepts: exact `status`, one `event_id`.
 * Nothing else — the DTO runs `forbidNonWhitelisted`, so a parameter it does
 * not declare is a 400, not a silently wider listing.
 */
export interface OutboxFilters {
  status?: OutboxStatus | '';
  event_id?: string;
}

/**
 * `GET /v1/projects/:projectId/outbox` — offset paged like every other list,
 * newest first. `status=failed` is the parked set: rows the platform answered
 * 202 to and then could not fan out.
 */
export function useOutboxEntries(projectId: string, filters: OutboxFilters, offset = 0) {
  return useQuery({
    queryKey: queryKeys.outbox(projectId, filters as Record<string, string>, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<OutboxEntry>>(
          `/v1/projects/${projectId}/outbox${queryString({ ...filters, ...pageParams(offset) })}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

export function useOutboxEntry(projectId: string, outboxId: string) {
  return useQuery({
    queryKey: queryKeys.outboxEntry(projectId, outboxId),
    queryFn: () => api.get<OutboxEntry>(`/v1/projects/${projectId}/outbox/${outboxId}`),
    enabled: Boolean(projectId && outboxId),
  });
}

/**
 * What a requeue changes on THIS side of the wire.
 *
 * The row goes back to `pending` and its event goes `failed → received`, so
 * the event page, the events list and every outbox page are stale the moment
 * the request returns. The delivery list is invalidated too: the fan-out that
 * now runs writes delivery rows that did not exist a second ago.
 */
function invalidateAfterRequeue(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  eventIds: string[],
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.outboxRoot(projectId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.eventsRoot(projectId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.deliveriesRoot(projectId) });
  for (const eventId of eventIds) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.event(projectId, eventId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.eventDeliveries(projectId, eventId) });
  }
}

/**
 * `POST …/outbox/:outboxId/requeue` — one parked row back to the queue.
 *
 * Answers the row as it now stands. `attempts` and `last_error` are preserved
 * on purpose — the history is not erased by the recovery — and a 409 means the
 * row was not parked: `details.outbox_status` says whether a router already
 * has it or the fan-out already completed.
 */
export function useRequeueOutboxEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ outboxId, ...body }: RequeueOutboxBody & { outboxId: string }) =>
      api.post<OutboxEntry>(`/v1/projects/${projectId}/outbox/${outboxId}/requeue`, body),
    onSuccess: (entry) => invalidateAfterRequeue(queryClient, projectId, [entry.event_id]),
  });
}

/**
 * `POST …/outbox/requeue` — up to `MAX_REQUEUE_BATCH` parked rows, oldest
 * first. ONE pass. The caller reads `has_more` and decides whether to send
 * another; see `requeue-loop.ts` for why that decision is a person's.
 */
export function useRequeueParked(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RequeueParkedBody) =>
      api.post<RequeueResult>(`/v1/projects/${projectId}/outbox/requeue`, body),
    onSuccess: (result) =>
      invalidateAfterRequeue(
        queryClient,
        projectId,
        result.data.map((entry) => entry.event_id),
      ),
  });
}
