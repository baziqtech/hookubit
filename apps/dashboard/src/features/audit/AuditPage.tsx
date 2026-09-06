import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import type { AuditLogEntry } from '../../types/api';
import { useAuditLogs } from '../organizations/api';

export function AuditPage() {
  const { orgId = '' } = useParams();
  const logs = useAuditLogs(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit log"
        description="Who changed what, including actions the platform took on its own."
      />
      <Panel flush>
        <Async
          query={logs}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="No audit entries" />}
        >
          {(rows) => (
            <Table caption="Audit log" columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
        </Async>
      </Panel>
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
        <span className="text-2xs text-ink-subtle">{row.target}</span>
      </span>
    ),
  },
  {
    key: 'actor',
    header: 'Actor',
    render: (row) => (
      <span className="flex items-center gap-1.5">
        <Badge tone={row.actor.type === 'system' ? 'info' : 'neutral'}>{row.actor.type}</Badge>
        <span className="text-2xs text-ink-muted">{row.actor.email}</span>
      </span>
    ),
  },
  {
    key: 'metadata',
    header: 'Detail',
    secondary: true,
    render: (row) => (
      <span className="font-mono text-2xs text-ink-subtle">
        {row.metadata ? JSON.stringify(row.metadata) : '—'}
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
