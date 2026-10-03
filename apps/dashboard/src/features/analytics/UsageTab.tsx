import { useQueries } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Async, Badge, EmptyState, Panel, Skeleton } from '../../components';
import { formatCount } from '../../lib/format';
import type { Project } from '../../types/api';
import { DEFAULT_ANALYTICS_LIMIT, MAX_WINDOW_HOURS } from '../../types/api';
import { useProjects } from '../projects/api';
import { deliveryOutcomesQuery, eventVolumeQuery } from './api';
import { deliveriesPerEvent, formatRatio } from './derive';
import { describeFailure } from './tiles';
import type { AnalyticsWindowChoice, AnalyticsWindowKey } from './window';
import { DEFAULT_WINDOW_KEY } from './window';

/**
 * Usage, from what exists — the second half of Analytics.
 *
 * There is NO usage route and NO billing period on the control API — not a
 * stub, not a shape. What there is: per-project analytics. So this tab is the
 * organization's projects, one row each, with events published and deliveries
 * created over THE WINDOW THE PAGE IS SET TO, read from `analytics/events` and
 * `analytics/deliveries`, and the routing ratio between them. Each row is its
 * own pair of requests and lands on its own.
 *
 * The window is the page's, not this tab's. It used to be pinned at 720 hours
 * on a page of its own, which meant the dashboard had two disagreeing notions
 * of "the window"; now the selector in the page header governs these rows and
 * the delivery panels alike, and `30d` is still here as the widest of the four.
 *
 * What it is NOT is said on the tab: these are rolling windows ending at the
 * moment each row was fetched, not a calendar month and not anything an
 * invoice is calculated from. `BillingPage` points here as "real numbers", and
 * they are — they are just not billing numbers.
 *
 * Only the first page of projects is read. Every project costs two throttled
 * requests (120 per five minutes per route), so an organization at the ceiling
 * of projects is the one to be careful with, and paging through all of them
 * would be the wrong kind of thorough. This is also why the tab is a tab: the
 * queries mount when someone asks for consumption, not on every reload of the
 * delivery panels during an incident.
 *
 * The cost of that page limit is that THIS PROJECT MAY HAVE NO ROW — an
 * organization with more projects than a page can push it off the list, and the
 * ratio for it is then nowhere on the screen. Rather than pin a row that would
 * either sit outside the total that claims to be "the sum of the rows above" or
 * be quietly added to it, the panel description says it plainly and points at
 * the two figures the Delivery tab carries.
 */
export function UsageTab({
  orgId,
  projectId,
  windowKey,
  window,
}: {
  orgId: string;
  /**
   * The project the PAGE is anchored to. The table is organization-wide and
   * does not need it; the honesty about what the table is missing does — see
   * the `hasMore` description below.
   */
  projectId: string;
  windowKey: AnalyticsWindowKey;
  window: AnalyticsWindowChoice;
}) {
  const projects = useProjects(orgId);

  return (
    <div className="flex flex-col gap-4 pt-4">
      <Panel>
        <p className="text-xs leading-relaxed text-ink-muted">
          <strong className="font-medium text-ink">
            These are rolling windows, not a billing period.
          </strong>{' '}
          Each row is read from that project’s analytics routes at{' '}
          <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-2xs">
            window_hours={window.hours}
          </code>{' '}
          — the window this page is set to — and it ends at the moment the row was fetched, not at
          a month boundary. The control API has no usage or billing module, so nothing here is
          metered, invoiced or tied to a calendar month; it is the same delivery ledger the{' '}
          <span className="text-ink">Delivery</span> tab reads, summed one project at a time.{' '}
          <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-2xs">
            30d
          </code>{' '}
          is the widest comparison available — {MAX_WINDOW_HOURS} hours is the API’s ceiling. Each
          project costs two throttled requests (120 per five minutes per route), so reload
          sparingly on a large organization.
        </p>
      </Panel>

      <Async
        query={projects}
        isEmpty={(page) => page.rows.length === 0}
        empty={
          <Panel>
            <EmptyState
              title="No projects"
              description="Usage is per project, and this organization has none yet."
            />
          </Panel>
        }
      >
        {(page) => (
          <Panel
            flush
            title={`By project over the ${window.label.toLowerCase()}`}
            description={describeCoverage(page.hasMore, page.rows, projectId)}
          >
            <UsageTable
              orgId={orgId}
              projects={page.rows}
              windowKey={windowKey}
              window={window}
            />
            <div className="border-t border-line px-4 py-2.5">
              <p className="text-2xs leading-relaxed text-ink-subtle">
                Deliveries per event is deliveries created ÷ events published — how many endpoints
                an average publish reached in that project. It is the same division the{' '}
                <span className="text-ink-muted">Delivery</span> tab’s event volume panel explains,
                computed here for every project and for the organization, and it is “—” for a
                project that published nothing in the window rather than a zero. A row still
                loading shows a placeholder and one whose figures failed shows “no figure”, so “—”
                is never a row that has not answered yet.
              </p>
            </div>
          </Panel>
        )}
      </Async>
    </div>
  );
}

