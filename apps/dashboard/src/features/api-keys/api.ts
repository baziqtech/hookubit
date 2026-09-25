import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { ApiKey, CreatedApiKey, OffsetPage } from '../../types/api';

/**
 * `enabled` follows `useEndpointSecrets`: a caller that already knows the role
 * lacks `api-keys.read` passes `false` rather than issuing a 403 it will then
 * have to explain. Reading a key INVENTORY is owner/admin/developer — a viewer
 * and a billing member are refused, and `lib/api.ts` never retries a 403, so an
 * un-gated caller keeps an errored query for the life of the tab.
 */
export function useApiKeys(projectId: string, offset = 0, enabled = true) {
  return useQuery({
    queryKey: queryKeys.apiKeys(projectId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<ApiKey>>(
          `/v1/projects/${projectId}/api-keys${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(projectId) && enabled,
  });
}

/**
 * Creating a key returns the plaintext EXACTLY ONCE.
 *
 * The plaintext is deliberately NOT written into the query cache, and the list
 * query is invalidated rather than patched with the create response — a cache
 * entry holding a live credential would survive navigation, be visible to the
 * React Query devtools and be serialised by any future cache persister. The
 * caller holds it in component state for as long as the reveal dialog is open,
 * and nowhere else.
 */
export function useCreateApiKey(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<CreatedApiKey>(`/v1/projects/${projectId}/api-keys`, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeysRoot(projectId) }),
  });
}

export function useRevokeApiKey(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKeyId: string) =>
      api.post<ApiKey>(`/v1/projects/${projectId}/api-keys/${apiKeyId}/revoke`),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeysRoot(projectId) }),
  });
}
