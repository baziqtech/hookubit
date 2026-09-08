import { describe, expect, it } from 'vitest';
import {
  deriveSetupSteps,
  isSetupComplete,
  setupHeadline,
  setupProgress,
  type SetupInputs,
} from './setup';

/**
 * The sequencing rules, tested as plain functions.
 *
 * This workspace has no jsdom and no Testing Library (HANDOFF.md), so the
 * derivation was written with no React in it precisely so it could be covered
 * properly. The cases that matter are not "does a tick appear" — they are the
 * ones where a naive checklist LIES: a resource that exists but cannot deliver.
 */
const EMPTY: SetupInputs = {
  organizationName: null,
  projectName: null,
  projectEnvironment: null,
  activeApiKeyCount: 0,
  deliverableEndpointCount: 0,
  blockedEndpointCount: 0,
  enabledSubscriptionCount: 0,
  disabledSubscriptionCount: 0,
  eventCount: 0,
};

const READY: SetupInputs = {
  organizationName: 'ShaQ Express',
  projectName: 'Payments',
  projectEnvironment: 'live',
  activeApiKeyCount: 2,
  deliverableEndpointCount: 3,
  blockedEndpointCount: 0,
  enabledSubscriptionCount: 2,
  disabledSubscriptionCount: 0,
  eventCount: 64,
};

const stepById = (inputs: SetupInputs, id: string) =>
  deriveSetupSteps(inputs).find((step) => step.id === id)!;

describe('step sequencing', () => {
  it('marks exactly one step as current', () => {
    const current = deriveSetupSteps(EMPTY).filter((step) => step.state === 'current');
    expect(current).toHaveLength(1);
  });

  it('makes the FIRST unsatisfied step current, not an arbitrary one', () => {
    const steps = deriveSetupSteps({ ...EMPTY, organizationName: 'Acme' });
    expect(steps.find((step) => step.state === 'current')?.id).toBe('project');
  });

  it('has no current step once everything is satisfied', () => {
    expect(deriveSetupSteps(READY).some((step) => step.state === 'current')).toBe(false);
    expect(isSetupComplete(deriveSetupSteps(READY))).toBe(true);
  });

  it('is not complete while any step is untouched', () => {
    expect(isSetupComplete(deriveSetupSteps(EMPTY))).toBe(false);
  });
});

/**
 * The whole reason `attention` exists. Ticking these green is how someone
 * spends an afternoon wondering why no webhook ever arrives.
 */
describe('resources that exist but do not deliver', () => {
  it('does NOT call the endpoint step done when every endpoint is paused', () => {
    const step = stepById({ ...READY, deliverableEndpointCount: 0, blockedEndpointCount: 2 }, 'endpoint');

    expect(step.state).toBe('attention');
    expect(step.state).not.toBe('done');
    expect(step.warning).toMatch(/nothing will be delivered/i);
  });

  it('flags a partially blocked endpoint set without blocking progress', () => {
    const step = stepById({ ...READY, blockedEndpointCount: 1 }, 'endpoint');

    expect(step.state).toBe('attention');
    expect(step.evidence).toContain('3 endpoints delivering');
    expect(step.warning).toMatch(/paused, disabled/i);
  });

  it('does NOT call the subscription step done when every subscription is disabled', () => {
    const step = stepById(
      { ...READY, enabledSubscriptionCount: 0, disabledSubscriptionCount: 3 },
      'subscription',
    );

    expect(step.state).toBe('attention');
    // The specific trap: a 202 from ingest, and nothing delivered.
    expect(step.warning).toMatch(/accepted and stored, then dropped/i);
  });

  it('treats an attention step as satisfied for SEQUENCING, so later steps stay reachable', () => {
    const steps = deriveSetupSteps({
      ...EMPTY,
      organizationName: 'Acme',
      projectName: 'Payments',
      activeApiKeyCount: 1,
      blockedEndpointCount: 1,
    });

    // The endpoint step needs attention, but the subscription step is next up
    // rather than the flow stalling on a resource that already exists.
    expect(steps.find((step) => step.id === 'endpoint')?.state).toBe('attention');
    expect(steps.find((step) => step.state === 'current')?.id).toBe('subscription');
  });
});

describe('api key state', () => {
  it('ignores revoked and expired keys — only an active key can publish', () => {
    // `activeApiKeyCount` is already filtered by the caller; this pins that a
    // zero count is NOT satisfied even when keys exist in the project.
    expect(stepById({ ...READY, activeApiKeyCount: 0 }, 'api-key').state).toBe('current');
  });
});

describe('progress and headline', () => {
  it('counts attention steps as done for progress — they exist', () => {
    const steps = deriveSetupSteps({ ...READY, deliverableEndpointCount: 0, blockedEndpointCount: 1 });
    const progress = setupProgress(steps);
    expect(progress.done).toBe(progress.total);
  });

  it('leads the headline with the next action while one is outstanding', () => {
    expect(setupHeadline(deriveSetupSteps(EMPTY))).toMatch(/^Next: /);
  });

  it('reports the blocker when nothing is outstanding but something cannot deliver', () => {
    const steps = deriveSetupSteps({ ...READY, enabledSubscriptionCount: 0, disabledSubscriptionCount: 1 });
    expect(setupHeadline(steps)).toMatch(/dropped/i);
  });

  it('says setup is complete only when it genuinely is', () => {
    expect(setupHeadline(deriveSetupSteps(READY))).toMatch(/complete/i);
  });
});

describe('wording', () => {
  it('explains what a subscription IS, not just that one is missing', () => {
    // The single most valuable sentence on the page: it is the reason a 202
    // from ingest does not mean anything was delivered.
    expect(stepById(EMPTY, 'subscription').concept).toMatch(
      /events are accepted and nothing is delivered/i,
    );
  });

  it('states that the API key secret cannot be recovered', () => {
    expect(stepById(EMPTY, 'api-key').action).toMatch(/shown once and cannot be recovered/i);
  });
});
