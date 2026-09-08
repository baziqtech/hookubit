import { Navigate, useParams } from 'react-router-dom';
import { Async, Button, EmptyState } from '../components';
import { useOrganizations } from '../features/organizations/api';
import { useProjects } from '../features/projects/api';

/**
 * `/` and `/orgs` — send the operator to their first organization.
 *
 * The list comes from `GET /v1/organizations`. It used to be read off the
 * session, which `SessionResponseDto` does not carry: the session is `{ user }`
 * and nothing else, so `data.organizations.length` would have thrown on the
 * first real response.
 */
export function RootRedirect() {
  const organizations = useOrganizations();

  return (
    <Async query={organizations}>
      {(page) =>
        page.rows.length > 0 ? (
          <Navigate to={`/orgs/${page.rows[0].id}`} replace />
        ) : (
          <EmptyState
            title="No organizations"
            description="Your account is not a member of any organization yet."
          />
        )
      }
    </Async>
  );
}

/** `/orgs/:orgId` — the useful landing is a project, not an org summary page. */
export function OrganizationLanding() {
  const { orgId = '' } = useParams();
  const projects = useProjects(orgId);

  return (
    <Async query={projects}>
      {(page) =>
        page.rows.length > 0 ? (
          <Navigate to={`/orgs/${orgId}/projects/${page.rows[0].id}/overview`} replace />
        ) : (
          <EmptyState
            title="No projects yet"
            description="A project owns endpoints, subscriptions and the events published to them."
            action={<Button variant="primary">Create project</Button>}
          />
        )
      }
    </Async>
  );
}

export function NotFoundPage() {
  return (
    <EmptyState
      tone="error"
      title="Page not found"
      description="This route does not exist. Check the URL, or head back to your project overview."
    />
  );
}
