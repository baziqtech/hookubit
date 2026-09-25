import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { RailGroups } from '../../layouts/AppLayout';
import * as mock from '../../lib/mock/data';
import type { Paged } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { ApiKey, Endpoint, Organization, Project, Subscription, WebhookEvent } from '../../types/api';
import { OverviewPage } from '../overview/OverviewPage';
import { GetStartedPage } from './GetStartedPage';
import { forgetSetupCompleteness, rememberSetupCompleteness } from './setup-visibility';

const ORG = mock.organizations[0];
const PROJECT = mock.projects[0];
const BASE = `/orgs/${ORG.id}/projects/${PROJECT.id}`;
const SETUP_HREF = `${BASE}/get-started`;

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/**
 * Rows built by spreading the mock API's own, so every field the derivation
 * reads is the field the wire carries — and the counts are ours, so the evidence
 * strings the checklist prints are exact.
 */
const liveEndpoint = (id: string): Endpoint => ({
  ...mock.endpoints[0],
  id,
  project_id: PROJECT.id,
  status: 'active',
  enabled: true,
  has_live_secret: true,
});

const enabledSubscription = (id: string): Subscription => ({
  ...mock.subscriptions[0],
  id,
  project_id: PROJECT.id,
  enabled: true,
});

const activeKey = (id: string): ApiKey => ({
  ...mock.apiKeys[0],
  id,
  project_id: PROJECT.id,
  status: 'active',
  revoked_at: null,
});

const page = <T,>(rows: T[]): Paged<T> => ({ rows, hasMore: false, nextOffset: null });

interface Inputs {
  keys?: ApiKey[];
  endpoints?: Endpoint[];
  subscriptions?: Subscription[];
  events?: WebhookEvent[];
}

/** Everything satisfied: one key, three delivering endpoints, four live subscriptions, an event. */
const OPERATING: Inputs = {
  keys: [activeKey('key_live')],
  endpoints: [liveEndpoint('ep_1'), liveEndpoint('ep_2'), liveEndpoint('ep_3')],
  subscriptions: [
    enabledSubscription('sub_1'),
    enabledSubscription('sub_2'),
    enabledSubscription('sub_3'),
    enabledSubscription('sub_4'),
  ],
  events: [mock.events[0]],
};

/* ── Harness ──────────────────────────────────────────────────────────────── */

/**
 * The real hooks against a seeded cache — `useQuery` resolves synchronously from
 * a populated entry, so the markup is the markup a resolved check produces. A
 * key left UNSEEDED is a query that is still pending, which is how the cold load
 * is reproduced here; `failing` seeds an error state instead, for the branch
 * where the check cannot resolve at all.
 */
function client({ keys, endpoints, subscriptions, events }: Inputs, failing?: QueryKey): QueryClient {
  // `retryOnMount: false` is what lets a seeded error state RENDER as an error:
  // React Query otherwise reports an errored query with no data as pending again
  // the moment an observer mounts, because it is optimistically refetching. That
  // transient really happens in the browser too — it is why the session
  // remembers a failure rather than only a completeness.
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });

  query.setQueryData(queryKeys.organizations(0), page<Organization>([ORG]));
  query.setQueryData(queryKeys.project(PROJECT.id), PROJECT satisfies Project);
  if (keys) query.setQueryData(queryKeys.apiKeys(PROJECT.id, 0), page(keys));
  if (endpoints) query.setQueryData(queryKeys.endpoints(PROJECT.id, 0, undefined), page(endpoints));
  if (subscriptions) query.setQueryData(queryKeys.subscriptions(PROJECT.id, 0), page(subscriptions));
  if (events) query.setQueryData(queryKeys.events(PROJECT.id, {}, 0), page(events));

  if (failing) {
    query
      .getQueryCache()
      .build(query, { queryKey: failing })
      .setState({
        status: 'error',
        fetchStatus: 'idle',
        error: new Error('the control API could not be reached'),
        errorUpdatedAt: Date.now(),
      });
  }

  return query;
}

