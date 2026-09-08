/** The navigation model. Route paths live here once, not scattered through JSX. */

export interface NavItem {
  to: string;
  label: string;
  /** Matched as a prefix so detail pages keep their parent highlighted. */
  match?: string;
}

export function projectNav(orgId: string, projectId: string): NavItem[] {
  const base = `/orgs/${orgId}/projects/${projectId}`;
  return [
    { to: `${base}/get-started`, label: 'Get started' },
    { to: `${base}/overview`, label: 'Overview' },
    { to: `${base}/events`, label: 'Events' },
    { to: `${base}/deliveries`, label: 'Deliveries' },
    { to: `${base}/endpoints`, label: 'Endpoints' },
    { to: `${base}/subscriptions`, label: 'Subscriptions' },
    { to: `${base}/api-keys`, label: 'API keys' },
    { to: `${base}/analytics`, label: 'Analytics' },
    { to: `${base}/settings`, label: 'Settings' },
  ];
}

export function organizationNav(orgId: string): NavItem[] {
  const base = `/orgs/${orgId}`;
  return [
    { to: `${base}/settings`, label: 'Settings' },
    { to: `${base}/team`, label: 'Team' },
    { to: `${base}/billing`, label: 'Billing' },
    { to: `${base}/usage`, label: 'Usage' },
    { to: `${base}/audit`, label: 'Audit log' },
  ];
}

/**
 * The name of the section the given path is in, for the breadcrumb.
 *
 * Derived from the same nav model the sidebar renders rather than from a second
 * hand-written map, so a renamed nav item cannot end up disagreeing with the
 * breadcrumb above it. Longest match wins, so `/events/:id` resolves to Events
 * rather than to whichever prefix happened to be checked first.
 */
export function currentSectionLabel(
  pathname: string,
  orgId: string,
  projectId?: string,
): string | null {
  const candidates = [
    ...(projectId ? projectNav(orgId, projectId) : []),
    ...organizationNav(orgId),
  ];

  let best: NavItem | null = null;
  for (const item of candidates) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best?.label ?? null;
}
