import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { formatRelativeTime } from '../../lib/format';
import type { ApiKey } from '../../types/api';
import { useApiKeys } from '../projects/api';

export function ApiKeysPage() {
  const { projectId = '' } = useParams();
  const keys = useApiKeys(projectId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="API keys"
        description="Server-to-server keys for publishing events. The full key is shown once, at creation."
        actions={<Button variant="primary">Create key</Button>}
      />

      <Panel flush>
        <Async
          query={keys}
          isEmpty={(rows) => rows.length === 0}
          empty={
            <EmptyState
              title="No API keys"
              description="A publisher needs a key to post events to this project."
            />
          }
        >
          {(rows) => (
            <Table caption="API keys" columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
        </Async>
      </Panel>
    </div>
  );
}

const columns: Column<ApiKey>[] = [
  {
    key: 'name',
    header: 'Key',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name}</span>
        <span className="font-mono text-2xs text-ink-subtle">{row.masked_key}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.revoked_at ? 'danger' : 'ok'} dot>
        {row.revoked_at ? 'revoked' : 'active'}
      </Badge>
    ),
  },
  {
    key: 'used',
    header: 'Last used',
    align: 'right',
    render: (row) => (
      <span className="text-2xs text-ink-subtle">
        {row.last_used_at ? formatRelativeTime(row.last_used_at) : 'never'}
      </span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    secondary: true,
    render: (row) => (
      <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
    ),
  },
];
