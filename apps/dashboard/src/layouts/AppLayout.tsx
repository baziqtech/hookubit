import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ThemeToggle } from '../components';
import { useLogout, useSession } from '../features/auth/api';
import { useSetupState } from '../features/onboarding/api';
import { ProductTour } from '../features/onboarding/ProductTour';
import { setupProgress } from '../features/onboarding/setup';
import { useTourStore } from '../features/onboarding/tour-store';
import { useOrganizations } from '../features/organizations/api';
import { useProject } from '../features/projects/api';
import { cn } from '../lib/cn';
import { HookGlyph, WordmarkText } from '../features/auth/Wordmark';
import { Menu, MenuLabel } from './Menu';
import { NavIcon } from './nav-icons';
import { currentSectionLabel, navigationGroups, type NavGroup, type NavItem } from './navigation';
import { EnvironmentBadge, ProjectCard } from './Switchers';

/**
 * The application shell: a persistent left rail carrying the brand, the project
 * card and the grouped navigation, a topbar that answers "where am I" and
 * carries the two controls that belong to the view rather than to the page, and
 * an outlet that fills the rest. Density is the point — an operator is here to
 * scan tables, not to admire chrome.
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
        <Topbar orgId={orgId} projectId={projectId} />
        <main id="main" className="min-w-0 flex-1 px-6 py-5">
          <Outlet />
        </main>
      </div>
      <ProductTour />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------

/**
 * Organization › Project › Section, and the two controls that belong to the
 * VIEW rather than to the page under it.
 *
 * The hierarchy is three levels deep and it is in the URL, so it should be on
 * the screen: without this, "which project am I about to revoke a key in?" is
 * answered by a truncated line in the sidebar. The org and project segments are
 * links to their landing pages, not menus — switching lives in the rail, and
 * offering it twice would make neither affordance obviously the one to use.
 */
function Topbar({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const { pathname } = useLocation();
  const organizations = useOrganizations();
  const project = useProject(orgId, projectId ?? '');

  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const section = currentSectionLabel(pathname, orgId, projectId);

  return (
    <header className="sticky top-0 z-20 flex h-[3.25rem] shrink-0 items-center gap-4 border-b border-line bg-canvas/95 pl-5 pr-4 backdrop-blur">
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-xs">
          <Crumb to={`/orgs/${orgId}`} label={organization?.name ?? 'Organization'} />
          {projectId && (
            <>
              <Separator />
              <Crumb
                to={`/orgs/${orgId}/projects/${projectId}/overview`}
                label={project.data?.name ?? 'Project'}
                badge={
                  project.data && <EnvironmentBadge environment={project.data.environment} />
                }
              />
            </>
          )}
          {section && (
            <>
              <Separator />
              <li className="truncate font-semibold text-ink" aria-current="page">
                {section}
              </li>
            </>
          )}
        </ol>
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        <CopyLinkButton />
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * "Copy link to this view."
 *
 * Every route in this product is fully addressable — tenancy, filters and the
 * open detail row are all in the URL, which is the whole reason the router is
 * shaped the way it is. This is the one control that makes that property
 * usable: the alternative is describing a filtered deliveries view in prose in
 * an incident channel, and being misunderstood.
 *
 * It confirms in place rather than with a toast. A toast for a clipboard write
 * is an interruption for something the operator already knows they did; the
 * label changing under their cursor is enough, and it cannot cover anything.
 */
function CopyLinkButton() {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        // `writeText` rejects on an insecure origin and in a window without
        // focus. Failing silently is right: the link is still in the address
        // bar, and an error toast about a convenience is worse than nothing.
        void navigator.clipboard?.writeText(window.location.href).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          },
          () => undefined,
        );
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
        copied ? 'text-ok' : 'text-ink-muted hover:bg-raised hover:text-ink',
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {copied ? (
          <path d="m5 13 4 4L19 7" />
        ) : (
          <>
            <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
            <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
          </>
        )}
      </svg>
      {copied ? 'Copied' : 'Copy link to this view'}
    </button>
  );
}

function Crumb({ to, label, badge }: { to: string; label: string; badge?: ReactNode }) {
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

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function Sidebar({ orgId, projectId }: { orgId: string; projectId?: string }) {
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 flex h-screen w-[14.75rem] shrink-0 flex-col border-r border-nav-line bg-nav"
    >
      <div className="flex items-center gap-2.5 px-4 pb-3.5 pt-4">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-[0.4375rem] bg-accent text-accent-ink"
        >
          <HookGlyph className="h-4 w-4" />
        </span>
        <WordmarkText className="text-sm" />
      </div>

      <div className="px-3 pb-3">
        <ProjectCard orgId={orgId} projectId={projectId} />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2.5 pb-2">
        <RailGroups orgId={orgId} projectId={projectId} />
      </div>

      <div className="flex flex-col gap-2 px-2.5 pb-2.5">
        <TourButton />
        <UserCard orgId={orgId} />
      </div>
    </nav>
  );
}

