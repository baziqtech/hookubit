import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  Member,
  OffsetPage,
  Organization,
  Role,
  UpdateOrganizationBody,
  UsageSummary,
} from '../../types/api';

/**
 * `OrganizationListDto` is `{ data, has_more, next_offset }` like every other
 * list route. It used to be `{ data, total, limit, offset }` and was still
 * being read that way — `total` was rendered in the pager and is simply not
 * there, so the range read "1–3 of undefined". See HANDOFF.md.
 */
export function useOrganizations(offset = 0) {
  return useQuery({
    queryKey: queryKeys.organizations(offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Organization>>(
          `/v1/organizations${queryString(pageParams(offset))}`,
        ),
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

/**
 * `PATCH /v1/organizations/:orgId` — name and slug.
 *
 * `status` is not accepted: suspension is a platform and billing decision, and
 * a writable status would let a customer un-suspend their own unpaid
 * organization. Deleting has its own owner-gated route.
 *
 * Both the row AND the list are invalidated. The organization switcher, the
 * breadcrumb and the session all read `useOrganizations()`, so a rename that
 * dropped only `organization(orgId)` would leave the old name in the sidebar
 * until a reload — which reads as the save having failed.
 */
export function useUpdateOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOrganizationBody) =>
      api.patch<Organization>(`/v1/organizations/${orgId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.organization(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizationsRoot() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });
}

export function useMembers(orgId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.members(orgId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<Member>>(
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

/**
 * MOCK-ONLY. `GET /v1/organizations/:orgId/usage` IS NOT IN THE OPENAPI
 * DOCUMENT — there is no usage or billing module. Against the real transport
 * this 404s, so `UsagePage` refuses to run it and says so.
 */
export function useUsage(orgId: string) {
  return useQuery({
    queryKey: queryKeys.usage(orgId),
    queryFn: () => api.get<UsageSummary>(`/v1/organizations/${orgId}/usage`),
    enabled: Boolean(orgId),
  });
}
