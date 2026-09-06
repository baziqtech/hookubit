import { SLUG_PATTERN, slugFromName } from './slug';
import { isUniqueViolationOn, uniqueViolationTarget } from './unique-violation';

describe('slugFromName', () => {
  it.each([
    ['Payments', 'payments'],
    ['Payments Prod', 'payments-prod'],
    ['  Trailing space  ', 'trailing-space'],
    ['Café', 'cafe'],
    ['a---b', 'a-b'],
    ['ACME_Ltd.', 'acme-ltd'],
  ])('derives %p as %p', (name, expected) => {
    const slug = slugFromName(name);
    expect(slug).toBe(expected);
    expect(SLUG_PATTERN.test(slug as string)).toBe(true);
  });

  it('returns null rather than an empty slug when nothing usable survives', () => {
    // `bootstrap` shipped this bug with BOOTSTRAP_ORG="!!!" and wrote an empty
    // slug into a UNIQUE column; the second one failed for an unexplainable
    // reason. Null forces the caller to ask for an explicit slug.
    for (const name of ['!!!', '   ', '-', '...', 'a']) {
      expect(slugFromName(name)).toBeNull();
    }
  });

  it('never produces a trailing hyphen when truncating a long name', () => {
    const slug = slugFromName(`${'a'.repeat(63)} tail`);
    expect(slug).not.toBeNull();
    expect(slug).toHaveLength(63);
    expect(slug?.endsWith('-')).toBe(false);
  });
});

describe('uniqueViolationTarget', () => {
  const p2002 = (target: unknown): unknown => ({ code: 'P2002', meta: { target } });

  it('reads the column-list shape', () => {
    expect(uniqueViolationTarget(p2002(['organization_id', 'slug']))).toBe(
      'organization_id,slug',
    );
  });

  it('reads the constraint-name shape', () => {
    expect(uniqueViolationTarget(p2002('projects_organizationId_slug_key'))).toBe(
      'projects_organizationid_slug_key',
    );
  });

  it('is null for anything that is not a P2002', () => {
    expect(uniqueViolationTarget(new Error('boom'))).toBeNull();
    expect(uniqueViolationTarget({ code: 'P2025' })).toBeNull();
    expect(uniqueViolationTarget(null)).toBeNull();
    expect(uniqueViolationTarget('P2002')).toBeNull();
  });

  it('does not claim an index when the driver named none', () => {
    // The empty string must not match any column, or a P2002 with no metadata
    // would be reported as whichever collision the caller guessed first.
    expect(uniqueViolationTarget(p2002(undefined))).toBe('');
    expect(isUniqueViolationOn(p2002(undefined), 'slug')).toBe(false);
  });

  it('matches only the index it was asked about', () => {
    const err = p2002(['organization_id', 'slug']);
    expect(isUniqueViolationOn(err, 'slug')).toBe(true);
    expect(isUniqueViolationOn(err, 'email')).toBe(false);
    expect(isUniqueViolationOn(p2002(['email']), 'slug')).toBe(false);
  });
});
