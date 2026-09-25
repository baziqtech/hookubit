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
import { useFocusOnError } from '../../lib/use-focus-on-error';
import { DEFAULT_PAGE_SIZE, type Member, type Role } from '../../types/api';
import { useSession } from '../auth/api';
import {
  useInviteMember,
  useMembers,
  useOrganization,
  useRemoveMember,
  useUpdateMemberRole,
} from '../organizations/api';
import {
  ROLES,
  isDenied,
  mayAssignRole,
  ownerCountOf,
  removalVerdict,
  roleChangeVerdict,
  rowVerdict,
  type LatticeContext,
} from './lattice';

/**
 * The member list, with the two controls that used to be API-only: a role
 * select per row and Remove.
 *
 * ## Why the select is greyed out with a sentence, not just greyed out
 *
 * The lattice (`lattice.ts`, mirrored from the control API's
 * `permissions.ts`) is what decides whether a row can be changed by THIS
 * caller: never your own membership, never someone who outranks you, never a
 * role above your own. A disabled select with no explanation reads as "ask an
 * admin"; the truth is often "you ARE the admin, and that is the owner". So
 * every disabled control carries the sentence the server would answer with.
 *
 * ## Why a change goes through a confirmation
 *
 * A role change is immediate and audited, and promoting someone to owner is
 * a decision the caller cannot reverse by themselves (an admin cannot demote
 * an owner). A select that fires on `change` would make that one accidental
 * keystroke. The select is CONTROLLED by the server's value; choosing a
 * different option opens the confirmation, and cancelling leaves the row as
 * it was.
 *
 * ## What the server says is what is shown
 *
 * A 403 (the lattice) or a 409 (the last owner) comes back as a sentence
 * written for the operator, and `WriteErrorNotice` shows it verbatim. The
 * client-side rules only decide what to OFFER; they never replace the answer.
 */
