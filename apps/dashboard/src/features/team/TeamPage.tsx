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
import type { Member } from '../../types/api';
import { useMembers } from '../organizations/api';

export function TeamPage() {
  const { orgId = '' } = useParams();
  const members = useMembers(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Team"
        description="Roles are Owner, Admin, Developer, Viewer and Billing. Permissions are explicit, never inferred."
        actions={<Button variant="primary">Invite member</Button>}
      />
      <Panel flush>
        <Async
          query={members}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="No members" />}
        >
          {(rows) => (
            <Table caption="Members" columns={columns} rows={rows} rowKey={(row) => row.id} />
          )}
        </Async>
      </Panel>
    </div>
  );
}

const columns: Column<Member>[] = [
  {
    key: 'user',
    header: 'Member',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.user.name}</span>
        <span className="text-2xs text-ink-subtle">{row.user.email}</span>
      </span>
    ),
  },
  { key: 'role', header: 'Role', render: (row) => <Badge className="capitalize">{row.role}</Badge> },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'ok' : row.status === 'invited' ? 'warn' : 'danger'} dot>
        {row.status}
      </Badge>
    ),
  },
  {
    key: 'joined',
    header: 'Joined',
    align: 'right',
    render: (row) => (
      <span className="text-2xs text-ink-subtle">
        {row.joined_at ? formatRelativeTime(row.joined_at) : 'pending'}
      </span>
    ),
  },
];
