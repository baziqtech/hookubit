import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Paged } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { DeliveryOutcomes, EventVolume, Project } from '../../types/api';
import { DEFAULT_ANALYTICS_LIMIT } from '../../types/api';
import { AnalyticsPage, readAnalyticsTab } from './AnalyticsPage';
import { usageRedirectPath } from './UsageRedirect';

const ORG = 'org_1';
const PROJECT = 'proj_payments';
const SIBLING = 'proj_rides';

const WINDOW = {
  hours: 24,
  from: '2026-03-03T00:00:00.000Z',
  to: '2026-03-04T00:00:00.000Z',
  previous_from: '2026-03-02T00:00:00.000Z',
  previous_to: '2026-03-03T00:00:00.000Z',
};

function project(id: string, name: string, slug: string): Project {
  return {
    id,
    organization_id: ORG,
    name,
    slug,
    environment: 'live',
    status: 'active',
    allowed_ips: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function outcomes(total: number, hours: number): DeliveryOutcomes {
  const summary = {
    total,
    succeeded: total,
    failing: 0,
    exhausted: 0,
    in_flight: 0,
    cancelled: 0,
    success_rate: total > 0 ? 1 : null,
    by_status: {
      pending: 0,
      scheduled: 0,
      queued: 0,
      processing: 0,
      succeeded: total,
      failed: 0,
      retrying: 0,
      exhausted: 0,
      cancelled: 0,
    },
  };
  return {
    window: { ...WINDOW, hours },
    current: summary,
    previous: { ...summary, total: 0, succeeded: 0, success_rate: null, by_status: { ...summary.by_status, succeeded: 0 } },
    success_rate_delta: null,
    total_delta: total,
  };
}

function eventVolume(total: number, hours: number): EventVolume {
  return {
    window: { ...WINDOW, hours },
    total,
    previous_total: 0,
    total_delta: total,
    by_type: total > 0 ? [{ event_type: 'payment.settled', count: total }] : [],
    has_more: false,
  };
}

/**
 * The page rendered THROUGH its real hooks, against a query cache seeded with
 * the responses — no DOM in this workspace, and none needed: `useQuery` and
 * `useQueries` resolve synchronously from a populated cache, `useSearchParams`
 * reads the MemoryRouter, and the markup is asserted as a string.
 *
 * `hours` is the window the cache is seeded AT. Seeding one window and asking
 * for another is how these tests prove the figures follow the selector: a
 * figure read at the wrong `window_hours` is a cache miss, and a cache miss
 * renders a placeholder rather than a number.
 */
function renderPage({
  search = '',
  hours = 24,
  projects = [project(PROJECT, 'Payments', 'payments'), project(SIBLING, 'Rides', 'rides')],
  perProject = {
    [PROJECT]: { events: 40, deliveries: 100 },
    [SIBLING]: { events: 10, deliveries: 20 },
  },
}: {
  search?: string;
  hours?: number;
  projects?: Project[];
  perProject?: Record<string, { events: number; deliveries: number }>;
} = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  client.setQueryData(queryKeys.projects(ORG, 0), {
    rows: projects,
    hasMore: false,
    nextOffset: null,
  } satisfies Paged<Project>);

  for (const [id, counts] of Object.entries(perProject)) {
    client.setQueryData(queryKeys.analyticsDeliveries(id, hours), outcomes(counts.deliveries, hours));
    client.setQueryData(
      queryKeys.analyticsEvents(id, hours, DEFAULT_ANALYTICS_LIMIT),
      eventVolume(counts.events, hours),
    );
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/orgs/${ORG}/projects/${PROJECT}/analytics${search}`]}>
        <Routes>
          <Route
            path="/orgs/:orgId/projects/:projectId/analytics"
            element={<AnalyticsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('readAnalyticsTab', () => {
  it('opens on the delivery panels by default', () => {
    expect(readAnalyticsTab(null)).toBe('delivery');
    expect(readAnalyticsTab(undefined)).toBe('delivery');
    expect(readAnalyticsTab('')).toBe('delivery');
  });

  it('treats an unknown ?tab= as the default rather than an error', () => {
    expect(readAnalyticsTab('billing')).toBe('delivery');
    expect(readAnalyticsTab('Usage')).toBe('delivery');
    expect(readAnalyticsTab('usage')).toBe('usage');
  });
});

describe('AnalyticsPage — one page, two tabs', () => {
  it('carries both halves behind one window selector', () => {
    const html = renderPage();

    // One h1, one control group, two tabs.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Analytics');
    expect(html.match(/aria-label="Window"/g)).toHaveLength(1);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Analytics view"');
    expect(html).toContain('>Delivery<');
    expect(html).toContain('>Usage<');

    // And it says the window governs both, rather than leaving it implied.
    expect(html).toContain('One window governs both tabs');
  });

  it('shows the delivery panels first — the 2am answer, not the consumption table', () => {
    const html = renderPage();

    expect(html).toContain('Delivery over time');
    expect(html).toContain('Delivery outcomes');
    expect(html).toContain('Failing endpoints');
    expect(html).toContain('Attempt latency');
    expect(html).toContain('Event volume');

    // The per-project table is behind the tab, not appended to the scroll: its
    // queries are two per project and this is the page an operator reloads.
    expect(html).not.toContain('Events published</th>');
    expect(html).not.toContain('sum of the rows above');
  });

  it('divides deliveries per event in ONE place, on the Usage tab', () => {
    const delivery = renderPage();
    // The tile that used to sit in Event volume is gone; the panel says where
    // the ratio went rather than dropping it silently.
    expect(delivery).not.toContain('Deliveries per event');
    expect(delivery).toContain('the ratio between them is on the Usage tab');

    // One column, on the Usage tab, plus the footnote that says what it divides.
    const usage = renderPage({ search: '?tab=usage' });
    expect(usage.match(/>Deliveries per event<\/th>/g)).toHaveLength(1);
    expect(usage).toContain('deliveries created ÷ events published');
    // 100 deliveries over 40 events, for the project — and the organization's
    // 120 over 50 in the totals row.
    expect(usage).toContain('2.50×');
    expect(usage).toContain('2.40×');
  });

  it('lists every project on the Usage tab, with a total that is stated only when complete', () => {
    const html = renderPage({ search: '?tab=usage' });

    expect(html).toContain('Payments');
    expect(html).toContain('Rides');
    expect(html).toContain('sum of the rows above');
    expect(html).toContain('2 projects. Every project in the organization is listed.');

    // The delivery panels are not also rendered — one tab's requests at a time.
    expect(html).not.toContain('Delivery over time');

    // And the caveat survived the merge intact.
    expect(html).toContain('These are rolling windows, not a billing period.');
    expect(html).toContain('no usage or billing module');
  });

  it('leaves the totals unstated rather than understated when a row has not loaded', () => {
    const html = renderPage({
      search: '?tab=usage',
      perProject: { [PROJECT]: { events: 40, deliveries: 100 } },
    });

    expect(html).toContain('Totals appear once every project has loaded');
    // No summed figure at all — not the counts and not the ratio over them.
    expect(html).not.toContain('2.40×');
    expect(html).toContain('Loading events');
  });

  it('reads the per-project rows at the SELECTED window, not a hard-coded 30 days', () => {
    // Seeded at 168 hours and asked for `?window=7d`: every figure resolves.
    const seven = renderPage({ search: '?tab=usage&window=7d', hours: 168 });
    expect(seven).toContain('window_hours=168');
    expect(seven).toContain('By project over the last 7 days');
    expect(seven).toContain('2.50×');
    // The window travels with the per-project links, so the project you open
    // answers the question the rows were asked.
    expect(seven).toContain(`/orgs/${ORG}/projects/${SIBLING}/analytics?window=7d`);

    // The same cache asked for 24h is a miss: placeholders, never a zero.
    const day = renderPage({ search: '?tab=usage', hours: 168 });
    expect(day).toContain('window_hours=24');
    expect(day).toContain('Loading events');
    expect(day).not.toContain('2.50×');
  });

  it('keeps the default window and the default tab out of the address', () => {
    const html = renderPage({ search: '?tab=usage' });
    // 24h is the default, so a link back to a project carries no ?window=.
    expect(html).toContain(`/orgs/${ORG}/projects/${SIBLING}/analytics"`);
  });

  it('sends a project-less organization somewhere useful instead of an empty table', () => {
    const html = renderPage({ search: '?tab=usage', projects: [], perProject: {} });
    expect(html).toContain('No projects');
    expect(html).toContain('Usage is per project, and this organization has none yet.');
  });
});

describe('usageRedirectPath', () => {
  /*
   * `/orgs/:orgId/usage` is bookmarked and linked from billing. It has no
   * project in it and Analytics does, so the redirect resolves one — and pins
   * 30 days, because that is the window the old page was hard-coded to and a
   * bookmark should keep meaning what it meant.
   */
  it('lands on the Usage tab of a project, over the 30 days the old page showed', () => {
    expect(usageRedirectPath(ORG, PROJECT)).toBe(
      `/orgs/${ORG}/projects/${PROJECT}/analytics?tab=usage&window=30d`,
    );
    expect(readAnalyticsTab(new URLSearchParams(usageRedirectPath(ORG, PROJECT).split('?')[1]).get('tab'))).toBe(
      'usage',
    );
  });
});
