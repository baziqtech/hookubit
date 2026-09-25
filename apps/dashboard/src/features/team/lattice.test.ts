import { describe, expect, it } from 'vitest';
import type { Role } from '../../types/api';
import {
  ROLE_RANK,
  assignableRoles,
  isDenied,
  mayAssignRole,
  ownerCountOf,
  removalVerdict,
  roleChangeVerdict,
  rowVerdict,
} from './lattice';

/**
 * Mirrors `assertRoleChangeAllowed`, `assertMemberRemovalAllowed` and
 * `assertOwnerSurvives` in control-api `src/authz/permissions.ts`, and
 * `members.service.spec.ts` where it pins the same sentences. If one of these
 * goes green with a different sentence, the Team page is explaining a refusal
 * the server will word differently — which is the drift this file exists to
 * catch.
 */
const ME = 'usr_me';
const context = (actorRole: Role | undefined, ownerCount: number | null = 3) => ({
  actorRole,
  actorUserId: actorRole === undefined ? undefined : ME,
  ownerCount,
});
const member = (role: Role, user_id = 'usr_other') => ({ user_id, role });

describe('the rank order', () => {
  it('is owner > admin > developer > viewer = billing', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.developer);
    expect(ROLE_RANK.developer).toBeGreaterThan(ROLE_RANK.viewer);
    // Incomparable on purpose: one sees data, the other sees money.
    expect(ROLE_RANK.viewer).toBe(ROLE_RANK.billing);
  });

  it('lets an admin make another admin but never an owner', () => {
    expect(mayAssignRole('admin', 'admin')).toBe(true);
    expect(mayAssignRole('admin', 'developer')).toBe(true);
    expect(mayAssignRole('admin', 'owner')).toBe(false);
    expect(assignableRoles('admin')).toEqual(['admin', 'developer', 'viewer', 'billing']);
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'developer', 'viewer', 'billing']);
  });

  it('gives a developer, viewer or billing member no assignment power at all', () => {
    for (const role of ['developer', 'viewer', 'billing'] as const) {
      expect(assignableRoles(role)).toEqual([]);
    }
  });
});

describe('roleChangeVerdict', () => {
  it('refuses a role without members.write, in the server’s words', () => {
    const verdict = roleChangeVerdict(context('developer'), member('viewer'), 'billing');
    expect(verdict).toEqual({
      verdict: 'denied',
      code: 'forbidden',
      reason: 'You may not change member roles.',
    });
  });

  it('never lets you change your own role — the self-escalation door', () => {
    const verdict = roleChangeVerdict(context('owner'), member('owner', ME), 'admin');
    expect(isDenied(verdict) && verdict.reason).toBe(
      'You cannot change your own role. Ask another owner or admin to do it.',
    );
  });

  it('refuses a role above your own rank', () => {
    const verdict = roleChangeVerdict(context('admin'), member('developer'), 'owner');
    expect(isDenied(verdict) && verdict.reason).toBe('You may not assign the role "owner".');
  });

  it('refuses to touch someone who outranks you — symmetrical with granting', () => {
    const verdict = roleChangeVerdict(context('admin'), member('owner'), 'admin');
    expect(isDenied(verdict) && verdict.reason).toBe('You may not change the role of an owner.');
  });

  it('refuses to demote the last owner, as a CONFLICT rather than a forbidden', () => {
    const verdict = roleChangeVerdict(context('owner', 1), member('owner'), 'admin');
    expect(verdict).toEqual({
      verdict: 'denied',
      code: 'conflict',
      reason: 'An organization must always have at least one owner. Promote another member first.',
    });
  });

  it('allows demoting an owner when another survives, and owner-to-owner always', () => {
    expect(roleChangeVerdict(context('owner', 2), member('owner'), 'admin').verdict).toBe('allowed');
    expect(roleChangeVerdict(context('owner', 1), member('owner'), 'owner').verdict).toBe('allowed');
  });

  it('lets the server decide the owner rule when the page is not the whole list', () => {
    expect(roleChangeVerdict(context('owner', null), member('owner'), 'admin').verdict).toBe(
      'unknown',
    );
  });

  it('allows an ordinary change', () => {
    expect(roleChangeVerdict(context('admin'), member('viewer'), 'developer').verdict).toBe(
      'allowed',
    );
  });

  it('does NOT deny when the caller’s role is not known yet', () => {
    expect(roleChangeVerdict(context(undefined), member('viewer'), 'admin').verdict).toBe('unknown');
  });
});

describe('removalVerdict', () => {
  it('is a role change to "no role": the same rules, the removal wording', () => {
    expect(isDenied(removalVerdict(context('viewer'), member('viewer'))) &&
      removalVerdict(context('viewer'), member('viewer'))).toMatchObject({
      reason: 'You may not remove members.',
    });
    expect(removalVerdict(context('owner'), member('owner', ME))).toMatchObject({
      reason: 'You cannot remove your own membership. Ask another owner or admin to do it.',
    });
    expect(removalVerdict(context('admin'), member('owner'))).toMatchObject({
      reason: 'You may not remove an owner.',
    });
    expect(removalVerdict(context('owner', 1), member('owner'))).toMatchObject({
      code: 'conflict',
      reason: 'An organization must always have at least one owner. Promote another member first.',
    });
    expect(removalVerdict(context('owner', 2), member('owner')).verdict).toBe('allowed');
    expect(removalVerdict(context('admin'), member('developer')).verdict).toBe('allowed');
  });
});

describe('rowVerdict', () => {
  it('greys out your own row and rows that outrank you, with the reason', () => {
    expect(rowVerdict(context('admin'), member('admin', ME))).toMatchObject({
      verdict: 'denied',
      reason: /your own role/,
    });
    expect(rowVerdict(context('admin'), member('owner'))).toMatchObject({
      verdict: 'denied',
      reason: 'You may not change the role of an owner.',
    });
    // An admin may reassign another admin: equal rank is not "outranks".
    expect(rowVerdict(context('admin'), member('admin')).verdict).toBe('allowed');
  });
});

describe('ownerCountOf', () => {
  const rows = [member('owner'), member('admin'), member('owner')];

  it('counts only when the page is the whole list', () => {
    expect(ownerCountOf({ rows, hasMore: false }, 0)).toBe(2);
  });

  it('refuses to count a partial page — a wrong pre-check would deny a legal demotion', () => {
    expect(ownerCountOf({ rows, hasMore: true }, 0)).toBeNull();
    expect(ownerCountOf({ rows, hasMore: false }, 50)).toBeNull();
  });
});
