import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { offsetPage, type Paged } from '../../lib/pagination';
import type {
  ConfirmedDestination,
  CreateDestinationBody,
  NotificationDestination,
  UpdateDestinationBody,
} from '../../types/api';

const base = (projectId: string) => `/v1/projects/${projectId}/notification-destinations`;

/**
 * Where this project sends alerts.
 *
 * Readable by every role that can read the delivery record, because "who gets
 * told when this breaks?" is part of understanding what happened.
 */
export function useDestinations(projectId: string) {
  return useQuery({
    queryKey: queryKeys.notificationDestinations(projectId),
    queryFn: async (): Promise<Paged<NotificationDestination>> =>
      offsetPage(await api.get(base(projectId))),
    enabled: Boolean(projectId),
  });
}

export function useCreateDestination(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDestinationBody) =>
      api.post<NotificationDestination>(base(projectId), body),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.notificationDestinations(projectId) }),
  });
}

export function useUpdateDestination(projectId: string, destinationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDestinationBody) =>
      api.patch<NotificationDestination>(`${base(projectId)}/${destinationId}`, body),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.notificationDestinations(projectId) }),
  });
}

export function useDeleteDestination(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.delete<void>(`${base(projectId)}/${destinationId}`),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.notificationDestinations(projectId) }),
  });
}

/**
 * Resend the confirmation, with a NEW token.
 *
 * The old link may be sitting in a mailbox somebody no longer has access to,
 * which is very often exactly why the resend is being asked for.
 */
export function useResendConfirmation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.post<NotificationDestination>(`${base(projectId)}/${destinationId}/resend`, {}),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.notificationDestinations(projectId) }),
  });
}

/**
 * A test alert down the same path a real one takes.
 *
 * It is deliberately NOT recorded as a dispatch on the server, so sending one
 * neither satisfies nor triggers the grouping rule — a test must not make the
 * next real alert about the same thing disappear.
 */
export function useTestDestination(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.post<void>(`${base(projectId)}/${destinationId}/test`, {}),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.notificationDestinations(projectId) }),
  });
}

/**
 * Redeeming a confirmation link. UNAUTHENTICATED: the person who can read a
 * group address is very often not a member of the organization that added it.
 */
export function useConfirmDestination() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post<ConfirmedDestination>('/v1/notification-destinations/confirm', { token }),
  });
}