export function TeamPage() {
  const { orgId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<{ member: Member; role: Role } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const members = useMembers(orgId, offset);
  const session = useSession();
  const organization = useOrganization(orgId);

  const actorRole = organization.data?.role;
  const actorUserId = session.data?.user.id;
  const ownerCount = members.data ? ownerCountOf(members.data, offset) : null;
  const context: LatticeContext = { actorRole, actorUserId, ownerCount };

  const columns = buildColumns(context, {
    onChangeRole: (member, role) => setChanging({ member, role }),
    onRemove: setRemoving,
  });

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

      <InviteDialog
        orgId={orgId}
        actorRole={actorRole}
        open={inviting}
        onClose={() => setInviting(false)}
      />

      {changing && (
        <ChangeRoleDialog
          orgId={orgId}
          member={changing.member}
          nextRole={changing.role}
          context={context}
          onClose={() => setChanging(null)}
        />
      )}

      {removing && (
        <RemoveMemberDialog
          orgId={orgId}
          member={removing}
          context={context}
          onClose={() => setRemoving(null)}
        />
      )}
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
 *
 * The roles offered are the ones the caller may assign (`mayAssignRole`):
 * never above their own rank, so an admin is not offered "owner". Owner is
 * offered to an owner — it is the only way a second owner comes to exist,
 * which the last-owner rule depends on.
 */
function InviteDialog({
  orgId,
  actorRole,
  open,
  onClose,
}: {
  orgId: string;
  actorRole: Role | undefined;
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
                options={roleOptions(actorRole)}
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Every role, with the ones the caller may not assign greyed rather than
 * hidden — a missing option reads as a bug; a disabled one reads as a rule.
 * With the role unknown nothing is greyed: the server decides.
 */
function roleOptions(actorRole: Role | undefined) {
  return ROLES.map((role) => ({
    value: role,
    label: role.charAt(0).toUpperCase() + role.slice(1),
    disabled: actorRole !== undefined && !mayAssignRole(actorRole, role),
  }));
}

function ChangeRoleDialog({
  orgId,
  member,
  nextRole,
  context,
  onClose,
}: {
  orgId: string;
  member: Member;
  nextRole: Role;
  context: LatticeContext;
  onClose: () => void;
}) {
  const update = useUpdateMemberRole(orgId);
  const errorRef = useFocusOnError(update.isError);
  const verdict = roleChangeVerdict(context, member, nextRole);
  const denied = isDenied(verdict);
  const promotingToOwner = nextRole === 'owner';
  const demotingOwner = member.role === 'owner' && nextRole !== 'owner';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change ${describeMember(member)} to ${nextRole}?`}
      description={`Currently ${member.role}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!denied && (
            <Button
              variant={promotingToOwner || demotingOwner ? 'danger' : 'primary'}
              loading={update.isPending}
              onClick={() =>
                update.mutate({ memberId: member.id, role: nextRole }, { onSuccess: onClose })
              }
            >
              Change to {nextRole}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          {/* The 403/409 is the server's own sentence, shown whole. */}
          <WriteErrorNotice error={update.error} />
        </div>

        {denied ? (
          <p role="alert" className="text-danger">
            {verdict.reason}
          </p>
        ) : (
          <>
            <p>
              The change is immediate and is written to the audit log. Their permissions on every
              project in this organization become those of {article(nextRole)}{' '}
              <strong className="text-ink">{nextRole}</strong> on their next request.
            </p>
            {promotingToOwner && (
              <p>
                <strong className="text-ink">An owner outranks every admin.</strong> Once promoted,
                only another owner can change or remove them — including you, if you are an admin.
              </p>
            )}
            {demotingOwner && (
              <p>
                An organization must always keep at least one owner. The platform counts owners in
                the same transaction as this change and refuses if this would leave none.
              </p>
            )}
            <p className="text-2xs text-ink-subtle">
              API keys they created keep authenticating for ingest; their control-plane authority
              shrinks to what {article(nextRole)} {nextRole} holds.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function RemoveMemberDialog({
  orgId,
  member,
  context,
  onClose,
}: {
  orgId: string;
  member: Member;
  context: LatticeContext;
  onClose: () => void;
}) {
  const remove = useRemoveMember(orgId);
  const errorRef = useFocusOnError(remove.isError);
  const verdict = removalVerdict(context, member);
  const denied = isDenied(verdict);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${describeMember(member)}?`}
      description={`${member.role} · member ${formatRelativeTime(member.created_at)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!denied && (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(member.id, { onSuccess: onClose })}
            >
              Remove member
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={remove.error} />
        </div>

        {denied ? (
          <p role="alert" className="text-danger">
            {verdict.reason}
          </p>
        ) : (
          <>
            <p>
              <strong className="text-ink">Their membership is deleted immediately.</strong> Every
              route under this organization answers “not found” for them from their next request.
              The audit entries naming them survive.
            </p>
            {member.role === 'owner' && (
              <p>
                An organization must always keep at least one owner; the platform refuses the
                removal if this would leave none.
              </p>
            )}
            <p className="text-2xs text-ink-subtle">
              API keys they created keep authenticating for ingest — an integration is not taken
              offline because a person left — but lose all control-plane authority. Inviting them
              again creates a new membership.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function describeMember(member: Member): string {
  return member.name ?? member.email ?? member.user_id;
}

function article(role: Role): string {
  return /^[aeiou]/i.test(role) ? 'an' : 'a';
}

/**
 * Identity is flat and nullable on `MemberDto`. A null email is a membership
 * whose user row is gone — a data-integrity problem the API returns rather than
 * hides, so the table shows it rather than rendering a blank cell.
 */
function buildColumns(
  context: LatticeContext,
  actions: { onChangeRole: (member: Member, role: Role) => void; onRemove: (member: Member) => void },
): Column<Member>[] {
  return [
    {
      key: 'user',
      header: 'Member',
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-xs font-medium text-ink">
            {row.name ?? 'Unknown user'}
            {row.user_id === context.actorUserId && (
              <span className="ml-1.5 text-2xs font-normal text-ink-subtle">(you)</span>
            )}
          </span>
          <span className="text-2xs text-ink-subtle">
            {row.email ?? <span className="text-danger">no user record — {row.user_id}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => <RoleCell member={row} context={context} onChange={actions.onChangeRole} />,
    },
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
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => {
        const verdict = removalVerdict(context, row);
        // Denied rows keep the button but disabled, with the reason as its
        // tooltip and accessible description — "greyed out" is never the
        // whole answer. Unknown (role still loading) stays enabled: the
        // server is the authority.
        const reason = isDenied(verdict) ? verdict.reason : undefined;
        return (
          <Button
            size="sm"
            variant="ghost"
            disabled={reason !== undefined}
            title={reason}
            aria-label={reason ? `Remove — ${reason}` : undefined}
            onClick={() => actions.onRemove(row)}
          >
            Remove
          </Button>
        );
      },
    },
  ];
}

/**
 * The role, as a select when this caller may change it and as a badge with
 * the reason when they may not.
 *
 * Controlled by the SERVER's value: choosing another option opens the
 * confirmation and nothing changes until it is confirmed, so the select never
 * shows a role the member does not hold.
 */
function RoleCell({
  member,
  context,
  onChange,
}: {
  member: Member;
  context: LatticeContext;
  onChange: (member: Member, role: Role) => void;
}) {
  const verdict = rowVerdict(context, member);
  if (isDenied(verdict)) {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge className="w-fit capitalize">{member.role}</Badge>
        <span className="text-2xs text-ink-subtle">{verdict.reason}</span>
      </span>
    );
  }
  return (
    <Select
      aria-label={`Role of ${describeMember(member)}`}
      value={member.role}
      className="w-36"
      onChange={(event) => {
        const next = event.target.value as Role;
        if (next !== member.role) onChange(member, next);
      }}
      options={roleOptions(context.actorRole)}
    />
  );
}
