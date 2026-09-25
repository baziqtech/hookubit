import type { ReactNode } from 'react';

/**
 * The rail's icons, drawn once.
 *
 * ## Why icons at all
 *
 * At desktop width they are almost decoration — the label is doing the work.
 * They exist for two other reasons. The tablet layout collapses the rail to
 * icons only, so a missing one would leave a blank row rather than a narrow
 * one. And a sixteen-item rail is scanned by shape long before it is read,
 * which is what makes "the one that looks like a key" a faster target than the
 * fourth item under the third heading.
 *
 * ## Why hand-drawn rather than a package
 *
 * Sixteen 16px glyphs is about 2 KB of path data. The smallest icon library
 * that covers them is two orders of magnitude larger, and every one of them
 * would arrive with its own sizing and stroke conventions to be overridden.
 *
 * Every path is drawn on a 24-unit grid with a 2-unit stroke, so they share a
 * weight when scaled to 15px. `currentColor` throughout: the rail sets the
 * colour, never the icon.
 */
export type NavIconName =
  | 'setup'
  | 'overview'
  | 'deliveries'
  | 'events'
  | 'endpoints'
  | 'subscriptions'
  | 'policies'
  | 'api-keys'
  | 'analytics'
  | 'audit'
  | 'project-settings'
  | 'notifications'
  | 'team'
  | 'billing'
  | 'organization'
  | 'tour'
  | 'stuck';

const PATHS: Record<NavIconName, ReactNode> = {
  // A checklist: three ticks against three rules.
  setup: (
    <>
      <path d="m3 6 2 2 3-3" />
      <path d="m3 13 2 2 3-3" />
      <path d="M13 7h8M13 14h8M3 20h18" />
    </>
  ),
  // Panels: the shape of a dashboard, not a picture of one.
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  // Outbound: a paper plane. Deliveries are the thing we SEND.
  deliveries: (
    <>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3 14.5 21l-4-7.5L3 9.5Z" />
    </>
  ),
  // A bolt: something happened, once, instantaneously.
  events: <path d="M13 2 4 14h7l-1 8 9-12h-7Z" />,
  // A socket the world plugs into.
  endpoints: (
    <>
      <path d="M12 3a4 4 0 0 0-3.5 5.9L5 15" />
      <path d="M12 3a4 4 0 0 1 3.5 5.9L19 15" />
      <circle cx="5" cy="18" r="3" />
      <circle cx="19" cy="18" r="3" />
      <path d="M8 18h8" />
    </>
  ),
  // A fork in the road: one thing arriving, two leaving.
  subscriptions: (
    <>
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M6 16.5V9a4 4 0 0 1 4-4h5.5M8.5 19h7" />
    </>
  ),
  // Sliders: rules with values you move.
  policies: (
    <>
      <path d="M3 7h5M13 7h8M3 17h9M17 17h4" />
      <circle cx="10.5" cy="7" r="2.5" />
      <circle cx="14.5" cy="17" r="2.5" />
    </>
  ),
  'api-keys': (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="m11.5 11.5 8 8M17 17l2.5-2.5M14.5 14.5 17 12" />
    </>
  ),
  analytics: (
    <>
      <path d="M3 21h18" />
      <path d="M6 21v-7M11 21V6M16 21v-10M21 21v-4" />
    </>
  ),
  // A scroll with writing on it: the record of who did what.
  audit: (
    <>
      <path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M15 3v5h5M7 12h9M7 16h6" />
    </>
  ),
  'project-settings': (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </>
  ),
  notifications: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10.5 19a1.8 1.8 0 0 0 3 0" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.2a3.5 3.5 0 0 1 0 5.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  billing: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19M6 15h3" />
    </>
  ),
  organization: (
    <>
      <path d="M3 21V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15" />
      <path d="M14 10h5a2 2 0 0 1 2 2v9M2 21h20" />
      <path d="M6.5 8h3M6.5 12h3M6.5 16h3M17 14h1M17 17.5h1" />
    </>
  ),
  tour: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  // A tray with something still in it.
  stuck: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M4.6 5.4 3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-1.6-7.6A2 2 0 0 0 17.5 4h-11a2 2 0 0 0-1.9 1.4Z" />
    </>
  ),
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
