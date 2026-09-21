import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useOrganizations } from '../features/organizations/api';
import { CreateOrganizationDialog } from '../features/organizations/CreateOrganizationDialog';
import { useProjects } from '../features/projects/api';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { projectWriteGate } from '../features/projects/permissions';
import { deniedReason, mayAct } from '../lib/role-gate';
import { cn } from '../lib/cn';
import type { Paged } from '../lib/pagination';
import { Menu, MenuLabel } from './Menu';

/** Shared row styling so the switcher menu and the account menu look like one system. */
function itemClass(active: boolean): string {
  return cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
    active ? 'bg-nav-active text-nav-ink' : 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
  );
}

/**
 * The one card at the top of the rail: which project you are in, what kind of
 * project it is, and which organization owns it.
 *
 * ## Why one control and not two
 *
 * The rail used to stack an organization switcher above a project switcher,
 * which spent two rows and two clicks on a hierarchy the operator navigates in
 * one direction almost always: they switch project many times a day and
 * organization approximately never. So the card IS the project, the
 * organization is the line underneath it, and the menu carries both — projects
 * first because that is the frequent move, organizations in a section below it.
 *
 * ## Why the environment badge is not decoration
 *
 * `test` and `live` projects are permanently separate and the difference is
 * invisible everywhere else in the shell. Someone about to revoke a key, pause
 * an endpoint or replay a delivery needs the answer to "is this real traffic?"
 * on screen, not one click away. The API's enum is `test | live`; the word the
 * design shows for `live` is PRODUCTION, and it is mapped at this edge rather
 * than migrated in the database.
 */
export function ProjectCard({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const organizationPage = useOrganizations();
  const projectPage = useProjects(orgId);
  const navigate = useNavigate();

  const organizations = organizationPage.data?.rows;
  const projects = projectPage.data?.rows;
  const organization = organizations?.find((row) => row.id === orgId);
  const project = projects?.find((row) => row.id === projectId);

  const gate = projectWriteGate(organization);
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);

  return (
    <>
      <Menu
        label="Switch project or organization"
        className="w-full"
        chevron={false}
        triggerClassName="w-full rounded-lg bg-nav-hover px-2.5 py-2 text-left hover:bg-nav-active"
        trigger={
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-nav-ink">
                {projectPage.isPending ? 'Loading…' : (project?.name ?? 'Select project')}
              </span>
              <SwitchGlyph />
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              {project && <EnvironmentBadge environment={project.environment} />}
              <span className="min-w-0 truncate text-2xs text-nav-ink-muted">
                {organization?.name ?? '—'}
              </span>
            </span>
          </span>
        }
      >
        {(close) => (
          <>
            <MenuLabel>Projects</MenuLabel>
            {projects?.length === 0 && (
              <p className="px-2 py-2 text-xs text-ink-subtle">No projects in this organization.</p>
            )}
            {projects?.map((row) => (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  // Land on Overview: switching project mid-detail-page would
                  // otherwise point at an ID that belongs to another tenant.
                  navigate(`/orgs/${orgId}/projects/${row.id}/overview`);
                }}
                className={itemClass(row.id === projectId)}
              >
                <span className="truncate">{row.name}</span>
                <EnvironmentBadge environment={row.environment} className="ml-auto" />
              </button>
            ))}
            <TruncationNote page={projectPage.data} noun="projects" />
            <button
              type="button"
              role="menuitem"
              disabled={!mayAct(gate)}
              aria-disabled={!mayAct(gate) || undefined}
              title={deniedReason(gate, 'Creating a project')}
              onClick={() => {
                close();
                setCreatingProject(true);
              }}
              className={cn(
                itemClass(false),
                'text-accent hover:text-accent',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              New project…
            </button>

            <div className="mt-1 border-t border-line pt-1">
              <MenuLabel>Organizations</MenuLabel>
              {organizations?.map((row) => (
                <Link
                  key={row.id}
                  to={`/orgs/${row.id}`}
                  role="menuitem"
                  onClick={close}
                  className={itemClass(row.id === orgId)}
                >
                  <span className="truncate">{row.name}</span>
                  {row.status !== 'active' && (
                    <span className="ml-auto rounded bg-danger-soft px-1.5 py-0.5 text-2xs font-semibold uppercase text-danger">
                      {row.status}
                    </span>
                  )}
                </Link>
              ))}
              <TruncationNote page={organizationPage.data} noun="organizations" />
              {/*
                Not role-gated: there is no organization to hold a role in yet.
                The per-account ceiling comes back as `limit_exceeded` in the
                dialog.
              */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  setCreatingOrganization(true);
                }}
                className={cn(itemClass(false), 'text-accent hover:text-accent')}
              >
                New organization…
              </button>
            </div>
          </>
        )}
      </Menu>
      <CreateProjectDialog
        orgId={orgId}
        open={creatingProject}
        onClose={() => setCreatingProject(false)}
      />
      <CreateOrganizationDialog
        open={creatingOrganization}
        onClose={() => setCreatingOrganization(false)}
      />
    </>
  );
}

/**
 * `live` reads as PRODUCTION and `test` as TEST, with a dot in front.
 *
 * The dot is not decoration: the design's rule is that no state is ever carried
 * by colour alone, and at 9.5px the word is doing most of the work anyway. Green
 * for production is the one place a status hue attaches to configuration rather
 * than to an outcome — it means "this is the real one", which is exactly the
 * thing worth a second of attention.
 */
export function EnvironmentBadge({
  environment,
  className,
}: {
  environment: 'test' | 'live';
  className?: string;
}) {
  const live = environment === 'live';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-bold tracking-wide',
        live ? 'bg-ok-soft text-ok' : 'bg-raised text-ink-muted',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1 w-1 rounded-full', live ? 'bg-ok-dot' : 'bg-ink-subtle')}
      />
      {live ? 'PRODUCTION' : 'TEST'}
    </span>
  );
}

function SwitchGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 text-nav-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 6.5 8 3.5l3 3M11 9.5 8 12.5l-3-3" />
    </svg>
  );
}

/**
 * A switcher shows one page, and the server may hold more.
 *
 * Silently listing the first page as if it were everything is the exact defect
 * `has_more` exists to expose — someone would conclude a project had been
 * deleted because it was not in the menu. So when there are more, say so.
 */
function TruncationNote({ page, noun }: { page?: Paged<unknown>; noun: string }) {
  if (!page?.hasMore) return null;
  return (
    <p className="border-t border-line px-2 py-1.5 text-2xs text-ink-subtle">
      Showing the first {page.rows.length} {noun}. More exist than fit in this menu.
    </p>
  );
}
