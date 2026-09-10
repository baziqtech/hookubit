import { useQueries } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Async, Badge, EmptyState, PageHeader, Panel, Skeleton } from '../../components';
import { formatCount } from '../../lib/format';
import type { Project } from '../../types/api';
import { MAX_WINDOW_HOURS } from '../../types/api';
import { deliveryOutcomesQuery, eventVolumeQuery } from '../analytics/api';
import { fanOutRatio, formatRatio } from '../analytics/derive';
import { describeFailure } from '../analytics/tiles';
import { useProjects } from '../projects/api';

/**
 * Usage, from what exists.
 *
 * There is NO usage route and NO billing period on the control API — not a
 * stub, not a shape. What there is: per-project analytics with a 720-hour
 * ceiling. So this page is the organization's projects, one row each, with
 * events published and deliveries created over the last 30 days read from
 * `analytics/events` and `analytics/deliveries` at `window_hours=720`, and
 * the fan-out ratio between them. Each row is its own pair of requests and
 * lands on its own.
 *
 * What it is NOT is said on the page: these are rolling windows ending at the
 * moment each row was fetched, not a calendar month and not anything an
 * invoice is calculated from. `BillingPage` points here as "real numbers",
 * and they are — they are just not billing numbers.
 *
 * Only the first page of projects is read. Every project on this page costs
 * two throttled requests (120 per five minutes per route), so an organization
 * at the ceiling of projects is the one to be careful with, and paging
 * through all of them would be the wrong kind of thorough.
 */
export function UsagePage() {
  const { orgId = '' } = useParams();
  const projects = useProjects(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Usage"
        description="Events published and deliveries created per project over the last 30 days."
      />

      <Panel>
        <p className="text-xs leading-relaxed text-ink-muted">
          <strong className="font-medium text-ink">These are rolling 30-day windows, not a billing period.</strong>{' '}
          Each row is read from that project’s analytics routes at{' '}
          <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-2xs">
            window_hours={MAX_WINDOW_HOURS}
          </code>{' '}
          — the API’s ceiling — and the window ends at the moment the row was fetched. The
          control API has no usage or billing module, so nothing here is metered, invoiced or
          tied to a calendar month; it is the same delivery ledger the{' '}
          <span className="text-ink">Analytics</span> page reads, summed over 30 days. Each
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
            title="Last 30 days by project"
            description={
              page.hasMore
                ? `Only the first ${page.rows.length} projects are shown — the organization has more, and their usage is not included below.`
                : `${page.rows.length} ${page.rows.length === 1 ? 'project' : 'projects'}. Every project in the organization is listed.`
            }
          >
            <UsageTable orgId={orgId} projects={page.rows} />
          </Panel>
        )}
      </Async>
    </div>
  );
}

const WINDOW_HOURS = MAX_WINDOW_HOURS;

function UsageTable({ orgId, projects }: { orgId: string; projects: Project[] }) {
  // One query per project per route, under the same keys the Analytics page
  // uses, so a project already opened there costs nothing here. The number of
  // queries is the number of projects on this page and never changes between
  // renders of the same page, which is what makes `useQueries` legal here.
  const events = useQueries({
    queries: projects.map((project) => eventVolumeQuery(project.id, WINDOW_HOURS, 1)),
  });
  const deliveries = useQueries({
    queries: projects.map((project) => deliveryOutcomesQuery(project.id, WINDOW_HOURS)),
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
          Events published and deliveries created per project over the last 30 days
        </caption>
        <thead>
          <tr className="border-b border-line">
            <Th>Project</Th>
            <Th align="right">Events published</Th>
            <Th align="right">Deliveries created</Th>
            <Th align="right">Fan-out</Th>
            <Th align="right">Window ends</Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project, index) => (
            <UsageRow
              key={project.id}
              orgId={orgId}
              project={project}
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
                  {formatRatio(fanOutRatio(totals.deliveries, totals.events))}
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
  events,
  deliveries,
}: {
  orgId: string;
  project: Project;
  events: RowQuery<{ total: number; window: { to: string } }>;
  deliveries: RowQuery<{ current: { total: number } }>;
}) {
  const ratio = fanOutRatio(deliveries.data?.current.total, events.data?.total);

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-3 py-2 align-middle">
        <Link
          to={`/orgs/${orgId}/projects/${project.id}/analytics?window=30d`}
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
      <Td align="right" className="text-ink-muted">
        {formatRatio(ratio)}
      </Td>
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
