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
