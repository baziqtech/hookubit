import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../components';
import { useOrganizations } from '../features/organizations/api';
import { CreateOrganizationDialog } from '../features/organizations/CreateOrganizationDialog';
import { useProjects } from '../features/projects/api';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { projectWriteGate } from '../features/projects/permissions';
import { deniedReason, mayAct } from '../lib/role-gate';
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
  const [creating, setCreating] = useState(false);
  const organizations = page?.rows;
  const current = organizations?.find((organization) => organization.id === orgId);

  return (
    <>
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
          {/*
            Any account may own more organizations (the API caps it per user),
            so this is not role-gated: there is no organization to hold a role
            in yet. The ceiling comes back as `limit_exceeded` in the dialog.
          */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              setCreating(true);
            }}
            className={cn(itemClass(false), 'mt-1 border-t border-line pt-2 text-accent hover:text-accent')}
          >
            New organization…
          </button>
        </>
      )}
    </Menu>
    <CreateOrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function ProjectSwitcher({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const { data: page, isPending } = useProjects(orgId);
  const projects = page?.rows;
  const navigate = useNavigate();
  const current = projects?.find((project) => project.id === projectId);
  // The "New project…" item is behind `projects.write` (owner or admin). The
  // organizations list is already loaded for the switcher above, so this is
  // served from cache. Unknown role → enabled; the server is the authority.
  const organizations = useOrganizations();
  const gate = projectWriteGate(
    organizations.data?.rows.find((organization) => organization.id === orgId),
  );
  const [creating, setCreating] = useState(false);

  return (
    <>
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
          <button
            type="button"
            role="menuitem"
            disabled={!mayAct(gate)}
            aria-disabled={!mayAct(gate) || undefined}
            title={deniedReason(gate, 'Creating a project')}
            onClick={() => {
              close();
              setCreating(true);
            }}
            className={cn(
              itemClass(false),
              'mt-1 border-t border-line pt-2 text-accent hover:text-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            New project…
          </button>
        </>
      )}
    </Menu>
    <CreateProjectDialog orgId={orgId} open={creating} onClose={() => setCreating(false)} />
    </>
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
