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
 *
 * Three things an input can be, besides answered:
 *
 * - NOT APPLICABLE — this member's role may not read it. `permissions.ts`; the
 *   query is never issued and the step becomes `unavailable`.
 * - FAILED — it could not be read. `isError`, and the affordance errs towards
 *   showing the checklist.
 * - UNDETERMINED — the page we read does not contain the answer. `isUndetermined`.
 */
import { useEffect } from 'react';
import type { Paged } from '../../lib/pagination';
import { useApiKeys } from '../api-keys/api';
import { useEndpoints, useSubscriptions } from '../endpoints/api';
import { useEvents } from '../events/api';
import { useOrganizations } from '../organizations/api';
import { useProject } from '../projects/api';
import { maySetupInputBeRead, unreadableSetupInputs } from './permissions';
import { deriveSetupSteps, isSetupComplete, type SetupInputs, type SetupStep } from './setup';
import {
  recordSetupCheck,
  resolveSetupAffordance,
  setupMemory,
  type SetupAffordance,
  type SetupCheck,
} from './setup-visibility';

export interface SetupState {
  steps: SetupStep[];
  /** True while any applicable input is still loading — the checklist must not flash "todo". */
  isPending: boolean;
  isError: boolean;
  /**
   * True when a successful read does not contain the answer: no row on the page
   * satisfied the requirement, and the server says there are more rows.
   *
   * Not an error. It is the reason completeness is not concluded from it — see
   * `answerFromPage`.
   */
  isUndetermined: boolean;
}

/**
 * An endpoint counts as deliverable only when the operator has enabled it AND
 * the circuit breaker has not taken it away. Both halves are load-bearing:
 * `enabled` is operator intent and `status` is the breaker's verdict, and an
 * endpoint auto-disabled after five consecutive failures still reads
 * `enabled: true`.
 *
 * Which is also why the count is taken client-side rather than asked for with
 * `?status=active`: the filter the list route offers covers one of the two
 * halves, and the pair is not an invariant this file is entitled to assume.
 */
function isDeliverable(endpoint: { status: string; enabled: boolean }): boolean {
  return endpoint.enabled && endpoint.status === 'active';
}

/** How many rows satisfy the requirement, and whether this page could say. */
interface PageAnswer {
  count: number;
  /** False when the page did not contain the answer. */
  determined: boolean;
}

/**
 * "Does anything here satisfy the step?", answered from ONE page — or not
 * answered at all.
 *
 * `lib/pagination.ts` opens with the rule this respects: never compare the row
 * count against `limit` to detect the last page, read `has_more`. A project
 * with more endpoints than fit on a page whose first fifty are all paused reads
 * `deliverableEndpointCount: 0` — and that is not "nothing is delivering", it is
 * "the rows we looked at are not delivering". Concluding 5/6 from it puts a
 * permanent Setup item on a project that is delivering fine.
 *
 * A count above zero is conclusive whatever `has_more` says: one live endpoint
 * satisfies the step, and further pages cannot unsatisfy it. Only the zero
 * answer is in doubt, which is why the doubt can only ever cost the checklist an
 * appearance and can never make it hide.
 *
 * A missing page means the query is pending, errored or never issued because the
 * role may not read it. Each of those is reported by its own flag, so nothing is
 * claimed here.
 */
function answerFromPage<T>(
  page: Paged<T> | undefined,
  satisfies: (row: T) => boolean,
): PageAnswer {
  if (!page) return { count: 0, determined: true };
  const count = page.rows.filter(satisfies).length;
  return { count, determined: count > 0 || !page.hasMore };
}