function render(node: React.ReactNode, at: string, path: string, inputs: Inputs, failing?: QueryKey): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(inputs, failing)}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={path} element={node} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rail = (inputs: Inputs, failing?: QueryKey) =>
  render(
    <RailGroups orgId={ORG.id} projectId={PROJECT.id} />,
    `${BASE}/overview`,
    '/orgs/:orgId/projects/:projectId/overview',
    inputs,
    failing,
  );

const overview = (inputs: Inputs, failing?: QueryKey) =>
  render(<OverviewPage />, `${BASE}/overview`, '/orgs/:orgId/projects/:projectId/overview', inputs, failing);

const getStarted = (inputs: Inputs) =>
  render(<GetStartedPage />, SETUP_HREF, '/orgs/:orgId/projects/:projectId/get-started', inputs);

/* ── The rule ─────────────────────────────────────────────────────────────── */

describe('a fully set-up project offers no setup affordance', () => {
  beforeEach(() => forgetSetupCompleteness());

  it('drops the Setup item out of the rail entirely, badge and all', () => {
    const html = rail(OPERATING);

    expect(html).not.toContain(SETUP_HREF);
    expect(html).not.toContain('>Setup<');
    // Not a green 6/6 in its place either: the item is gone, not decorated.
    expect(html).not.toContain('6/6');
    // The rest of the rail is untouched.
    expect(html).toContain(`${BASE}/deliveries`);
  });

  it('leaves the overview as the health dashboard, with no checklist and no link to one', () => {
    const html = overview(OPERATING);

    expect(html).toContain('Delivery health for this project.');
    expect(html).not.toContain('Open setup checklist');
    expect(html).not.toContain('This project cannot deliver a webhook yet');
  });

  it('still renders /get-started, with all six steps satisfied and their current values', () => {
    /*
     * The page is no longer ADVERTISED; it is not gone. Docs, emails and
     * bookmarks point at it, and re-reading what you configured is a legitimate
     * reason to be here — so it neither 404s nor bounces to the overview.
     */
    const html = getStarted(OPERATING);

    expect(html).toContain('Get started');
    expect(html).toContain('Setup complete');
    expect(html).toContain('6 of 6');

    // Current values, not ticks: the page answers "what did I configure?".
    expect(html).toContain('1 active key');
    expect(html).toContain('3 endpoints delivering');
    expect(html).toContain('4 active subscriptions');
    expect(html).toContain('1 event received');
    expect(html).not.toContain('Not started');
    expect(html).not.toContain('Do this next');
  });
});

describe('a project short of six shows every affordance', () => {
  beforeEach(() => forgetSetupCompleteness());

  const NO_EVENT: Inputs = { ...OPERATING, events: [] };

  it('carries the Setup item and its progress badge', () => {
    const html = rail(NO_EVENT);

    expect(html).toContain(SETUP_HREF);
    expect(html).toContain('5/6');
  });

  it('turns the overview into the guided path', () => {
    const html = overview(NO_EVENT);

    expect(html).toContain('This project cannot deliver a webhook yet');
    expect(html).toContain('Open setup checklist');
    expect(html).toContain('Publish a test event');
  });
});