/**
 * What the table covers, and — when it is a page rather than the whole set —
 * whether the project this page is anchored to is one of the rows. "The
 * organization has more" is useless to the operator whose own project is the
 * one missing, so that case is named.
 */
function describeCoverage(hasMore: boolean, rows: Project[], projectId: string): string {
  if (!hasMore) {
    return `${rows.length} ${rows.length === 1 ? 'project' : 'projects'}. Every project in the organization is listed.`;
  }
  const listed = rows.some((row) => row.id === projectId);
  const shown = `Only the first ${rows.length} projects are shown — the organization has more, and their usage is not included below.`;
  return listed
    ? shown
    : `${shown} This page’s own project is one of them: its events published and deliveries created are on the Delivery tab.`;
}

function UsageTable({
  orgId,
  projects,
  windowKey,
  window,
}: {
  orgId: string;
  projects: Project[];
  windowKey: AnalyticsWindowKey;
  window: AnalyticsWindowChoice;
}) {
  // One query per project per route, under exactly the keys the Delivery tab
  // uses — same window, same limit — so the project you are already looking at
  // costs nothing here, and switching tabs does not re-fetch its two figures.
  // The number of queries is the number of projects on this page and never
  // changes between renders of the same page, which is what makes `useQueries`
  // legal here.
  const events = useQueries({
    queries: projects.map((project) =>
      eventVolumeQuery(project.id, window.hours, DEFAULT_ANALYTICS_LIMIT),
    ),
  });
  const deliveries = useQueries({
    queries: projects.map((project) => deliveryOutcomesQuery(project.id, window.hours)),
  });

  const everyRowLoaded = events.every((q) => q.isSuccess) && deliveries.every((q) => q.isSuccess);
  const totals = everyRowLoaded
    ? {
        events: events.reduce((sum, q) => sum + (q.data?.total ?? 0), 0),
        deliveries: deliveries.reduce((sum, q) => sum + (q.data?.current.total ?? 0), 0),
      }
    : null;

  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          {`Events published and deliveries created per project over the ${window.label.toLowerCase()}`}
        </caption>
        <thead>
          <tr className="border-b border-line">
            <Th>Project</Th>
            <Th align="right">Events published</Th>
            <Th align="right">Deliveries created</Th>
            <Th align="right">Deliveries per event</Th>
            <Th align="right">Window ends</Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project, index) => (
            <UsageRow
              key={project.id}
              orgId={orgId}
              project={project}
              windowKey={windowKey}
              events={events[index]}
              deliveries={deliveries[index]}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-raised/40">
            <th scope="row" className="px-3 py-2 text-left text-xs font-medium text-ink">
              Total
              <span className="ml-1.5 text-2xs font-normal text-ink-subtle">
                sum of the rows above
              </span>
            </th>
            {totals ? (
              <>
                <Td align="right" className="font-medium text-ink">
                  {formatCount(totals.events)}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {formatCount(totals.deliveries)}
                </Td>
                <Td align="right" className="text-ink-muted">
                  {formatRatio(deliveriesPerEvent(totals.deliveries, totals.events))}
                </Td>
                <Td align="right" className="text-ink-subtle">
                  —
                </Td>
              </>
            ) : (
              <td colSpan={4} className="px-3 py-2 text-right text-2xs text-ink-subtle">
                Totals appear once every project has loaded; a row that failed leaves them
                unstated rather than understated.
              </td>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

type RowQuery<T> = { isPending: boolean; isError: boolean; error: unknown; data?: T; refetch: () => unknown };

function UsageRow({
  orgId,
  project,
  windowKey,
  events,
  deliveries,
}: {
  orgId: string;
  project: Project;
  windowKey: AnalyticsWindowKey;
  events: RowQuery<{ total: number; window: { to: string } }>;
  deliveries: RowQuery<{ current: { total: number } }>;
}) {
  // The window travels with the link, so the project you open answers the same
  // question these rows were asked. The default is left out of the address.
  const search = windowKey === DEFAULT_WINDOW_KEY ? '' : `?window=${windowKey}`;

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-3 py-2 align-middle">
        <Link
          to={`/orgs/${orgId}/projects/${project.id}/analytics${search}`}
          className="flex flex-col hover:underline"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
            {project.name}
            <Badge tone={project.environment === 'live' ? 'ok' : 'neutral'}>
              {project.environment}
            </Badge>
          </span>
          <span className="font-mono text-2xs text-ink-subtle">{project.slug}</span>
        </Link>
      </td>
      <Cell query={events} render={(data) => formatCount(data.total)} label="events" />
      <Cell
        query={deliveries}
        render={(data) => formatCount(data.current.total)}
        label="deliveries"
      />
      <RatioCell events={events} deliveries={deliveries} />
      <Cell
        query={events}
        render={(data) => (
          <time dateTime={data.window.to} className="text-2xs text-ink-subtle">
            {data.window.to.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')}
          </time>
        )}
        label="window"
      />
    </tr>
  );
}

/**
 * Deliveries per event, gated on BOTH of the requests it divides.
 *
 * `deliveriesPerEvent` returns null for "no events" and for "no data yet", and
 * `formatRatio` renders null as "—" — which the footnote below the table defines
 * as a project that published nothing. So a bare cell claimed a row had
 * published nothing while the row beside it still said "Loading events", and
 * claimed it again next to "Could not load". A pending pair renders the same
 * placeholder as the counts; a failed pair says the figure is missing rather
 * than naming a cause the cells beside it already name, with the retry that
 * would fix both. Only a loaded pair is allowed to say "—", and then it means
 * what the footnote says it means.
 */
function RatioCell({
  events,
  deliveries,
}: {
  events: RowQuery<{ total: number }>;
  deliveries: RowQuery<{ current: { total: number } }>;
}) {
  if (events.isPending || deliveries.isPending) {
    return (
      <Td align="right">
        <span className="sr-only" role="status">
          Loading deliveries per event
        </span>
        <Skeleton className="ml-auto h-3 w-12" />
      </Td>
    );
  }
  if (events.isError || deliveries.isError) {
    return (
      <Td align="right" className="text-ink-subtle">
        <span className="text-2xs">no figure</span>
      </Td>
    );
  }
  return (
    <Td align="right" className="text-ink-muted">
      {formatRatio(deliveriesPerEvent(deliveries.data?.current.total, events.data?.total))}
    </Td>
  );
}

/**
 * One cell, one request. Loading is a placeholder, failure is the reason and
 * the request id — in the cell, so the rows that did load stay readable and
 * the one that did not is not mistaken for zero.
 */
function Cell<T>({
  query,
  render,
  label,
}: {
  query: RowQuery<T>;
  render: (data: T) => ReactNode;
  label: string;
}) {
  if (query.isPending) {
    return (
      <Td align="right">
        <span className="sr-only" role="status">
          Loading {label}
        </span>
        <Skeleton className="ml-auto h-3 w-12" />
      </Td>
    );
  }
  if (query.isError) {
    const failure = describeFailure(query.error);
    return (
      <Td align="right">
        <span role="alert" className="flex flex-col items-end gap-0.5">
          <span className="text-xs text-danger">Could not load</span>
          <span className="max-w-[16rem] text-2xs leading-snug text-ink-subtle">
            {failure.message}
            {failure.requestId && (
              <>
                {' '}
                <span className="font-mono">request_id: {failure.requestId}</span>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="text-2xs text-accent hover:underline"
          >
            Retry
          </button>
        </span>
      </Td>
    );
  }
  return (
    <Td align="right" className="text-ink">
      {render(query.data as T)}
    </Td>
  );
}

function Th({ children, align }: { children: ReactNode; align?: 'right' }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 text-2xs font-medium uppercase tracking-wider text-ink-subtle ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
}: {
  children: ReactNode;
  align?: 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2 align-middle text-xs ${align === 'right' ? 'text-right tabular' : 'text-left'} ${className ?? ''}`}
    >
      {children}
    </td>
  );
}
