import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type {
  CreateOrganizationBody,
  Member,
  OffsetPage,
  Organization,
  Role,
  UpdateMemberRoleBody,
  UpdateOrganizationBody,
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

/**
 * `POST /v1/organizations` — a second (third, …) organization for the same
 * account, with the caller as its owner. Capped per USER (the ceiling answers
 * `limit_exceeded`), and the slug namespace is global: a derived slug that
 * collides is suffixed server-side, an explicit one that collides is a 409.
 *
 * The list and the session are invalidated because the switcher, the
 * breadcrumb and `RootRedirect` read the list, and the new organization must
 * be on it before the caller navigates into it.
 */
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrganizationBody) =>
      api.post<Organization>('/v1/organizations', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizationsRoot() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
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

/**
 * `DELETE /v1/organizations/:orgId` — owner ONLY, and a SOFT delete.
 *
 * The route is declared `projects.write` and the service then refuses anyone
 * whose role is not `owner` with a 403 — an admin holds the permission and is
 * still turned away. In one transaction it soft-deletes every project that is
 * not already deleted, then the organization; so the ingest path stops
 * accepting every project's keys at once, the delivery ledger and the member
 * rows are KEPT (its foreign keys are ON DELETE RESTRICT), and afterwards
 * every route under the organization answers 404 for every member. Audited
 * as `organization.deleted` with the count of projects taken down. There is
 * no undelete.
 *
 * Answers 204. The organizations list and the session are dropped so the
 * switcher and `RootRedirect` stop offering the organization that is gone.
 */
export function useDeleteOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/v1/organizations/${orgId}`),
    onSuccess: () => {
      // Removed, not invalidated: `RootRedirect` sends the operator to the
      // first organization in the list it reads, and a cached list would
      // still name the one just deleted. See useDeleteProject.
      queryClient.removeQueries({ queryKey: queryKeys.organizationsRoot() });
      queryClient.removeQueries({ queryKey: queryKeys.organization(orgId) });
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
 * `PATCH /v1/organizations/:orgId/members/:memberId` with `{ role }`.
 *
 * The lattice is enforced server-side inside the writing transaction: never
 * your own membership, never a role above your own rank, never someone who
 * outranks you (all 403 `forbidden`), and never the last owner (409
 * `conflict`, counted in the same transaction so two concurrent demotions
 * cannot leave zero). The client mirrors those rules in `team/lattice.ts` to
 * explain a greyed-out control; the server's sentence is what is shown when
 * it refuses anyway.
 *
 * Every page of the member list is invalidated. The caller's own role cannot
 * move here (changing it is refused), so `OrganizationDto.role` is left alone.
 */
export function useUpdateMemberRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api.patch<Member>(`/v1/organizations/${orgId}/members/${memberId}`, {
        role,
      } satisfies UpdateMemberRoleBody),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.membersRoot(orgId) }),
  });
}

/**
 * `DELETE /v1/organizations/:orgId/members/:memberId` — a HARD delete of the
 * membership row (nothing in the delivery ledger hangs off it; the audit row
 * naming the removed user survives). Same lattice as a role change, last-owner
 * rule included: 403 from the lattice, 409 if it would leave no owner.
 */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      api.delete<void>(`/v1/organizations/${orgId}/members/${memberId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.membersRoot(orgId) }),
  });
}
