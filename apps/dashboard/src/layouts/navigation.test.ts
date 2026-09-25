import { describe, expect, it } from 'vitest';
import { currentSectionLabel, navigationGroups, setupNavPath } from './navigation';

const ORG = 'org_1';
const PROJECT = 'proj_1';
const BASE = `/orgs/${ORG}/projects/${PROJECT}`;

const paths = (setup?: 'show' | 'hide' | 'unknown') =>
  navigationGroups(ORG, PROJECT, setup).flatMap((group) => group.items.map((item) => item.to));

describe('navigationGroups — the Setup item', () => {
  it('leads the rail when the project is incomplete', () => {
    const groups = navigationGroups(ORG, PROJECT, 'show');

    // First, above every heading: it is the one thing to do, and it is ordered
    // before the places you go once there is something to look at.
    expect(groups[0]).toEqual({
      title: null,
      items: [{ to: `${BASE}/get-started`, label: 'Setup', icon: 'setup' }],
    });
  });

  it('is gone entirely once the project is set up — not restyled, not ticked', () => {
    expect(paths('hide')).not.toContain(`${BASE}/get-started`);
    // And nothing took its place: the rail now opens on the first real heading.
    expect(navigationGroups(ORG, PROJECT, 'hide')[0].title).toBe('Record');
  });

  it('is absent while completeness is unknown, which is what makes a cold load flicker-free', () => {
    // `unknown` renders exactly what `hide` renders. An operating project
    // therefore shows no Setup item before the check resolves and none after, so
    // there is no moment at which one appears and vanishes again.
    expect(paths('unknown')).toEqual(paths('hide'));
  });

  it('changes nothing else in the rail when it goes', () => {
    const withSetup = paths('show');
    const without = paths('hide');

    expect(without).toEqual(withSetup.filter((to) => to !== `${BASE}/get-started`));
  });

  it('is present by default, for the callers that read the model to NAME things', () => {
    expect(paths()).toContain(`${BASE}/get-started`);
  });

  it('points at /get-started, the route docs and bookmarks use', () => {
    expect(setupNavPath(ORG, PROJECT)).toBe(`${BASE}/get-started`);
  });

  it('is not offered at all without a project, since setup state belongs to one', () => {
    expect(paths('show').length).toBeGreaterThan(0);
    expect(navigationGroups(ORG, undefined, 'show').flatMap((g) => g.items.map((i) => i.to))).not.toContain(
      `${BASE}/get-started`,
    );
  });
});

describe('currentSectionLabel', () => {
  it('still names /get-started on a project whose rail no longer offers it', () => {
    /*
     * The page must stay readable for everyone who reached it from a bookmark,
     * an email or the docs. Deriving the breadcrumb from the rail's FILTERED
     * model would leave exactly those arrivals looking at a nameless page.
     */
    expect(currentSectionLabel(`${BASE}/get-started`, ORG, PROJECT)).toBe('Setup');
  });

  it('keeps naming the sections around it', () => {
    expect(currentSectionLabel(`${BASE}/deliveries`, ORG, PROJECT)).toBe('Deliveries');
    expect(currentSectionLabel(`${BASE}/settings`, ORG, PROJECT)).toBe('Project settings');
  });
});
