import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { AuditLogEntry, OffsetPage } from '../../types/api';

/**
 * Filters `AuditLogsController` actually accepts. Everything here is optional;
 * an empty string means "not filtering" and is dropped by `queryString`.
 *
 * `action` and the date bounds are index-supported. `user_id`, `resource_type`
 * and `resource_id` are NOT — they are scans within the organization and date
 * range, per the controller's own documentation — which is why the UI pairs
 * them with a date range in its copy rather than offering them as free-standing
 * filters over all of history.
 */
export interface AuditFilters {
  action?: string;
  resource_type?: string;
  resource_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
}

/**
 * `GET /v1/organizations/:orgId/audit-logs`.
 *
 * Gated on `audit.read`, which owners and admins hold and a VIEWER DOES NOT —
 * a viewer holds `members.read`, which is a different permission, so the page
 * has to render a permission-denied state rather than an error. `retry: false`
 * is what makes that state appear promptly: retrying a 403 three times means
 * the operator watches a spinner for several seconds before being told they
 * were never going to be allowed.
 */
export function useAuditLogs(orgId: string, filters: AuditFilters = {}, offset = 0) {
  return useQuery({
    queryKey: queryKeys.auditLogs(orgId, filters as Record<string, string>, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<AuditLogEntry>>(
          `/v1/organizations/${orgId}/audit-logs${queryString({
            ...filters,
            ...pageParams(offset),
          })}`,
        ),
      ),
    enabled: Boolean(orgId),
    retry: false,
  });
}

/**
 * The actor, as the row can actually describe them.
 *
 * `AuditLogDto` carries `user_id` and `api_key_id` and NO email, name or actor
 * type — the nested `actor: { id, email, type }` the dashboard used to render
 * was invented. So this returns an id and the kind of principal it is, and the
 * page shows the id rather than pretending to a name it was not given. See
 * HANDOFF.md: an `actor_email` on the DTO is the fix, and it is a real gap —
 * "who disabled this endpoint" is the question the page exists for.
 */
export function describeActor(entry: AuditLogEntry): {
  kind: 'user' | 'api_key' | 'system';
  id: string | null;
} {
  if (entry.user_id) return { kind: 'user', id: entry.user_id };
  if (entry.api_key_id) return { kind: 'api_key', id: entry.api_key_id };
  return { kind: 'system', id: null };
}
