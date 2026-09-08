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
import { useApiKeys } from '../api-keys/api';
import { useEndpoints, useSubscriptions } from '../endpoints/api';
import { useEvents } from '../events/api';
import { useOrganizations } from '../organizations/api';
import { useProject } from '../projects/api';
import { deriveSetupSteps, type SetupInputs, type SetupStep } from './setup';

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
 * endpoint auto-disabled after twenty consecutive failures still reads
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