describe('regression below six brings everything back', () => {
  beforeEach(() => forgetSetupCompleteness());

  /*
   * No re-onboarding path and no dismissal to respect, because completeness was
   * never stored: the derivation reads live project state, so losing a
   * prerequisite is simply a project that is incomplete again. Each case below
   * is remembered as COMPLETE first, which is what a stored flag — or a cached
   * fallback consulted too eagerly — would have hidden behind.
   */
  const regressions: Array<[string, Inputs]> = [
    ['the last active key is revoked', { ...OPERATING, keys: [] }],
    [
      'the only sending endpoints are paused',
      {
        ...OPERATING,
        endpoints: OPERATING.endpoints!.map((endpoint) => ({ ...endpoint, enabled: false })),
      },
    ],
    ['the last subscription is deleted', { ...OPERATING, subscriptions: [] }],
  ];

  for (const [name, inputs] of regressions) {
    it(`re-offers the Setup item and its badge when ${name}`, () => {
      rememberSetupCompleteness(PROJECT.id, true);
      const html = rail(inputs);

      // A resolved check overrides what was last known, in both directions.
      expect(html).toContain(SETUP_HREF);
      expect(html).toContain('5/6');
    });
  }

  it('shows the overview checklist again, naming the step that is no longer satisfied', () => {
    rememberSetupCompleteness(PROJECT.id, true);
    const html = overview({ ...OPERATING, subscriptions: [] });

    expect(html).toContain('Open setup checklist');
    expect(html).toContain('Bind an endpoint to the event types it cares about');
  });

  it('brings the overview checklist back when the only sending endpoints are paused', () => {
    /*
     * The case that caught the derivation out: the endpoint rows still exist, so
     * the step is amber rather than untouched — and `attention` used to count as
     * satisfied, which reported 6/6 on a project incapable of delivering
     * anything. The affordances have to survive that, or the project that most
     * needs the checklist is the one that cannot reach it.
     */
    const paused = OPERATING.endpoints!.map((endpoint) => ({ ...endpoint, enabled: false }));
    const html = overview({ ...OPERATING, endpoints: paused });

    expect(html).toContain('Open setup checklist');
    expect(html).toContain('Nothing will be delivered until one is live');
  });
});

describe('an unresolved check neither hides nor shows spuriously', () => {
  beforeEach(() => forgetSetupCompleteness());

  it('renders no Setup item on a cold load, so an operating project cannot flicker one', () => {
    /*
     * Nothing seeded: this is the first paint, before any input has landed. The
     * derivation reads an empty project as 2/6, and rendering that would flash a
     * setup badge onto every operating project on every load. `unknown` renders
     * the same nothing a complete project does — so the operating case goes
     * nothing → nothing, with no frame in between.
     */
    const html = rail({});

    expect(html).not.toContain(SETUP_HREF);
    expect(html).not.toContain('2/6');
    // A slot left empty, not a rail left broken.
    expect(html).toContain(`${BASE}/overview`);
  });

  it('renders the last value known for the project instead, when there is one', () => {
    rememberSetupCompleteness(PROJECT.id, false);
    const half = rail({});

    // Known-incomplete: the item is back the instant the page mounts, with no
    // number on it — a count needs a resolved check, and "0/6" would be a lie.
    expect(half).toContain(SETUP_HREF);
    expect(half).not.toContain('/6');
  });

  it('keeps the item when the check FAILED and nothing is remembered', () => {
    // Hiding here would be indistinguishable from reporting the project ready,
    // and an error does not resolve itself the way a pending check does.
    const html = rail({ ...OPERATING, endpoints: undefined }, queryKeys.endpoints(PROJECT.id, 0, undefined));

    expect(html).toContain(SETUP_HREF);
    expect(html).not.toContain('/6');
  });

  it('honours a remembered "complete" through a failed check, rather than nagging a live project', () => {
    rememberSetupCompleteness(PROJECT.id, true);
    const html = rail({ ...OPERATING, endpoints: undefined }, queryKeys.endpoints(PROJECT.id, 0, undefined));

    expect(html).not.toContain(SETUP_HREF);
  });

  it('leaves the overview operating when the check fails, per the errored design frame', () => {
    // 07b: stat tiles and the needs-attention panel stay, with a non-blocking
    // strip. The page does not flip to the setup path because a request failed.
    const html = overview({ ...OPERATING, endpoints: undefined }, queryKeys.endpoints(PROJECT.id, 0, undefined));

    expect(html).toContain('Delivery health for this project.');
    expect(html).not.toContain('Open setup checklist');
  });

  it('does not flash the setup card onto the overview during a cold load', () => {
    const html = overview({});

    expect(html).not.toContain('Open setup checklist');
    expect(html).not.toContain('This project cannot deliver a webhook yet');
  });
});
