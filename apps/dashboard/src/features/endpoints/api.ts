import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { booleanParam, offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateEndpointBody,
  CreatedEndpoint,
  DisableEndpointBody,
  Endpoint,
  EndpointSecret,
  OffsetPage,
  RotatedSecret,
  Subscription,
  UpdateEndpointBody,
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

/**
 * One endpoint. Used by the delivery detail page to cross-check the endpoint's
 * own health against the delivery's status — a delivery can report "retrying"
 * while the endpoint it targets has been auto-disabled by the circuit breaker,
 * in which case no retry is actually going to run and the operator must be
 * told so rather than left waiting.
 *
 * NESTED UNDER THE PROJECT. `EndpointsController` is mounted at
 * `projects/:projectId/endpoints`, and the project id in the path is what
 * `TenantResolver` reads the organization off — so there is no top-level
 * `/v1/endpoints/:id` route and a request to one would have 404'd against the
 * real API. (`/v1/endpoints/:id/secrets` IS top-level: `EndpointSecretsController`
 * is mounted separately. The asymmetry is real, not a typo.)
 */
export function useEndpoint(projectId: string, endpointId: string) {
  return useQuery({
    queryKey: queryKeys.endpoint(endpointId),
    queryFn: () => api.get<Endpoint>(`/v1/projects/${projectId}/endpoints/${endpointId}`),
    enabled: Boolean(projectId && endpointId),
  });
}

/**
 * Everything a mutation on one endpoint has to drop from the cache.
 *
 * The endpoint's own row, EVERY page of the project's endpoint list (a paged
 * list caches each offset under its own key), and the project queries the
 * first-run checklist composes its state from. Missing the list is how the
 * breaker warning on the delivery page clears while the Endpoints table still
 * shows `auto-disabled`, and missing the checklist is how "endpoint" stays
 * amber after the operator has fixed it.
 */
function useEndpointInvalidation(projectId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.endpoint(endpointId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.endpointsRoot(projectId) });
  };
}

/**
 * `PATCH /v1/projects/:projectId/endpoints/:endpointId`.
 *
 * `status` is not writable here and the body type does not carry it: enabling,
 * disabling and deleting are separate routes because each has a precondition a
 * PATCH would walk straight past.
 *
 * The URL and the custom headers are re-validated on update with the same rules
 * as on create — the SSRF usability mirror and the reserved-header list — so a
 * caller must be ready for a 400 that names a field. `classifyWriteError` turns
 * those into `issues` a form can place under the right input.
 */
export function useUpdateEndpoint(projectId: string, endpointId: string) {
  const invalidate = useEndpointInvalidation(projectId, endpointId);
  return useMutation({
    mutationFn: (body: UpdateEndpointBody) =>
      api.patch<Endpoint>(`/v1/projects/${projectId}/endpoints/${endpointId}`, body),
    onSuccess: invalidate,
  });
}

/**
 * `POST …/enable` — resume deliveries.
 *
 * Refused with a 409 when the endpoint has no active signing secret. That is
 * not a quirk to paper over: the data plane fails closed rather than delivering
 * unsigned, so enabling would queue failures instead of deliveries. Surface the
 * conflict.
 */
export function useEnableEndpoint(projectId: string, endpointId: string) {
  const invalidate = useEndpointInvalidation(projectId, endpointId);
  return useMutation({
    mutationFn: () =>
      api.post<Endpoint>(`/v1/projects/${projectId}/endpoints/${endpointId}/enable`),
    onSuccess: invalidate,
  });
}

/**
 * `POST …/disable` — pause deliveries, without discarding what is queued.
 *
 * The reason is written to the audit log, which is how the delivery gap gets
 * explained later. The breaker's own `disabled_reason`/`disabled_at` are left
 * untouched, so "the platform stopped this" and "a person stopped this" stay
 * separable afterwards.
 */
export function useDisableEndpoint(projectId: string, endpointId: string) {
  const invalidate = useEndpointInvalidation(projectId, endpointId);
  return useMutation({
    mutationFn: (body: DisableEndpointBody = {}) =>
      api.post<Endpoint>(`/v1/projects/${projectId}/endpoints/${endpointId}/disable`, body),
    onSuccess: invalidate,
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

/**
 * `GET /v1/projects/:projectId/subscriptions` — a real module, offset paged
 * like everything else. It used to be read as a bare `{ data }` array, which
 * would have silently truncated at the page size.
 *
 * A row carries `endpoint_id` and NOT `endpoint_name`, and its filter field is
 * `payload_filter`, not `filter`. Callers wanting a name join against
 * `useEndpoints`.
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
