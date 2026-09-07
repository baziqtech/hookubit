import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { pageParams, totalPage } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  AuditLogEntry,
  CursorPage,
  Member,
  Organization,
  Role,
  TotalPage,
  UsageSummary,
} from '../../types/api';

/**
 * Organizations and members return the THIRD envelope shape:
 * `{ data, total, limit, offset }` — a real total, but no `has_more` and no
 * `next_offset`. `totalPage()` derives both; nothing else may.
 */
export function useOrganizations(offset = 0) {
  return useQuery({
    queryKey: queryKeys.organizations(offset),
    queryFn: async () =>
      totalPage(
        await api.get<TotalPage<Organization>>(`/v1/organizations${queryString(pageParams(offset))}`),
      ),
  });
}

export function useOrganization(orgId: string) {
  return useQuery({
    queryKey: queryKeys.organization(orgId),
    queryFn: () => api.get<Organization>(`/v1/organizations/${orgId}`),
    enabled: Boolean(orgId),
  });
}

export function useMembers(orgId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.members(orgId, offset),
    queryFn: async () =>
      totalPage(
        await api.get<TotalPage<Member>>(
          `/v1/organizations/${orgId}/members${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(orgId),
  });
}

/**
 * Inviting is always `202 {"status":"accepted"}` — for an address that is
 * already a member, already has an account, or is unknown alike. Anything else
 * would let a member enumerate the platform. No member row appears until the
 * invitee redeems their token, so the list is NOT optimistically updated.
 */
export function useInviteMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      api.post<{ status: string }>(`/v1/organizations/${orgId}/members`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.membersRoot(orgId) }),
  });
}

/** SPECULATIVE — no audit module exists in the control API yet. */
export function useAuditLogs(orgId: string) {
  return useQuery({
    queryKey: queryKeys.auditLogs(orgId),
    queryFn: async () =>
      (await api.get<CursorPage<AuditLogEntry>>(`/v1/organizations/${orgId}/audit-logs`)).data,
    enabled: Boolean(orgId),
  });
}

/** SPECULATIVE — no usage module exists in the control API yet. */
export function useUsage(orgId: string) {
  return useQuery({
    queryKey: queryKeys.usage(orgId),
    queryFn: () => api.get<UsageSummary>(`/v1/organizations/${orgId}/usage`),
    enabled: Boolean(orgId),
  });
}
