import { useParams, useSearchParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  Input,
  Pager,
  PageHeader,
  Panel,
  PermissionDenied,
  Table,
  type Column,
} from '../../components';
import { ApiRequestError } from '../../lib/api';
import { formatRelativeTime, formatTimestamp, truncateId } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type AuditLogEntry } from '../../types/api';
import { useOrganizations } from '../organizations/api';
import { describeActor, useAuditLogs, type AuditFilters } from './api';

/**
 * The audit log, which is the page that makes a delivery gap explainable.
 *
 * `POST …/endpoints/:id/disable` writes the operator's reason here, and until
 * this screen read the real route that reason could not be read back at all —
 * the whole point of asking for it was unreachable. "Why did finance stop
 * receiving webhooks between 02:10 and 06:40?" is answered by
 * `endpoint.disabled` plus the sentence the person typed, and by nothing else.
 *
 * ## The 403 is a first-class state, not an error
 *
 * The route is gated on `audit.read`, which OWNERS AND ADMINS hold. A viewer
 * holds `members.read`, which is a different permission — so a viewer opening
 * this page is a completely ordinary thing that must produce a clear sentence
 * about roles, not a red "request failed" panel with a retry button that will
 * fail identically every time.
 *
 * The caller's own role comes from `OrganizationDto.role`, which is the
 * caller's role rather than a property of the organization, so the denial can
 * name what they actually are instead of guessing.
 */
export function AuditPage() {
  const { orgId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  const filters: AuditFilters = {
    action: searchParams.get('action') ?? '',
    resource_type: searchParams.get('resource_type') ?? '',
    resource_id: searchParams.get('resource_id') ?? '',
    created_after: searchParams.get('created_after') ?? '',
    created_before: searchParams.get('created_before') ?? '',
  };
  const logs = useAuditLogs(orgId, filters, offset);

  // Only for the denial copy — it names the caller's real role rather than
  // guessing at it. A failure here just means the denial is slightly less
  // specific, so it is never allowed to block the page.
  const organizations = useOrganizations();
  const role = organizations.data?.rows.find((row) => row.id === orgId)?.role;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('offset');
    setSearchParams(next, { replace: true });
  };

  const setOffset = (value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value > 0) next.set('offset', String(value));
    else next.delete('offset');
    setSearchParams(next, { replace: true });
  };

  const forbidden =
    logs.error instanceof ApiRequestError &&
    (logs.error.status === 403 || logs.error.body.code === 'forbidden');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit log"
        description="Who changed what, including actions the platform took on its own. Pausing an endpoint records the reason here, which is what makes the delivery gap explainable afterwards."
      />

      {forbidden ? (
        <Panel>
          <PermissionDenied
            action="read this organization’s audit log"
            requiredRoles={['admin', 'owner']}
            currentRole={role}
            error={logs.error}
          />
        </Panel>
      ) : (
        <Panel flush>
          <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
            <Input
              aria-label="Filter by action"
              placeholder="Action (exact), e.g. endpoint.disabled"
              value={filters.action ?? ''}
              onChange={(event) => setFilter('action', event.target.value)}
              className="w-64"
            />
            <Input
              aria-label="Filter by resource type"
              placeholder="Resource type, e.g. endpoint"
              value={filters.resource_type ?? ''}
              onChange={(event) => setFilter('resource_type', event.target.value)}
              className="w-48"
            />
            <Input
              aria-label="Filter by resource ID"
              placeholder="Resource ID"
              value={filters.resource_id ?? ''}
              onChange={(event) => setFilter('resource_id', event.target.value)}
              className="w-56"
            />
          </div>

          {/*
            Said out loud rather than discovered as slowness. `action` and the
            date bounds are index-supported; `resource_type` and `resource_id`
            are scans within the organization and date range, per the
            controller's own documentation. An operator narrowing to one
            endpoint over all of history is doing the expensive thing, and the
            page tells them how to make it cheap.
          */}
          {(filters.resource_id || filters.resource_type) &&
            !filters.created_after &&
            !filters.created_before && (
              <p className="border-b border-line bg-raised px-3 py-1.5 text-2xs text-ink-muted">
                Filtering by resource scans the whole organization’s history — it is not
                index-supported. Pair it with a date range on a busy organization.
              </p>
            )}

          <Async
            query={logs}
            isEmpty={(page) => page.rows.length === 0}
            empty={
              <EmptyState
                title="No audit entries"
                description="Nothing in this organization matches the current filters."
              />
            }
          >
            {(page) => (
              <>
                <Table
                  caption="Audit log"
                  columns={columns}
                  rows={page.rows}
                  rowKey={(row) => row.id}
                />
                <Pager
                  page={page}
                  offset={offset}
                  onOffsetChange={setOffset}
                  limit={DEFAULT_PAGE_SIZE}
                  label="audit entries"
                />
              </>
            )}
          </Async>
        </Panel>
      )}
    </div>
  );
}

const columns: Column<AuditLogEntry>[] = [
  {
    key: 'action',
    header: 'Action',
    render: (row) => (
      <span className="flex flex-col">
        <span className="font-mono text-xs text-ink">{row.action}</span>
        {/*
          There is no `target` string on the wire — that was invented. The row
          carries `resource_type` and a nullable `resource_id`, so the two are
          composed here and a null id is not rendered as "endpoint null".
        */}
        <span className="font-mono text-2xs text-ink-subtle">
          {row.resource_type}
          {row.resource_id && ` · ${truncateId(row.resource_id)}`}
        </span>
      </span>
    ),
  },
  {
    key: 'actor',
    header: 'Actor',
    render: (row) => {
      const actor = describeActor(row);
      return (
        <span className="flex items-center gap-1.5">
          <Badge tone={actor.kind === 'system' ? 'info' : 'neutral'}>{actor.kind}</Badge>
          {/*
            An ID, not an email. `AuditLogDto` returns `user_id`/`api_key_id`
            and no identity — the nested `actor: { email }` this column used to
            read does not exist. Showing the id is the honest version; see
            HANDOFF.md, because "who paused this endpoint" wanting a second
            lookup to answer is a real gap on the page whose job is that
            question.
          */}
          <span className="font-mono text-2xs text-ink-muted">
            {actor.id ? truncateId(actor.id) : 'platform'}
          </span>
        </span>
      );
    },
  },
  {
    key: 'metadata',
    header: 'Detail',
    secondary: true,
    render: (row) => (
      <span className="flex flex-col gap-0.5">
        <span className="font-mono text-2xs text-ink-subtle">
          {row.metadata ? JSON.stringify(row.metadata) : '—'}
        </span>
        {row.ip_address && (
          <span className="font-mono text-2xs text-ink-subtle">{row.ip_address}</span>
        )}
      </span>
    ),
  },
  {
    key: 'when',
    header: 'When',
    align: 'right',
    render: (row) => (
      <span className="text-2xs text-ink-subtle" title={formatTimestamp(row.created_at)}>
        {formatRelativeTime(row.created_at)}
      </span>
    ),
  },
];