/**
 * The groups, with a progress badge on Setup.
 *
 * The badge is the whole reason this is not a plain `.map`. A new project needs
 * six things before a webhook can flow, and an operator who does not know that
 * has no reason to click a nav item called Setup. "2/6" says there is
 * outstanding work and exactly how much, without a modal, a banner or a nag —
 * and it disappears of its own accord when the work is done, which is the
 * property a dismissible banner does not have.
 */
function RailGroups({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const groups = navigationGroups(orgId, projectId);
  const setup = useSetupState(orgId, projectId ?? '');

  // Only once the inputs have actually loaded. A badge that reads "0/6" for a
  // moment on every navigation would be alarming and wrong.
  const progress = projectId && !setup.isPending && !setup.isError ? setupProgress(setup.steps) : null;
  const badges =
    progress && progress.done < progress.total
      ? { [`/orgs/${orgId}/projects/${projectId}/get-started`]: `${progress.done}/${progress.total}` }
      : undefined;

  return (
    <>
      {groups.map((group, index) => (
        <RailGroup key={group.title ?? `_${index}`} group={group} badges={badges} />
      ))}
    </>
  );
}

function RailGroup({
  group,
  badges,
}: {
  group: NavGroup;
  /** Route → short counter rendered at the end of the row. */
  badges?: Record<string, string>;
}) {
  return (
    <div>
      {group.title && (
        <p className="px-2 pb-1 pt-3 text-2xs font-bold uppercase tracking-wider text-nav-section">
          {group.title}
        </p>
      )}
      <ul className="flex flex-col gap-px">
        {group.items.map((item) => (
          <li key={item.to}>
            <RailLink item={item} badge={badges?.[item.to]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RailLink({ item, badge }: { item: NavItem; badge?: string }) {
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors',
          isActive
            ? 'bg-nav-active font-semibold text-accent-deep'
            : 'font-medium text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
        )
      }
    >
      <NavIcon name={item.icon} className="h-[0.9375rem] w-[0.9375rem] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge && (
        <span className="shrink-0 rounded bg-accent px-1.5 py-px text-2xs font-bold tabular text-accent-ink">
          {badge}
        </span>
      )}
    </NavLink>
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
    <button
      type="button"
      onClick={openTour}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs font-medium text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink"
    >
      <NavIcon name="tour" className="h-[0.9375rem] w-[0.9375rem] shrink-0" />
      Product tour
    </button>
  );
}

/**
 * The account card at the foot of the rail: who you are and what you are.
 *
 * The role is on the card rather than only inside the menu because it is the
 * answer to "why is that button greyed out?", and that question is asked while
 * looking at the greyed-out button, not while looking for a menu.
 */
function UserCard({ orgId }: { orgId: string }) {
  const { data: session } = useSession();
  const organizations = useOrganizations();
  const logout = useLogout();
  const navigate = useNavigate();

  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const name = session?.user.name ?? 'Account';

  return (
    <Menu
      label="Account menu"
      placement="top"
      chevron={false}
      className="w-full"
      triggerClassName="w-full rounded-lg bg-nav-hover px-2 py-2 text-left hover:bg-nav-active"
      trigger={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Initials name={name} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-semibold text-nav-ink">{name}</span>
            <span className="truncate text-2xs font-medium capitalize text-nav-ink-muted">
              {organization?.role ?? '—'}
            </span>
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 shrink-0 text-nav-ink-muted"
            fill="currentColor"
          >
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </span>
      }
    >
      {(close) => (
        <>
          <MenuLabel>Signed in as</MenuLabel>
          <p className="truncate px-2 pb-1.5 text-xs text-ink">{session?.user.email ?? '—'}</p>

          {organization && (
            <div className="my-1 border-t border-line pt-2">
              <MenuLabel>Your role in {organization.name}</MenuLabel>
              <p className="px-2 pb-1.5 text-xs capitalize text-ink">{organization.role}</p>
            </div>
          )}

          {/*
            A setting, not an action, so it is not a `menuitem` and clicking it
            does not close the menu — you want to see the theme change while you
            are still looking at the control that changed it.
          */}
          <div className="my-1 border-t border-line pt-2">
            <MenuLabel>Theme</MenuLabel>
            <div className="px-2 pb-1.5 pt-0.5">
              <ThemeToggle className="w-full" />
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              // Leave explicitly. Clearing the query cache does not, by itself,
              // re-run the session check the guard is waiting on, so without
              // this the shell stayed on screen, signed out, with an empty page
              // under it.
              logout.mutate(undefined, {
                onSuccess: () => navigate('/login', { replace: true }),
              });
            }}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            Sign out
          </button>
        </>
      )}
    </Menu>
  );
}

/** Up to two initials, because one letter in a circle is every internal tool. */
function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <span
      aria-hidden="true"
      className="flex h-[1.625rem] w-[1.625rem] shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-bold text-accent-deep"
    >
      {letters || '?'}
    </span>
  );
}
