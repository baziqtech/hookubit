import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { booleanParam, offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateEndpointBody,
  CreatedEndpoint,
  Endpoint,
  EndpointSecret,
  OffsetPage,
  RotatedSecret,
  Subscription,
} from '../../types/api';

export interface EndpointListOptions {
  offset?: number;
  /**
   * Sent as the literal string `true`/`false`. The API compares the string
   * rather than coercing it, because `Boolean('false')` is `true` — which had
   * `?include_deleted=false` turning soft-deleted rows ON.
   */
  includeDeleted?: boolean;
}

export function useEndpoints(projectId: string, options: EndpointListOptions = {}) {
  const { offset = 0, includeDeleted } = options;
  return useQuery({
    queryKey: queryKeys.endpoints(projectId, offset, includeDeleted),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Endpoint>>(
          `/v1/projects/${projectId}/endpoints${queryString({
            ...pageParams(offset),
            include_deleted: booleanParam(includeDeleted),
          })}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * Creating an endpoint can succeed and still not give you a working endpoint.
 *
 * Without `endpoint-secrets.write` the response carries `secret: null` and
 * `secret_pending: true`, and the endpoint is PAUSED. The caller must surface
 * that — see `EndpointCreatedNotice`.
 */
export function useCreateEndpoint(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEndpointBody) =>
      api.post<CreatedEndpoint>(`/v1/projects/${projectId}/endpoints`, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.endpointsRoot(projectId) }),
  });
}

/** Secret METADATA. No read path can return a plaintext secret. */
export function useEndpointSecrets(endpointId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.endpointSecrets(endpointId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<EndpointSecret>>(
          `/v1/endpoints/${endpointId}/secrets${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(endpointId),
  });
}

/**
 * Rotation returns the plaintext once. Like the API key create, it is never put
 * in the query cache — only the metadata list is invalidated.
 */
export function useRotateSecret(endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { overlap_seconds?: number } = {}) =>
      api.post<RotatedSecret>(`/v1/endpoints/${endpointId}/secrets/rotate`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.endpointSecretsRoot(endpointId) });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
}

/** SPECULATIVE — no subscriptions module exists in the control API yet. */
export function useSubscriptions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.subscriptions(projectId),
    queryFn: async () =>
      (await api.get<{ data: Subscription[] }>(`/v1/projects/${projectId}/subscriptions`)).data,
    enabled: Boolean(projectId),
  });
}
