import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pager,
  Panel,
  Select,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { formatRelativeTime } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type Member, type Role } from '../../types/api';
import { useInviteMember, useMembers } from '../organizations/api';

export function TeamPage() {
  const { orgId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [inviting, setInviting] = useState(false);
  const members = useMembers(orgId, offset);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Team"
        description="Roles are Owner, Admin, Developer, Viewer and Billing. Permissions are explicit, never inferred."
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite member
          </Button>
        }
      />
      <Panel flush>
        <Async
          query={members}
          isEmpty={(page) => page.rows.length === 0}
          empty={<EmptyState title="No members" />}
        >
          {(page) => (
            <>
              <Table
                caption="Members"
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="members"
              />
            </>
          )}
        </Async>
      </Panel>

      <InviteDialog orgId={orgId} open={inviting} onClose={() => setInviting(false)} />
    </div>
  );
}

/**
 * Inviting always answers 202, for a known address, an existing member and an
 * unknown address alike — anything else would let a member enumerate the
 * platform. So the confirmation deliberately says "if that address can receive
 * mail" rather than claiming an invitation was definitely sent, and the member
 * list is NOT optimistically updated: no row exists until the invitee redeems
 * their token.
 */
function InviteDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const invite = useInviteMember(orgId);

  const close = () => {
    setEmail('');
    invite.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Invite member"
      footer={
        invite.isSuccess ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={invite.isPending || !email}
              onClick={() => invite.mutate({ email, role })}
            >
              {invite.isPending ? 'Sending…' : 'Send invitation'}
            </Button>
          </>
        )
      }
    >
      {invite.isSuccess ? (
        <p className="text-xs text-ink-muted">
          If <strong className="text-ink">{email}</strong> can receive mail, an invitation is on its
          way. They will appear in this list once they accept it — no membership exists until then.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {invite.isError && <WriteErrorNotice error={invite.error} />}
          <Field label="Email" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field label="Role" hint="You cannot assign a role above your own.">
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
                options={[
                  { value: 'admin', label: 'Admin' },
                  { value: 'developer', label: 'Developer' },
                  { value: 'viewer', label: 'Viewer' },
                  { value: 'billing', label: 'Billing' },
                ]}
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Identity is flat and nullable on `MemberDto`. A null email is a membership
 * whose user row is gone — a data-integrity problem the API returns rather than
 * hides, so the table shows it rather than rendering a blank cell.
 */
const columns: Column<Member>[] = [
  {
    key: 'user',
    header: 'Member',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name ?? 'Unknown user'}</span>
        <span className="text-2xs text-ink-subtle">
          {row.email ?? <span className="text-danger">no user record — {row.user_id}</span>}
        </span>
      </span>
    ),
  },
  { key: 'role', header: 'Role', render: (row) => <Badge className="capitalize">{row.role}</Badge> },
  {
    key: 'status',
    header: 'Account',
    render: (row) => (
      <Badge tone={row.disabled ? 'danger' : 'ok'} dot>
        {row.disabled ? 'disabled' : 'active'}
      </Badge>
    ),
  },
  {
    key: 'joined',
    header: 'Member since',
    align: 'right',
    render: (row) => (
      <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
    ),
  },
];
