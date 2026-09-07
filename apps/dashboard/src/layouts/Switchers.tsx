import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../components';
import { useOrganizations } from '../features/organizations/api';
import { useProjects } from '../features/projects/api';
import { cn } from '../lib/cn';
import type { Paged } from '../lib/pagination';
import { Menu, MenuLabel } from './Menu';

/** Shared row styling so both switchers and the user menu look like one system. */
function itemClass(active: boolean): string {
  return cn(
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors',
    active ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-raised hover:text-ink',
  );
}

export function OrganizationSwitcher({ orgId }: { orgId: string }) {
  const { data: page, isPending } = useOrganizations();
  const organizations = page?.rows;
  const current = organizations?.find((organization) => organization.id === orgId);

  return (
    <Menu
      label="Switch organization"
      className="min-w-0 flex-1"
      trigger={
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent text-2xs font-bold text-accent-ink"
          >
            {(current?.name ?? '?').charAt(0)}
          </span>
          <span className="truncate font-medium text-ink">
            {isPending ? 'Loading…' : (current?.name ?? 'Select organization')}
          </span>
        </span>
      }
    >
      {(close) => (
        <>
          <MenuLabel>Organizations</MenuLabel>
          {organizations?.map((organization) => (
            <Link
              key={organization.id}
              to={`/orgs/${organization.id}`}
              role="menuitem"
              onClick={close}
              className={itemClass(organization.id === orgId)}
            >
              <span className="truncate">{organization.name}</span>
              <Badge
                tone={organization.status === 'active' ? 'neutral' : 'danger'}
                className="ml-auto capitalize"
              >
                {organization.status}
              </Badge>
            </Link>
          ))}
          <TruncationNote page={page} noun="organizations" />
        </>
      )}
    </Menu>
  );
}

export function ProjectSwitcher({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const { data: page, isPending } = useProjects(orgId);
  const projects = page?.rows;
  const navigate = useNavigate();
  const current = projects?.find((project) => project.id === projectId);

  return (
    <Menu
      label="Switch project"
      className="min-w-0 flex-1"
      trigger={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ink">
            {isPending ? 'Loading…' : (current?.name ?? 'Select project')}
          </span>
          {/* `environment` is `test | live` — there is no "production". */}
          {current && (
            <Badge tone={current.environment === 'live' ? 'ok' : 'neutral'}>
              {current.environment}
            </Badge>
          )}
        </span>
      }
    >
      {(close) => (
        <>
          <MenuLabel>Projects</MenuLabel>
          {projects?.length === 0 && (
            <p className="px-2 py-2 text-xs text-ink-subtle">No projects in this organization.</p>
          )}
          {projects?.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                // Land on Overview: switching project mid-detail-page would
                // otherwise point at an ID that belongs to another tenant.
                navigate(`/orgs/${orgId}/projects/${project.id}/overview`);
              }}
              className={itemClass(project.id === projectId)}
            >
              <span className="truncate">{project.name}</span>
              <Badge
                tone={project.environment === 'live' ? 'ok' : 'neutral'}
                className="ml-auto"
              >
                {project.environment}
              </Badge>
            </button>
          ))}
          <TruncationNote page={page} noun="projects" />
        </>
      )}
    </Menu>
  );
}

/**
 * A switcher shows one page, and the server may hold more.
 *
 * Silently listing the first page as if it were everything is the exact defect
 * `has_more` exists to expose — someone would conclude a project had been
 * deleted because it was not in the menu. So when there are more, say so and
 * point at the full list.
 */
function TruncationNote({ page, noun }: { page?: Paged<unknown>; noun: string }) {
  if (!page?.hasMore) return null;
  return (
    <p className="border-t border-line px-2 py-1.5 text-2xs text-ink-subtle">
      Showing the first {page.rows.length} {noun}. More exist than fit in this menu.
    </p>
  );
}
