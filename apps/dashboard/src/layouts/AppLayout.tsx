import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Badge, ThemeToggle } from '../components';
import { useLogout, useSession } from '../features/auth/api';
import { useSetupState } from '../features/onboarding/api';
import { ProductTour } from '../features/onboarding/ProductTour';
import { isSetupComplete } from '../features/onboarding/setup';
import { useTourStore } from '../features/onboarding/tour-store';
import { useOrganizations } from '../features/organizations/api';
import { useProject } from '../features/projects/api';
import { cn } from '../lib/cn';
import { HookGlyph } from '../features/auth/Wordmark';
import { Menu, MenuLabel } from './Menu';
import { currentSectionLabel, organizationNav, projectNav, type NavItem } from './navigation';
import { OrganizationSwitcher, ProjectSwitcher } from './Switchers';

/**
 * The application shell: a persistent left rail carrying the two switchers and
 * the navigation, a breadcrumb bar that answers "where am I", and an outlet
 * that fills the rest. Density is the point — an operator is here to scan
 * tables, not to admire chrome.
 *
 * The tour is mounted HERE rather than on a route, so it survives navigation:
 * it is non-blocking by design, and someone reading step 2 can click into
 * Deliveries to look at what it just described without losing their place.
 * Whether it opens on its own is the tour's decision, made against the
 * session's `onboarding_completed_at` — see `ProductTour`.
 */
export function AppLayout() {
  const { orgId = '', projectId } = useParams();

  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar orgId={orgId} projectId={projectId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Breadcrumbs orgId={orgId} projectId={projectId} />
        <main id="main" className="min-w-0 flex-1 px-6 py-5">
          <Outlet />
        </main>
      </div>
      <ProductTour />
    </div>
  );
}

/**
 * Organization › Project › Section.
 *
 * The hierarchy is three levels deep and it is in the URL, so it should be on
 * the screen: without this, "which project am I about to revoke a key in?" is
 * answered by a truncated line in the sidebar. The org and project segments are
 * links to their landing pages, not menus — switching lives in the sidebar, and
 * offering it twice would make neither affordance obviously the one to use.
 */
