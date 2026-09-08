/**
 * The five concepts between signing up and a delivered webhook.
 *
 * A new operator lands on an empty dashboard and has to work out, unaided, that
 * they need an organization, then a project, then an API key, then an endpoint,
 * then a subscription, before a single webhook can flow. That is five concepts
 * before any value, and none of them is guessable from an empty table.
 *
 * This module is the ORDER and the WORDING, as pure data. It deliberately has
 * no React in it: the sequencing rules — which step is current, when a step is
 * satisfied but not actually working — are the part worth testing, and they are
 * testable here without a DOM (this workspace has neither jsdom nor Testing
 * Library; see HANDOFF.md).
 */
import type { Environment } from '../../types/api';

export type SetupStepId =
  | 'organization'
  | 'project'
  | 'api-key'
  | 'endpoint'
  | 'subscription'
  | 'event';

/**
 * `done` — satisfied. `current` — the one thing to do next. `todo` — later.
 *
 * `attention` is the state that matters and the one a naive checklist misses:
 * the resource EXISTS, so the step cannot honestly be called incomplete, but it
 * will not deliver. An endpoint created by a developer comes back paused with
 * no signing secret; a subscription can be disabled. Ticking those green is how
 * someone spends an afternoon wondering why nothing arrives.
 */
export type SetupStepState = 'done' | 'attention' | 'current' | 'todo';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  /** One plain sentence answering "what IS this thing?". */
  concept: string;
  /** What the operator should do, when the step is not yet satisfied. */
  action: string;
  state: SetupStepState;
  /** What satisfied the step — shown instead of the action once it is done. */
  evidence?: string;
  /** Why a satisfied step still will not deliver. */
  warning?: string;
}

export interface SetupInputs {
  organizationName: string | null;
  projectName: string | null;
  projectEnvironment: Environment | null;
  /** Un-revoked, unexpired keys. A revoked key cannot publish. */
  activeApiKeyCount: number;
  /** Endpoints that are `active` AND `enabled` — i.e. actually deliverable. */
  deliverableEndpointCount: number;
  /** Endpoints that exist but are paused, disabled or awaiting a secret. */
  blockedEndpointCount: number;
  enabledSubscriptionCount: number;
  /** Subscriptions that exist but are switched off. */
  disabledSubscriptionCount: number;
  eventCount: number;
}

/**
 * Steps in dependency order, with exactly one `current`.
 *
 * A step is `current` only if every step before it is satisfied — sequencing
 * matters here because the dependencies are real. Publishing an event before a
 * subscription exists returns a cheerful `202` and delivers nothing, which is
 * the single most confusing thing this product can do to a newcomer.
 */
export function deriveSetupSteps(inputs: SetupInputs): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: 'organization',
      title: 'Organization',
      concept: 'The billing and people boundary. Everything else lives inside one.',
      action: 'Create an organization.',
      state: inputs.organizationName ? 'done' : 'todo',
      evidence: inputs.organizationName ?? undefined,
    },
    {
      id: 'project',
      title: 'Project',
      concept:
        'One environment of one system. It owns its own keys, endpoints and delivery history, and nothing crosses between projects.',
      action: 'Create a project inside this organization.',
      state: inputs.projectName ? 'done' : 'todo',
      evidence: inputs.projectName
        ? `${inputs.projectName}${inputs.projectEnvironment ? ` · ${inputs.projectEnvironment}` : ''}`
        : undefined,
    },
    {
      id: 'api-key',
      title: 'API key',
      concept: 'What your backend authenticates with when it publishes an event.',
      action: 'Create a key. The secret is shown once and cannot be recovered.',
      state: inputs.activeApiKeyCount > 0 ? 'done' : 'todo',
      evidence:
        inputs.activeApiKeyCount > 0
          ? `${count(inputs.activeApiKeyCount, 'active key')}`
          : undefined,
    },
    endpointStep(inputs),
    subscriptionStep(inputs),
    {
      id: 'event',
      title: 'First event',
      concept:
        'You publish an event once. It fans out to one delivery per matching subscription, and each delivery retries on its own.',
      action: 'Publish a test event with the request below.',
      state: inputs.eventCount > 0 ? 'done' : 'todo',
      evidence: inputs.eventCount > 0 ? `${count(inputs.eventCount, 'event')} received` : undefined,
    },
  ];

  return markCurrent(steps);
}

