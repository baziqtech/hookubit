import { Navigate, useParams } from 'react-router-dom';
import { Async } from '../../components';
import { useProjects } from '../projects/api';
import type { AnalyticsWindowKey } from './window';

/**
 * `/orgs/:orgId/usage` — kept, because people bookmarked it.
 *
 * Usage is a tab on Analytics now, and Analytics is project-scoped, so this
 * route cannot simply be re-pointed: it has an organization in its path and no
 * project. It resolves the organization's first project — the same choice
 * `OrganizationLanding` makes — and lands on that project's Usage tab. The rows
 * themselves are organization-wide, so which project the address names changes
 * nothing about what the visitor came to read; it only decides which project
 * the Delivery tab beside it would describe.
 *
 * The window is pinned to `30d` on purpose. The old page had no selector and
 * was hard-coded to 720 hours, so a bookmark of it meant "the last 30 days by
 * project". Landing on the page's 24h default would quietly answer a different
 * question with the same-looking table.
 *
 * With no projects there is no usage and nothing to show: `/orgs/:orgId` is
 * where an operator in that position needs to be, and it already explains why
 * the organization is empty and offers the way out of it.
 */
const USAGE_BOOKMARK_WINDOW: AnalyticsWindowKey = '30d';

export function usageRedirectPath(orgId: string, projectId: string): string {
  return `/orgs/${orgId}/projects/${projectId}/analytics?tab=usage&window=${USAGE_BOOKMARK_WINDOW}`;
}

export function UsageRedirect() {
  const { orgId = '' } = useParams();
  const projects = useProjects(orgId);

  return (
    <Async query={projects}>
      {(page) =>
        page.rows.length > 0 ? (
          <Navigate to={usageRedirectPath(orgId, page.rows[0].id)} replace />
        ) : (
          <Navigate to={`/orgs/${orgId}`} replace />
        )
      }
    </Async>
  );
}
