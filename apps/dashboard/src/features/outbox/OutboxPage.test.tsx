import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Paged } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { Organization, OutboxEntry, Role } from '../../types/api';
import { OutboxPage, readStatusChoice } from './OutboxPage';
import { ParkedEventPanel } from './ParkedEventNotice';
import { requeueGate } from './permissions';
import { idleRun, completePass } from './requeue-loop';
import { RunTally } from './RequeueDialogs';

const ORG = 'org_1';
const PROJECT = 'proj_1';

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'obx_stale',
    event_id: 'evt_stale',
    type: 'event.created',
    status: 'failed',
    attempts: 63,
    unaccounted_attempts: 0,
    last_error: 'retry_duration_exceeded: failing since 2026-03-03T10:00:00Z (1h2m0s, bound 1h0m0s)',
    failing_since: '2026-03-03T10:00:00.000Z',
    fan_out_cursor: null,
    available_at: '2026-03-03T11:02:00.000Z',
    locked_by: null,
    locked_until: null,
    processed_at: '2026-03-03T11:02:00.000Z',
    created_at: '2026-03-03T09:58:00.000Z',
    ...overrides,
  };
}

const POISON = entry({
  id: 'obx_poison',
  event_id: 'evt_poison',
  attempts: 11,
  unaccounted_attempts: 11,
  failing_since: null,
  last_error: 'attempts_exhausted: claimed 11 times (11 of them leaving no recorded outcome, bound 10)',
});

const PARTIAL = entry({
  id: 'obx_partial',
  event_id: 'evt_partial',
  attempts: 14,
  unaccounted_attempts: 11,
  fan_out_cursor: 'sub_01HALFWAY',
  last_error: 'attempts_exhausted: claimed 14 times (11 of them leaving no recorded outcome, bound 10)',
});

function organization(role: Role): Organization {
  return {
    id: ORG,
    name: 'Acme',
    slug: 'acme',
    status: 'active',
    role,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * The page rendered THROUGH its real hooks, against a query cache seeded with
 * the response — no DOM in this workspace, and no need for one: `useQuery`
 * resolves synchronously from a populated cache, `useSearchParams` reads the
 * MemoryRouter, and the markup is asserted as a string. The route is the one
 * the page is built to mount at.
 */
function renderPage({
  rows,
  hasMore = false,
  role = 'owner',
  search = '',
  filters = { status: 'failed', event_id: '' },
}: {
  rows: OutboxEntry[];
  hasMore?: boolean;
  role?: Role;
  search?: string;
  filters?: Record<string, string>;
}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page: Paged<OutboxEntry> = { rows, hasMore, nextOffset: hasMore ? 50 : null };
  client.setQueryData(queryKeys.outbox(PROJECT, filters, 0), page);
  client.setQueryData(queryKeys.organizations(0), {
    rows: [organization(role)],
    hasMore: false,
    nextOffset: null,
  } satisfies Paged<Organization>);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/orgs/${ORG}/projects/${PROJECT}/outbox${search}`]}>
        <Routes>
          <Route path="/orgs/:orgId/projects/:projectId/outbox" element={<OutboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OutboxPage', () => {
  it('lists PARKED entries by default and says what parked means before the table', () => {
    const html = renderPage({ rows: [entry(), POISON] });

    // The primer, above the rows, in plain words.
    expect(html).toContain('Parked means accepted and undelivered');
    expect(html).toContain('202 Accepted');

    // Both rows, each linked to its event.
    expect(html).toContain(`/orgs/${ORG}/projects/${PROJECT}/events/evt_stale`);
    expect(html).toContain(`/orgs/${ORG}/projects/${PROJECT}/events/evt_poison`);
    /*
     * TWICE PER ROW, and that is correct.
     *
     * `Table` renders every row twice — once as a card for phones, once as a
     * table row from `md` up — because restyling table elements into blocks
     * destroys the table semantics the operator surface depends on. Each
     * rendering is `display: none` at the other's width, so exactly one is in
     * the accessibility tree; `renderToStaticMarkup` has no CSS and therefore
     * sees both.
     */
    expect(html.match(/data-testid="parked-explanation"/g)).toHaveLength(4);

    // The filter is exposed, and its selected value is the parked set.
    expect(html).toContain('aria-label="Filter by status"');
    expect(html).toContain('Parked — needs a person');
    expect(html).toContain('aria-label="Filter by event ID"');

    // The pager states completeness rather than leaving it implied.
    expect(html).toContain('parked entries');
  });

  it('explains WHY each row parked in the operator’s terms, with the raw error kept verbatim', () => {
    const html = renderPage({ rows: [entry(), POISON, PARTIAL] });

    expect(html).toContain('Kept failing for longer than the retry window');
    expect(html).toContain('63 claims in total, 0 of them ending with nothing recorded');
    expect(html).toContain('requeue should recover it');

    expect(html).toContain('The router kept dying on this event');
    expect(html).toContain('11 claims in total, 11 of them ending with nothing recorded');
    expect(html).toContain('requeue may park it again');

    expect(html).toContain('fan-out partly done');
    expect(html).toContain('data-park-reason="attempts_exhausted"');
    expect(html).toContain('data-park-reason="retry_duration_exceeded"');

    // Verbatim, never paraphrased away.
    expect(html).toContain(
      'retry_duration_exceeded: failing since 2026-03-03T10:00:00Z (1h2m0s, bound 1h0m0s)',
    );
  });

  it('offers a requeue per row and a bulk requeue in the header, to an owner', () => {
    const html = renderPage({ rows: [entry(), POISON] });
    const buttons = html.match(/data-testid="requeue-button"/g) ?? [];
    // Two rows, each rendered as a card AND as a table row (see above), plus
    // the single bulk control in the header.
    expect(buttons).toHaveLength(5);
    expect(html).toContain('Requeue parked, 100 at a time');
    expect(html).not.toContain('aria-disabled="true"');
  });

  it('gates the actions for a viewer the way the role matrix does, and says why', () => {
    const html = renderPage({ rows: [entry()], role: 'viewer' });
    const disabled = html.match(/aria-disabled="true"/g) ?? [];
    // One row in both renderings, plus the bulk button.
    expect(disabled).toHaveLength(3);
    expect(html).toContain('You are a viewer in this organization');
    // The listing itself is unaffected: a viewer may watch the incident.
    expect(html).toContain('Kept failing for longer than the retry window');
  });

  it('keeps the buttons enabled when the role is not known — the server decides', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.outbox(PROJECT, { status: 'failed', event_id: '' }, 0), {
      rows: [entry()],
      hasMore: false,
      nextOffset: null,
    });
    // No organizations in the cache at all.
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/orgs/${ORG}/projects/${PROJECT}/outbox`]}>
          <Routes>
            <Route path="/orgs/:orgId/projects/:projectId/outbox" element={<OutboxPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain('aria-disabled="true"');
    expect(requeueGate(undefined).verdict).toBe('unknown');
  });

  it('narrows to one event from the URL and scopes the bulk action to it', () => {
    const html = renderPage({
      rows: [entry()],
      search: '?event_id=evt_stale',
      filters: { status: 'failed', event_id: 'evt_stale' },
    });
    expect(html).toContain('value="evt_stale"');
    expect(html).toContain('Requeue this event’s parked rows');
    expect(html).toContain('Open event →');
  });

  it('states when the parked set is complete versus when more is not shown', () => {
    expect(renderPage({ rows: [entry()] })).not.toContain('more not shown');
    expect(renderPage({ rows: [entry()], hasMore: true })).toContain('more not shown');
  });

  it('renders the honest empty state for the parked filter', () => {
    const html = renderPage({ rows: [] });
    expect(html).toContain('Nothing is stuck');
    expect(html).toContain('Widen the status filter');
  });

  it('widens to other statuses only when asked, and does not offer requeue there', () => {
    const html = renderPage({
      rows: [entry({ status: 'processed', last_error: null, failing_since: null })],
      search: '?status=processed',
      filters: { status: 'processed', event_id: '' },
    });
    expect(html).toContain('Fanned out');
    expect(html).not.toContain('data-testid="requeue-button"');
    expect(html).not.toContain('Parked means accepted and undelivered');
    expect(html).toContain('only parked rows can be requeued');
  });
});

