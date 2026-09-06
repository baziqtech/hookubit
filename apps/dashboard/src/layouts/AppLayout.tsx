import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useLogout, useSession } from '../features/auth/api';
import { cn } from '../lib/cn';
import { Menu, MenuLabel } from './Menu';
import { organizationNav, projectNav, type NavItem } from './navigation';
import { OrganizationSwitcher, ProjectSwitcher } from './Switchers';

/**
 * The application shell: a persistent left rail carrying the two switchers and
 * the navigation, and an outlet that fills the rest. Density is the point —
 * an operator is here to scan tables, not to admire chrome.
 */
export function AppLayout() {
  const { orgId = '', projectId } = useParams();

  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar orgId={orgId} projectId={projectId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" className="min-w-0 flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar({ orgId, projectId }: { orgId: string; projectId?: string }) {
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-panel"
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
          <NavSection title="Project" items={projectNav(orgId, projectId)} />
        ) : (
          <p className="px-2 py-2 text-xs text-ink-subtle">
            Select a project to see events and deliveries.
          </p>
        )}
        <NavSection title="Organization" items={organizationNav(orgId)} className="mt-4" />
      </div>

      <UserMenu />
    </nav>
  );
}

function NavSection({
  title,
  items,
  className,
}: {
  title: string;
  items: NavItem[];
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
        {title}
      </p>
      <ul className="flex flex-col gap-px">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'block rounded px-2 py-1.5 text-xs transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-ink'
                    : 'text-ink-muted hover:bg-raised hover:text-ink',
                )
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UserMenu() {
  const { data: session } = useSession();
  const logout = useLogout();

  return (
    <div className="border-t border-line p-2">
      <Menu
        label="Account menu"
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
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                logout.mutate();
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
        className="flex h-5 w-5 items-center justify-center rounded bg-ink text-2xs font-bold text-canvas"
      >
        W
      </span>
      <span className="text-xs font-semibold tracking-tight">Webhooks</span>
    </span>
  );
}

