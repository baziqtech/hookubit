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
    { to: `${base}/policies`, label: 'Policies' },
    { to: `${base}/api-keys`, label: 'API keys' },
    { to: `${base}/analytics`, label: 'Analytics' },
    { to: `${base}/settings`, label: 'Settings' },
  ];
}

/**
 * Routes that have a NAME but no place in the navigation.
 *
 * Stuck events is the whole list. Most projects have nothing stuck most of the
 * time, so a permanent entry spends one of eleven slots on a condition that is
 * almost always absent; `StuckEventsNotice` brings it to the operator on the
 * two screens they live on, exactly when there is something to say.
 *
 * It still needs a name, because the breadcrumb is derived from this model and
 * a page you arrive at should say where you are. Separating "rendered in the
 * rail" from "has a label" is the whole point of this list — without it,
 * dropping the entry leaves the page titled by nothing.
 */
export function unlistedProjectNav(orgId: string, projectId: string): NavItem[] {
  const base = `/orgs/${orgId}/projects/${projectId}`;
  return [{ to: `${base}/outbox`, label: 'Stuck events' }];
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
    // Unlisted routes are named here too: a page reached from a notice rather
    // than from the rail still has to tell you where you are.
    ...(projectId ? unlistedProjectNav(orgId, projectId) : []),
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