export function useSetupState(orgId: string, projectId: string): SetupState {
  const organizations = useOrganizations();
  const organization = organizations.data?.rows.find((row) => row.id === orgId);

  /*
   * THE ROLE DECIDES WHICH INPUTS EXIST, so it is read before the gated queries
   * are declared. An unknown role (the list has not landed, or failed) reads as
   * permitted; the check is pending or errored for the same reason anyway, and
   * guessing "denied" would drop a real input for an owner.
   */
  const role = organization?.role;
  const mayReadKeys = maySetupInputBeRead('api-key', role);
  const mayReadEndpoints = maySetupInputBeRead('endpoint', role);
  const mayReadSubscriptions = maySetupInputBeRead('subscription', role);
  const mayReadEvents = maySetupInputBeRead('event', role);

  const project = useProject(orgId, projectId);
  const apiKeys = useApiKeys(projectId, 0, mayReadKeys);
  const endpoints = useEndpoints(projectId, { enabled: mayReadEndpoints });
  const subscriptions = useSubscriptions(projectId, 0, mayReadSubscriptions);
  // One row is enough to answer "has anything ever arrived?".
  const events = useEvents(projectId, {}, 0, { enabled: mayReadEvents });

  /*
   * WATCH FOR THE FIRST EVENT.
   *
   * The last step of the checklist hands the operator a curl command and then
   * asks them to believe it worked. Refreshing a page to find out is the
   * moment a setup flow loses people — they run the command, see nothing
   * change, and go looking for what they did wrong.
   *
   * A three-second poll, and only while it can matter: the role may read events,
   * the project has none yet, the last read did not fail, and the tab is in
   * front of somebody. It stops of its own accord the moment one arrives,
   * because `refetchInterval` is a function of the data.
   *
   * BOTH STOP CONDITIONS BESIDES THE DATA ARE LOAD-BEARING, and both were
   * missing. Keyed only off `rows.length ?? 0`, a refusal or an outage reads as
   * "still nothing has arrived" and polls forever: a billing member, who holds
   * no `events.read`, fired a `GET /events` that 403'd every three seconds for
   * as long as any project page was open. Polling cures neither a 403 nor a 500,
   * and React Query's own retry already covers the transient case.
   *
   * Deliberately NOT server-sent events. The claim on screen is "this page
   * updates the moment one arrives"; a three-second poll satisfies a human
   * reading a checklist, costs one indexed query, and needs no connection to
   * keep alive, no proxy to configure and no reconnection story. SSE would be
   * the right answer for a live delivery feed, which is a different feature.
   */
  useEvents(projectId, {}, 0, {
    enabled: mayReadEvents,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      return (query.state.data?.rows.length ?? 0) > 0 ? false : 3_000;
    },
    refetchIntervalInBackground: false,
  });

  /*
   * Only the inputs this role may actually read. A query switched off never
   * resolves, so leaving a denied one in here would report `isPending` forever —
   * and leaving in the errored one it replaced is the bug this exists to fix.
   */
  const queries = [
    organizations,
    project,
    ...(mayReadKeys ? [apiKeys] : []),
    ...(mayReadEndpoints ? [endpoints] : []),
    ...(mayReadSubscriptions ? [subscriptions] : []),
    ...(mayReadEvents ? [events] : []),
  ];
  const isPending = queries.some((query) => query.isPending);
  const isError = queries.some((query) => query.isError);

  const endpointRows = endpoints.data?.rows ?? [];
  const subscriptionRows = subscriptions.data?.rows ?? [];

  const activeKeys = answerFromPage(apiKeys.data, (key) => key.status === 'active');
  const liveEndpoints = answerFromPage(endpoints.data, isDeliverable);
  const liveSubscriptions = answerFromPage(subscriptions.data, (row) => row.enabled);

  const inputs: SetupInputs = {
    organizationName: organization?.name ?? null,
    projectName: project.data?.name ?? null,
    projectEnvironment: project.data?.environment ?? null,
    activeApiKeyCount: activeKeys.count,
    deliverableEndpointCount: liveEndpoints.count,
    blockedEndpointCount: endpointRows.filter(
      (endpoint) => endpoint.status !== 'deleted' && !isDeliverable(endpoint),
    ).length,
    enabledSubscriptionCount: liveSubscriptions.count,
    disabledSubscriptionCount: subscriptionRows.filter((row) => !row.enabled).length,
    eventCount: events.data?.rows.length ?? 0,
    unreadable: unreadableSetupInputs(role),
  };

  return {
    steps: deriveSetupSteps(inputs),
    isPending,
    isError,
    isUndetermined: [activeKeys, liveEndpoints, liveSubscriptions].some(
      (answer) => !answer.determined,
    ),
  };
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
  const check: SetupCheck = {
    isPending: setup.isPending,
    isError: setup.isError,
    isUndetermined: setup.isUndetermined,
    isComplete: isSetupComplete(setup.steps),
  };

  /*
   * What this session learns, written down once per observed check.
   *
   * The body is `recordSetupCheck`, not statements inline here, because an
   * effect body cannot be tested in this workspace — `renderToStaticMarkup` does
   * not run effects and there is no jsdom — and the sticky-failure rule inside
   * it is load-bearing: React Query refetches a failed query on the next mount,
   * and an in-flight retry reports as pending with no data, so without it walking
   * between pages during an outage would drop the Setup item and bring it back on
   * every navigation. `setup-session.test.ts` drives that sequence directly.
   *
   * Deps are the primitives rather than `check`, which is a fresh object per
   * render.
   */
  const { isPending, isError, isUndetermined, isComplete } = check;
  useEffect(() => {
    recordSetupCheck(projectId, { isPending, isError, isUndetermined, isComplete });
  }, [projectId, isPending, isError, isUndetermined, isComplete]);

  /*
   * Read during render, which is safe here because the map only ever changes as
   * a RESULT of a render that already had the live answer: every transition
   * into pending or error comes from a query state change, and that re-renders
   * on its own. The fallback is never the reason a render is needed.
   */
  const affordance = resolveSetupAffordance(check, setupMemory(projectId));

  return { affordance, setup };
}
