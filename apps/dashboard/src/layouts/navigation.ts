/** The navigation model. Route paths live here once, not scattered through JSX. */
import type { NavIconName } from './nav-icons';

export interface NavItem {
  to: string;
  label: string;
  icon: NavIconName;
  /** Matched as a prefix so detail pages keep their parent highlighted. */
  match?: string;
}

export interface NavGroup {
  /**
   * The small uppercase heading above the group, or `null` for the ungrouped
   * items that sit at the top of the rail before any heading.
   */
  title: string | null;
  items: NavItem[];
}

/**
 * The rail, grouped.
 *
 * ## Why groups
 *
 * Sixteen flat items is a list you read rather than a structure you learn. The
 * groups name the four questions the product answers, in the order an incident
 * actually asks them: what happened (RECORD), who was supposed to get it
 * (ROUTING), how is it trending (INSIGHT), and how is this configured
 * (PROJECT / ORGANIZATION).
 *
 * ## Why organization items are a section rather than a separate rail
 *
 * They used to REPLACE the project items whenever you opened an org-level
 * screen, so navigating to Settings made Deliveries and Events disappear —
 * which reads as "you have left the project" when you have not. One rail, five
 * headings, nothing vanishes.
 *
 * `Usage` and `Audit log` are organization-scoped routes that sit under INSIGHT
 * beside the project-scoped `Analytics`, because the heading names what the
 * screen is FOR, not which id is in its path.
 *
 * ## Deliveries before Events
 *
 * Deliberate, and the opposite of the underlying data flow. An operator arrives
 * holding a complaint — "the partner says they never got it" — which is a
 * question about a delivery. Events is where you go second, once the delivery
 * turns out not to exist.
 */
export function navigationGroups(orgId: string, projectId?: string): NavGroup[] {
  const org = `/orgs/${orgId}`;

  if (!projectId) {
    // No project selected: only the routes that are genuinely reachable. A
    // heading over a group whose every item 404s is worse than no heading.
    return [
      { title: 'Insight', items: [usage(org), auditLog(org)] },
      { title: 'Organization', items: organizationItems(org) },
    ];
  }

  const base = `${org}/projects/${projectId}`;
  return [
    { title: null, items: [{ to: `${base}/get-started`, label: 'Setup', icon: 'setup' }] },
    {
      title: 'Record',
      items: [
        { to: `${base}/overview`, label: 'Overview', icon: 'overview' },
        { to: `${base}/deliveries`, label: 'Deliveries', icon: 'deliveries' },
        { to: `${base}/events`, label: 'Events', icon: 'events' },
      ],
    },
    {
      title: 'Routing',
      items: [
        { to: `${base}/endpoints`, label: 'Endpoints', icon: 'endpoints' },
        { to: `${base}/subscriptions`, label: 'Subscriptions', icon: 'subscriptions' },
        { to: `${base}/policies`, label: 'Policies', icon: 'policies' },
        { to: `${base}/api-keys`, label: 'API keys', icon: 'api-keys' },
      ],
    },
    {
      title: 'Insight',
      items: [{ to: `${base}/analytics`, label: 'Analytics', icon: 'analytics' }, usage(org), auditLog(org)],
    },
    {
      title: 'Project',
      items: [
        { to: `${base}/settings`, label: 'Project settings', icon: 'project-settings' },
        { to: `${base}/notifications`, label: 'Notifications', icon: 'notifications' },
      ],
    },
    { title: 'Organization', items: organizationItems(org) },
  ];
}

function usage(org: string): NavItem {
  return { to: `${org}/usage`, label: 'Usage', icon: 'usage' };
}

function auditLog(org: string): NavItem {
  return { to: `${org}/audit`, label: 'Audit log', icon: 'audit' };
}

function organizationItems(org: string): NavItem[] {
  return [
    { to: `${org}/team`, label: 'Team', icon: 'team' },
    { to: `${org}/billing`, label: 'Billing', icon: 'billing' },
    { to: `${org}/settings`, label: 'Organization settings', icon: 'organization' },
  ];
}

/**
 * Routes that have a NAME but no place in the navigation.
 *
 * Stuck events is the whole list. Most projects have nothing stuck most of the
 * time, so a permanent entry spends a slot on a condition that is almost always
 * absent; `StuckEventsNotice` brings it to the operator on the two screens they
 * live on, exactly when there is something to say.
 *
 * It still needs a name, because the breadcrumb is derived from this model and
 * a page you arrive at should say where you are. Separating "rendered in the
 * rail" from "has a label" is the whole point of this list — without it,
 * dropping the entry leaves the page titled by nothing.
 */
export function unlistedProjectNav(orgId: string, projectId: string): NavItem[] {
  const base = `/orgs/${orgId}/projects/${projectId}`;
  return [{ to: `${base}/outbox`, label: 'Stuck events', icon: 'stuck' }];
}

/**
 * The name of the section the given path is in, for the breadcrumb.
 *
 * Derived from the same nav model the sidebar renders rather than from a second
 * hand-written map, so a renamed nav item cannot end up disagreeing with the
 * breadcrumb above it. Longest match wins, which is what keeps
 * `/orgs/x/projects/y/settings` resolving to "Project settings" rather than to
 * the organization's `/orgs/x/settings`, and `/events/:id` to Events rather
 * than to whichever prefix happened to be checked first.
 */
export function currentSectionLabel(
  pathname: string,
  orgId: string,
  projectId?: string,
): string | null {
  const candidates = [
    ...navigationGroups(orgId, projectId).flatMap((group) => group.items),
    // Unlisted routes are named here too: a page reached from a notice rather
    // than from the rail still has to tell you where you are.
    ...(projectId ? unlistedProjectNav(orgId, projectId) : []),
  ];

  let best: NavItem | null = null;
  for (const item of candidates) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best?.label ?? null;
}
