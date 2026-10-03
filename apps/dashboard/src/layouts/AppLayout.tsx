import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ThemeToggle } from '../components';
import { useLogout, useSession } from '../features/auth/api';
import { useSetupAffordance } from '../features/onboarding/api';
import { ProductTour } from '../features/onboarding/ProductTour';
import { setupProgress } from '../features/onboarding/setup';
import { useTourStore } from '../features/onboarding/tour-store';
import { useOrganizations } from '../features/organizations/api';
import { useProject } from '../features/projects/api';
import { cn } from '../lib/cn';
import { HookGlyph, WordmarkText } from '../features/auth/Wordmark';
import { Menu, MenuLabel } from './Menu';
import { NavIcon } from './nav-icons';
import {
  bottomNav,
  currentSectionLabel,
  navigationGroups,
  setupNavPath,
  type NavGroup,
  type NavItem,
} from './navigation';
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
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Close the slide-out on navigation. Without this, tapping a destination on
  // a phone leaves the sheet covering the page it just went to.
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen bg-canvas">
      {/*
        Three shapes, one rail.
        - Phone: off-canvas, opened from the topbar, over a scrim.
        - Tablet: icons only, because 236px of labels is a quarter of an 834px
          screen spent on navigation the operator already knows.
        - Desktop: labels.
      */}
      <Sidebar
        orgId={orgId}
        projectId={projectId}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-ink/40 md:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          orgId={orgId}
          projectId={projectId}
          onOpenNav={() => setNavOpen(true)}
        />
        {/*
          `pb-20` on a phone clears the bottom bar. Without it the last row of
          every table sits underneath it, which is invisible until somebody
          cannot press the thing they scrolled to.
        */}
        <main id="main" className="min-w-0 flex-1 px-4 py-4 pb-20 sm:px-6 sm:py-5 md:pb-5">
          <Outlet />
        </main>
      </div>

      {projectId && <BottomNav orgId={orgId} projectId={projectId} onMore={() => setNavOpen(true)} />}
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
function Topbar({
  orgId,
  projectId,
  onOpenNav,
}: {
  orgId: string;
  projectId?: string;
  onOpenNav: () => void;
}) {
  const { pathname } = useLocation();
  const organizations = useOrganizations();
  const project = useProject(orgId, projectId ?? '');

  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const section = currentSectionLabel(pathname, orgId, projectId);

  return (
    <header className="sticky top-0 z-20 flex h-[3.25rem] shrink-0 items-center gap-3 border-b border-line bg-canvas/95 pl-3 pr-4 backdrop-blur sm:gap-4 sm:pl-5">
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onOpenNav}
        className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-raised hover:text-ink md:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

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
      <span className="hidden lg:inline">{copied ? 'Copied' : 'Copy link to this view'}</span>
      <span className="lg:hidden sr-only">{copied ? 'Copied' : 'Copy link to this view'}</span>
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

function Sidebar({
  orgId,
  projectId,
  open,
  onClose,
}: {
  orgId: string;
  projectId?: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <nav
      aria-label="Primary"
      data-collapsed="tablet"
      className={cn(
        'z-40 flex h-screen shrink-0 flex-col border-r border-nav-line bg-nav',
        // Phone: off-canvas, full labels, because there is room for them once
        // it is over the page rather than beside it.
        'fixed inset-y-0 left-0 w-[14.75rem] transition-transform md:sticky md:top-0 md:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
        // Tablet: icons only. Desktop: labels.
        'md:w-14 xl:w-[14.75rem]',
      )}
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute right-2 top-3 flex h-7 w-7 items-center justify-center rounded-md text-nav-ink-muted hover:bg-nav-hover md:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>

      <div className="flex items-center gap-2.5 px-4 pb-3.5 pt-4 md:justify-center md:px-0 xl:justify-start xl:px-4">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-[0.4375rem] bg-accent text-accent-ink"
        >
          <HookGlyph className="h-4 w-4" />
        </span>
        <WordmarkText className="text-sm md:hidden xl:inline" />
      </div>

      {/*
        The project card carries two lines of text, so it has nothing to show
        in a 56px rail. At that width the breadcrumb above is where you read
        which project you are in, and switching is one tap wider.
      */}
      <div className="px-3 pb-3 md:hidden xl:block">
        <ProjectCard orgId={orgId} projectId={projectId} />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2.5 pb-2 md:px-2 xl:px-2.5">
        <RailGroups orgId={orgId} projectId={projectId} />
      </div>

      <div className="flex flex-col gap-2 px-2.5 pb-2.5 md:px-2 xl:px-2.5">
        <TourButton />
        <UserCard orgId={orgId} />
      </div>
    </nav>
  );
}

/**
 * The groups, with the Setup item conditional and a progress badge on it.
 *
 * ## Why the ITEM goes, and not just the badge
 *
 * A new project needs six things before a webhook can flow, and an operator who
 * does not know that has no reason to click a nav item called Setup. "2/6" says
 * there is outstanding work and exactly how much, without a modal, a banner or a
 * nag. Once all six are satisfied the checklist can never change again, and a
 * permanent entry — with or without a green tick on it — is a slot in the
 * primary nav spent on nothing. So the whole item disappears, and the operator
 * is left with a rail that only names places worth going.
 *
 * ## Why visibility is `useSetupAffordance` and not `isSetupComplete`
 *
 * The moment the item's presence depends on completeness, "we could not find
 * out" becomes a dangerous state: hiding it is indistinguishable from claiming
 * the project is ready. `useSetupAffordance` answers in three values, and
 * `unknown` renders the same nothing that `hide` does — which is what makes an
 * operating project's cold load flicker-free (nothing, then nothing) while a
 * failed check still leaves an incomplete project a way to its checklist.
 *
 * The BADGE keeps the stricter rule: it needs a number, and a number can only
 * come from a resolved check. A badge reading "0/6" for a moment on every
 * navigation would be alarming and wrong, so `show` from a remembered value
 * carries the item without one.
 *
 * Exported for `setup-affordance.test.tsx`, which renders it through its real
 * hooks against a seeded query cache — the same seam `OutboxPage` and
 * `AnalyticsPage` expose for their tests.
 */
export function RailGroups({ orgId, projectId }: { orgId: string; projectId?: string }) {
  const { affordance, setup } = useSetupAffordance(orgId, projectId ?? '');
  const groups = navigationGroups(orgId, projectId, affordance);

  const progress =
    projectId &&
    affordance === 'show' &&
    !setup.isPending &&
    !setup.isError &&
    // A count taken from a page that did not contain the answer is a wrong
    // number, not a stale one: "5/6" on a project whose fifty-first endpoint is
    // delivering. The item may still be offered; the number may not.
    !setup.isUndetermined
      ? setupProgress(setup.steps)
      : null;
  const badges =
    progress && progress.done < progress.total && projectId
      ? { [setupNavPath(orgId, projectId)]: `${progress.done}/${progress.total}` }
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
        <p className="px-2 pb-1 pt-3 text-2xs font-bold uppercase tracking-wider text-nav-section md:hidden xl:block">
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
      // The label is the accessible name at every width. In the tablet rail it
      // is `display: none`, so the title is what a hovering mouse gets and the
      // icon is all a sighted user has — which is why every icon is distinct in
      // SHAPE rather than only in detail.
      title={item.label}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors',
          'md:justify-center xl:justify-start',
          isActive
            ? 'bg-nav-active font-semibold text-accent-deep'
            : 'font-medium text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
        )
      }
    >
      <NavIcon name={item.icon} className="h-[0.9375rem] w-[0.9375rem] shrink-0" />
      <span className="min-w-0 flex-1 truncate md:hidden xl:inline">{item.label}</span>
      {/* Collapsed, the label is still the accessible name. */}
      <span className="sr-only hidden md:inline xl:hidden">{item.label}</span>
      {badge && (
        <span className="shrink-0 rounded bg-accent px-1.5 py-px text-2xs font-bold tabular text-accent-ink md:hidden xl:inline">
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
      title="Product tour"
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs font-medium text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink md:justify-center xl:justify-start"
    >
      <NavIcon name="tour" className="h-[0.9375rem] w-[0.9375rem] shrink-0" />
      <span className="md:hidden xl:inline">Product tour</span>
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

/**
 * The phone's bottom bar.
 *
 * ## Why a bar and not just the slide-out
 *
 * The slide-out is two taps to anywhere. That is fine for Policies and wrong
 * for the four screens an incident moves between constantly — and an operator
 * holding a phone in one hand at 2am is the exact reader this product is for.
 *
 * ## Why "More" opens the same rail
 *
 * One navigation model, two shapes. A separate "more" screen would be a second
 * place for a route to be missing from.
 */
function BottomNav({
  orgId,
  projectId,
  onMore,
}: {
  orgId: string;
  projectId: string;
  onMore: () => void;
}) {
  const items = bottomNav(orgId, projectId);

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-nav-line bg-nav pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.5625rem] font-medium transition-colors',
              isActive ? 'text-accent' : 'text-nav-ink-muted',
            )
          }
        >
          <NavIcon name={item.icon} className="h-[1.125rem] w-[1.125rem]" />
          {item.label}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMore}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.5625rem] font-medium text-nav-ink-muted"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-[1.125rem] w-[1.125rem]"
          fill="currentColor"
        >
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
        More
      </button>
    </nav>
  );
}