function endpointStep(inputs: SetupInputs): SetupStep {
  const { deliverableEndpointCount: live, blockedEndpointCount: blocked } = inputs;

  if (live > 0) {
    return {
      id: 'endpoint',
      title: 'Endpoint',
      concept: 'The URL we POST to, plus its timeout, rate limit and signing secret.',
      action: 'Add the URL that should receive webhooks.',
      state: blocked > 0 ? 'attention' : 'done',
      evidence: `${count(live, 'endpoint')} delivering`,
      warning:
        blocked > 0
          ? `${count(blocked, 'other endpoint')} exists but is paused, disabled by the circuit breaker, or still waiting for a signing secret.`
          : undefined,
    };
  }

  if (blocked > 0) {
    return {
      id: 'endpoint',
      title: 'Endpoint',
      concept: 'The URL we POST to, plus its timeout, rate limit and signing secret.',
      action: 'Enable an endpoint, or give it a signing secret, so it can receive deliveries.',
      state: 'attention',
      evidence: `${count(blocked, 'endpoint')}, none delivering`,
      warning:
        'Every endpoint in this project is paused, disabled, or waiting for a signing secret. Nothing will be delivered until one is live.',
    };
  }

  return {
    id: 'endpoint',
    title: 'Endpoint',
    concept: 'The URL we POST to, plus its timeout, rate limit and signing secret.',
    action: 'Add the URL that should receive webhooks.',
    state: 'todo',
  };
}

function subscriptionStep(inputs: SetupInputs): SetupStep {
  const { enabledSubscriptionCount: enabled, disabledSubscriptionCount: disabled } = inputs;

  const concept =
    'The routing rule: which event types an endpoint should receive. Without one, events are accepted and nothing is delivered.';

  if (enabled > 0) {
    return {
      id: 'subscription',
      title: 'Subscription',
      concept,
      action: 'Bind an endpoint to the event types it cares about.',
      state: 'done',
      evidence: `${count(enabled, 'active subscription')}`,
    };
  }

  if (disabled > 0) {
    return {
      id: 'subscription',
      title: 'Subscription',
      concept,
      action: 'Enable a subscription so events start routing to your endpoint.',
      state: 'attention',
      evidence: `${count(disabled, 'subscription')}, all disabled`,
      warning:
        'Events published now are accepted and stored, then dropped — no subscription is switched on to route them.',
    };
  }

  return {
    id: 'subscription',
    title: 'Subscription',
    concept,
    action: 'Bind an endpoint to the event types it cares about.',
    state: 'todo',
  };
}

/**
 * Exactly one `current`: the first step that is not yet satisfied.
 *
 * `attention` counts as satisfied for sequencing — the resource exists, so the
 * next step is genuinely reachable — but it keeps its own state so the UI can
 * show it amber rather than green.
 */
function markCurrent(steps: SetupStep[]): SetupStep[] {
  const index = steps.findIndex((step) => step.state === 'todo');
  if (index === -1) return steps;
  return steps.map((step, position) =>
    position === index ? { ...step, state: 'current' as const } : step,
  );
}

/** True once a webhook can actually flow end to end. */
export function isSetupComplete(steps: SetupStep[]): boolean {
  return steps.every((step) => step.state === 'done' || step.state === 'attention');
}

/** Steps satisfied, for a progress read-out. `attention` counts; it exists. */
export function setupProgress(steps: SetupStep[]): { done: number; total: number } {
  return {
    done: steps.filter((step) => step.state === 'done' || step.state === 'attention').length,
    total: steps.length,
  };
}

/**
 * The one-line summary shown outside the checklist — on the overview, in the
 * nav — so an incomplete setup is never something you have to go and check.
 */
export function setupHeadline(steps: SetupStep[]): string {
  const blocked = steps.find((step) => step.state === 'attention');
  const current = steps.find((step) => step.state === 'current');

  if (current) return `Next: ${current.action}`;
  if (blocked) return blocked.warning ?? 'Something in this project is not delivering.';
  return 'Setup is complete — webhooks are flowing.';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