function Breadcrumbs({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const { pathname } = useLocation();
  const organizations = useOrganizations();
  const project = useProject(orgId, projectId ?? '');

  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const section = currentSectionLabel(pathname, orgId, projectId);

  return (
    <nav
      aria-label="Breadcrumb"
      className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-canvas/95 px-6 backdrop-blur"
    >
      <ol className="flex min-w-0 items-center gap-1.5 text-xs">
        <Crumb to={`/orgs/${orgId}`} label={organization?.name ?? 'Organization'} />
        {projectId && (
          <>
            <Separator />
            <Crumb
              to={`/orgs/${orgId}/projects/${projectId}/overview`}
              label={project.data?.name ?? 'Project'}
              badge={
                project.data && (
                  <Badge tone={project.data.environment === 'live' ? 'ok' : 'neutral'}>
                    {project.data.environment}
                  </Badge>
                )
              }
            />
          </>
        )}
        {section && (
          <>
            <Separator />
            <li className="truncate font-medium text-ink" aria-current="page">
              {section}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

function Crumb({
  to,
  label,
  badge,
}: {
  to: string;
  label: string;
  badge?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <Link to={to} className="truncate text-ink-muted transition-colors hover:text-ink">
        {label}
      </Link>
      {badge}
    </li>
  );
}

function Separator() {
  return (
    <li aria-hidden="true" className="text-ink-subtle">
      /
    </li>
  );
}

function Sidebar({ orgId, projectId }: { orgId: string; projectId?: string }) {
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-nav"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-3">
        <Wordmark />
      </div>

      <div className="flex flex-col gap-1 border-b border-line p-2">
        <OrganizationSwitcher orgId={orgId} />
        <ProjectSwitcher orgId={orgId} projectId={projectId} />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {projectId ? (
          <ProjectNavSection orgId={orgId} projectId={projectId} />
        ) : (
          <p className="px-2 py-2 text-xs text-ink-subtle">
            Select a project to see events and deliveries.
          </p>
        )}
        <NavSection title="Organization" items={organizationNav(orgId)} className="mt-4" />
      </div>

      <TourButton />
      <UserMenu />
    </nav>
  );
}

/**
 * Project navigation, with an unfinished-setup marker on Get started.
 *
 * The marker is the whole reason this is not just `NavSection`: a new project
 * needs five things before a webhook can flow, and an operator who does not
 * know that has no reason to click a nav item called "Get started". A dot that
 * clears itself when the work is done says "there is something outstanding
 * here" without a modal, a banner, or a nag.
 */
function ProjectNavSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const setup = useSetupState(orgId, projectId);
  const incomplete = !setup.isPending && !setup.isError && !isSetupComplete(setup.steps);

  const items = projectNav(orgId, projectId);
  return (
    <NavSection
      title="Project"
      items={items}
      markers={incomplete ? { [items[0].to]: 'Setup incomplete' } : undefined}
    />
  );
}

function NavSection({
  title,
  items,
  className,
  markers,
}: {
  title: string;
  items: NavItem[];
  className?: string;
  /** Route → accessible description of an outstanding-work dot. */
  markers?: Record<string, string>;
}) {
  return (
    <div className={className}>
      <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
        {title}
      </p>
      <ul className="flex flex-col gap-px">
        {items.map((item) => {
          const marker = markers?.[item.to];
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors',
                    isActive
                      ? 'bg-accent-soft font-medium text-ink'
                      : 'text-ink-muted hover:bg-raised hover:text-ink',
                  )
                }
              >
                <span className="truncate">{item.label}</span>
                {marker && (
                  <>
                    <span
                      aria-hidden="true"
                      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
                    />
                    <span className="sr-only">({marker})</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Re-opening the tour.
 *
 * Someone who skips on day one may want it on day three, so the tour must not
 * be a one-shot. It sits with the account controls rather than in the primary
 * nav because it is help, not a destination.
 */
function TourButton() {
  const openTour = useTourStore((state) => state.openTour);

  return (
    <div className="border-t border-line p-2">
      <button
        type="button"
        onClick={openTour}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-2xs font-semibold"
        >
          ?
        </span>
        Product tour
      </button>
    </div>
  );
}

function UserMenu() {
  const { data: session } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="border-t border-line p-2">
      <Menu
        label="Account menu"
        placement="top"
        trigger={
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-2xs font-medium text-ink-muted"
            >
              {(session?.user.name ?? '?').charAt(0)}
            </span>
            <span className="truncate text-ink-muted">{session?.user.name ?? 'Account'}</span>
          </span>
        }
      >
        {(close) => (
          <>
            <MenuLabel>Signed in as</MenuLabel>
            <p className="truncate px-2 pb-1.5 text-xs text-ink">{session?.user.email ?? '—'}</p>

            {/*
              A setting, not an action, so it is not a `menuitem` and clicking
              it does not close the menu — you want to see the theme change
              while you are still looking at the control that changed it.
            */}
            <div className="my-1 border-t border-line pt-2">
              <MenuLabel>Theme</MenuLabel>
              <div className="px-2 pb-1.5 pt-0.5">
                <ThemeToggle className="w-full justify-between" />
              </div>
            </div>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                // Leave explicitly. Clearing the query cache does not, by
                // itself, re-run the session check the guard is waiting on,
                // so without this the shell stayed on screen, signed out,
                // with an empty page under it.
                logout.mutate(undefined, {
                  onSuccess: () => navigate('/login', { replace: true }),
                });
              }}
              className="flex w-full items-center rounded px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            >
              Sign out
            </button>
          </>
        )}
      </Menu>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center rounded bg-accent text-accent-ink"
      >
        <HookGlyph className="h-3.5 w-3.5" />
      </span>
      <span className="text-xs font-semibold tracking-tight">HookuBit</span>
    </span>
  );
}
