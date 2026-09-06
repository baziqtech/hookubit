import { Navigate, useParams } from 'react-router-dom';
import { Async, Button, EmptyState } from '../components';
import { useSession } from '../features/auth/api';
import { useProjects } from '../features/projects/api';

/** `/` and `/orgs` — send the operator to their first organization. */
export function RootRedirect() {
  const session = useSession();

  return (
    <Async query={session}>
      {(data) =>
        data.organizations.length > 0 ? (
          <Navigate to={`/orgs/${data.organizations[0].id}`} replace />
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
      {(data) =>
        data.length > 0 ? (
          <Navigate to={`/orgs/${orgId}/projects/${data[0].id}/overview`} replace />
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