describe('readStatusChoice', () => {
  it('defaults to parked and refuses to widen on a typo', () => {
    expect(readStatusChoice(null)).toBe('failed');
    expect(readStatusChoice('')).toBe('failed');
    expect(readStatusChoice('all')).toBe('all');
    expect(readStatusChoice('processing')).toBe('processing');
    expect(readStatusChoice('exhausted')).toBe('failed');
  });
});

describe('the bulk requeue loop, on screen', () => {
  it('shows every pass and whether more remain, never a bare total', () => {
    const twoPasses = completePass(completePass(idleRun, { requeued: 100, has_more: true }), {
      requeued: 4,
      has_more: false,
    });
    const html = renderToStaticMarkup(<RunTally run={twoPasses} />);

    expect(html).toContain('data-run-status="drained"');
    expect(html).toContain('pass 1: 100 · more remain');
    expect(html).toContain('pass 2: 4 · drained');
    expect(html).toContain('104 total');
    expect(html).toContain('That was all of them');
  });

  it('says "more are still parked" between passes', () => {
    const html = renderToStaticMarkup(
      <RunTally run={completePass(idleRun, { requeued: 100, has_more: true })} />,
    );
    expect(html).toContain('data-run-status="more"');
    expect(html).toContain('more are still parked');
    expect(html).not.toContain('all of them');
  });
});

describe('ParkedEventPanel — the link in from the event page', () => {
  const render = (parked: OutboxEntry[], role: Role = 'developer') =>
    renderToStaticMarkup(
      <MemoryRouter>
        <ParkedEventPanel
          orgId={ORG}
          projectId={PROJECT}
          eventId="evt_stale"
          parked={parked}
          gate={requeueGate(organization(role))}
          currentRole={role}
        />
      </MemoryRouter>,
    );

  it('explains the parked state, why replay cannot help, and offers the requeue in place', () => {
    const html = render([entry()]);
    expect(html).toContain('data-testid="parked-event-notice"');
    expect(html).toContain('parked before it fanned out');
    expect(html).toContain('there is nothing to replay');
    expect(html).toContain('Kept failing for longer than the retry window');
    expect(html).toContain('data-testid="requeue-button"');
    expect(html).toContain(
      `/orgs/${ORG}/projects/${PROJECT}/outbox?event_id=evt_stale`,
    );
  });

  it('gates the in-place requeue for a viewer', () => {
    expect(render([entry()], 'viewer')).toContain('aria-disabled="true"');
  });

  it('does not pretend to know when no parked row came back', () => {
    const html = render([]);
    expect(html).toContain('No parked outbox row was found');
    expect(html).not.toContain('data-testid="requeue-button"');
  });
});
