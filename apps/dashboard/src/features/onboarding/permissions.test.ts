import { describe, expect, it } from 'vitest';
import type { Role } from '../../types/api';
import {
  GATED_SETUP_STEPS,
  maySetupInputBeRead,
  SETUP_INPUT_READ_ROLES,
  unreadableSetupInputs,
} from './permissions';

/**
 * The mirror of control-api `src/authz/permissions.ts`, pinned.
 *
 * These lists are a copy of a table in another package, and a copy that drifts
 * is worse than no copy: too narrow and a developer loses the checklist, too
 * wide and the 403 comes back — with it, the permanently-unclearable Setup item
 * this module was written to remove.
 */
const ROLES: Role[] = ['owner', 'admin', 'developer', 'viewer', 'billing'];

describe('who may read the checklist inputs', () => {
  it('withholds the API-key inventory from viewer and billing, and nothing else', () => {
    // `api-keys.read` — a key row leaks no secret, but the inventory of live
    // credentials is not read-only-user data.
    const allowed = ROLES.filter((role) => maySetupInputBeRead('api-key', role));
    expect(allowed).toEqual(['owner', 'admin', 'developer']);
  });

  it('withholds endpoints, subscriptions and events from billing alone', () => {
    for (const step of ['endpoint', 'subscription', 'event'] as const) {
      const denied = ROLES.filter((role) => !maySetupInputBeRead(step, role));
      expect(denied, step).toEqual(['billing']);
    }
  });

  it('gates only the four inputs the matrix actually gates', () => {
    // The organization and project steps are absent on purpose: `projects.read`
    // and the organizations list are granted to every role, so there is nothing
    // to gate and a row here would silently blank a step for everybody.
    expect([...GATED_SETUP_STEPS].sort()).toEqual([
      'api-key',
      'endpoint',
      'event',
      'subscription',
    ]);
  });

  it('treats an unknown role as permitted, because a pre-check is not authority', () => {
    // The organizations list has not landed, or failed. Guessing "denied" drops a
    // real input for an owner; asking costs one request the answer then stops
    // repeating. Same call `lib/role-gate.ts` makes for write affordances.
    for (const step of GATED_SETUP_STEPS) {
      expect(maySetupInputBeRead(step, undefined), step).toBe(true);
    }
    expect(unreadableSetupInputs(undefined)).toEqual({});
  });
});

describe('what a denied role is told', () => {
  it('names the roles the read needs and the role the reader holds', () => {
    const viewer = unreadableSetupInputs('viewer');

    expect(Object.keys(viewer)).toEqual(['api-key']);
    expect(viewer['api-key']).toBe(
      'Reading this needs the owner, admin or developer role. You are a viewer in this organization.',
    );
  });

  it('leaves a billing member with no readable project input at all', () => {
    // Four of the six steps. Which is the honest answer for a role scoped to
    // money and seats — and the reason its Setup item goes rather than sticking.
    expect(Object.keys(unreadableSetupInputs('billing')).sort()).toEqual([
      'api-key',
      'endpoint',
      'event',
      'subscription',
    ]);
  });

  it('gates nothing for the three roles that hold every read', () => {
    for (const role of ['owner', 'admin', 'developer'] as const) {
      expect(unreadableSetupInputs(role), role).toEqual({});
    }
  });

  it('keeps every gated step readable by somebody, so no input is denied to all', () => {
    for (const step of GATED_SETUP_STEPS) {
      expect(SETUP_INPUT_READ_ROLES[step].length, step).toBeGreaterThan(0);
    }
  });
});
