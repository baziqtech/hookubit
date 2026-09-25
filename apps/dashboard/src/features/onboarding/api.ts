/**
 * Setup state, composed from the queries the rest of the product already runs.
 *
 * Deliberately NOT a new endpoint. A `GET /v1/projects/:id/setup-state` would
 * be a second source of truth for "does this project have a live endpoint",
 * and it would drift from the lists that answer the same question one click
 * away. Every input here is a list the operator can go and look at.
 *
 * The cost is five parallel requests on the overview. They are all cached by
 * TanStack Query under the keys those screens use, so navigating to Endpoints
 * or API keys afterwards is served from cache rather than refetched.
 */
import { useEffect } from 'react';
import { useApiKeys } from '../api-keys/api';
import { useEndpoints, useSubscriptions } from '../endpoints/api';
import { useEvents } from '../events/api';
import { useOrganizations } from '../organizations/api';
import { useProject } from '../projects/api';
import { deriveSetupSteps, isSetupComplete, type SetupInputs, type SetupStep } from './setup';
import {
  rememberSetupCheckFailed,
  rememberSetupCompleteness,
  resolveSetupAffordance,
  setupMemory,
  type SetupAffordance,
} from './setup-visibility';

export interface SetupState {
  steps: SetupStep[];
  /** True while any input is still loading — the checklist must not flash "todo". */
  isPending: boolean;
  isError: boolean;
}

/**
 * An endpoint counts as deliverable only when the operator has enabled it AND
 * the circuit breaker has not taken it away. Both halves are load-bearing:
 * `enabled` is operator intent and `status` is the breaker's verdict, and an
 * endpoint auto-disabled after five consecutive failures still reads
 * `enabled: true`.
 */
function isDeliverable(endpoint: { status: string; enabled: boolean }): boolean {
  return endpoint.enabled && endpoint.status === 'active';
}

export function useSetupState(orgId: string, projectId: string): SetupState {
  const organizations = useOrganizations();
  const project = useProject(orgId, projectId);
  const apiKeys = useApiKeys(projectId);
  const endpoints = useEndpoints(projectId);
  const subscriptions = useSubscriptions(projectId);
  // One row is enough to answer "has anything ever arrived?".
  const events = useEvents(projectId, {});

  /*
   * WATCH FOR THE FIRST EVENT.
   *
   * The last step of the checklist hands the operator a curl command and then
   * asks them to believe it worked. Refreshing a page to find out is the
   * moment a setup flow loses people — they run the command, see nothing
   * change, and go looking for what they did wrong.
   *
   * A three-second poll, and only while it can matter: the project has no
   * events yet, and the tab is in front of somebody. It stops of its own accord
   * the moment one arrives, because `refetchInterval` is a function of the
   * data.
   *
   * Deliberately NOT server-sent events. The claim on screen is "this page
   * updates the moment one arrives"; a three-second poll satisfies a human
   * reading a checklist, costs one indexed query, and needs no connection to
   * keep alive, no proxy to configure and no reconnection story. SSE would be
   * the right answer for a live delivery feed, which is a different feature.
   */
  useEvents(projectId, {}, 0, {
    refetchInterval: (query) => ((query.state.data?.rows.length ?? 0) > 0 ? false : 3_000),
    refetchIntervalInBackground: false,
  });

  const queries = [organizations, project, apiKeys, endpoints, subscriptions, events];
  const isPending = queries.some((query) => query.isPending);
  const isError = queries.some((query) => query.isError);

  const organization = organizations.data?.rows.find((row) => row.id === orgId);
  const endpointRows = endpoints.data?.rows ?? [];
  const subscriptionRows = subscriptions.data?.rows ?? [];

  const inputs: SetupInputs = {
    organizationName: organization?.name ?? null,
    projectName: project.data?.name ?? null,
    projectEnvironment: project.data?.environment ?? null,
    activeApiKeyCount: (apiKeys.data?.rows ?? []).filter((key) => key.status === 'active').length,
    deliverableEndpointCount: endpointRows.filter(isDeliverable).length,
    blockedEndpointCount: endpointRows.filter(
      (endpoint) => endpoint.status !== 'deleted' && !isDeliverable(endpoint),
    ).length,
    enabledSubscriptionCount: subscriptionRows.filter((row) => row.enabled).length,
    disabledSubscriptionCount: subscriptionRows.filter((row) => !row.enabled).length,
    eventCount: events.data?.rows.length ?? 0,
  };

  return { steps: deriveSetupSteps(inputs), isPending, isError };
}

/**
 * Setup state, plus the answer to "should a setup affordance be on screen".
 *
 * The rule lives in `setup-visibility.ts`; this is the React half of it — read
 * the live check, record it once it resolves, and fall back to the recorded
 * value while it is unresolved. Nothing is persisted: see that module for why a
 * stored value would be a completion flag by another name.
 */
export function useSetupAffordance(
  orgId: string,
  projectId: string,
): { affordance: SetupAffordance; setup: SetupState } {
  const setup = useSetupState(orgId, projectId);
  const complete = isSetupComplete(setup.steps);
  const resolved = !setup.isPending && !setup.isError;

  useEffect(() => {
    if (resolved) rememberSetupCompleteness(projectId, complete);
  }, [resolved, complete, projectId]);

  // A failure is remembered as a failure, not as an answer. React Query
  // refetches a failed query on the next mount, and an in-flight retry reports
  // as pending with no data — so without this, walking between pages during an
  // outage would drop the Setup item and bring it back on every navigation.
  useEffect(() => {
    if (setup.isError) rememberSetupCheckFailed(projectId);
  }, [setup.isError, projectId]);

  /*
   * Read during render, which is safe here because the map only ever changes as
   * a RESULT of a render that already had the live answer: every transition
   * into pending or error comes from a query state change, and that re-renders
   * on its own. The fallback is never the reason a render is needed.
   */
  const affordance = resolveSetupAffordance(
    { isPending: setup.isPending, isError: setup.isError, isComplete: complete },
    setupMemory(projectId),
  );

  return { affordance, setup };
}
