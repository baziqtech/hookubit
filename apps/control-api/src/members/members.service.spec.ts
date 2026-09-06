import { AuditService, TenantScopeFactory } from '../authz';
import { TokenService } from '../auth/token.service';
import { AppError } from '../common/errors';
import { TenantTransactionRunner } from '../organizations';
import { UserDirectory } from '../organizations/user-directory';
import {
  FakeWorld,
  IDS,
  contextFor,
  memberId,
  principalFor,
  seedWorld,
} from '../organizations/testing/world';
import { UserScopeFactory } from '../organizations/user-scope';
import { InvitationInvite, InvitationMailer } from './invitation-mailer.port';
import { MembersService } from './members.service';

class RecordingMailer implements InvitationMailer {
  readonly invitations: InvitationInvite[] = [];
  readonly notices: Array<{ email: string; organizationName: string }> = [];

  async sendInvitation(invite: InvitationInvite): Promise<void> {
    this.invitations.push(invite);
  }

  async sendAlreadyMemberNotice(email: string, organizationName: string): Promise<void> {
    this.notices.push({ email, organizationName });
  }
}

describe('MembersService', () => {
  let db: FakeWorld;
  let mailer: RecordingMailer;
  let service: MembersService;

  beforeEach(() => {
    db = seedWorld();
    const scopes = new TenantScopeFactory(db.asPrisma());
    mailer = new RecordingMailer();
    service = new MembersService(
      scopes,
      new TenantTransactionRunner(db.asPrisma(), scopes),
      new UserScopeFactory(db.asPrisma()),
      new UserDirectory(db.asPrisma()),
      new TokenService(db.asPrisma()),
      new AuditService(db.asPrisma()),
      mailer,
    );
  });

  const code = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (err) {
      if (err instanceof AppError) return err.code;
      throw err;
    }
    throw new Error('expected the call to be refused, but it resolved');
  };

  const roleOf = (id: string): unknown => db.rows('organizationMember').get(id)?.role;

  const membersOf = (organizationId: string): unknown[] =>
    db.all('organizationMember').filter((row) => row.organizationId === organizationId);

  /** Promotes a user to owner so the two-owner cases are reachable. */
  const addOwner = (userId: string): string => {
    const id = memberId(userId, IDS.orgA);
    db.insert('organizationMember', {
      id,
      organizationId: IDS.orgA,
      userId,
      role: 'owner',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    return id;
  };

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('returns this organization only, with identities attached', async () => {
      const context = await contextFor(db, IDS.viewerA, IDS.orgA);
      const result = await service.list(context, {});

      expect(result.data.map((row) => row.user_id).sort()).toEqual(
        [IDS.ownerA, IDS.adminA, IDS.developerA, IDS.viewerA].sort(),
      );
      expect(result.data.every((row) => row.email?.endsWith('@example.com'))).toBe(true);
      // org B has members too; none of them appear.
      expect(result.data.map((row) => row.user_id)).not.toContain(IDS.strangerB);
    });
  });

  // ---------------------------------------------------------------------------
  // Vector 1 - creation is not reachable at all
  // ---------------------------------------------------------------------------

  describe('creation cannot be reached', () => {
    it('an admin inviting an owner is refused: the role is above their rank', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(await code(service.invite(context, { email: 'new@example.com', role: 'owner' }))).toBe(
        'forbidden',
      );
      expect(db.tokenRows()).toHaveLength(0);
    });

    it('a successful invite creates NO membership - only a token', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      const before = membersOf(IDS.orgA).length;

      const result = await service.invite(context, {
        email: `${IDS.outsider}@example.com`,
        role: 'developer',
      });

      expect(result).toEqual({ status: 'accepted' });
      expect(membersOf(IDS.orgA)).toHaveLength(before);
      expect(db.tokenRows()).toHaveLength(1);
      expect(db.tokenRows()[0].type).toBe('invitation');
      // The raw token exists only in the mail.
      expect(db.tokenRows()[0]).not.toHaveProperty('raw');
    });

    it('an admin cannot add an existing platform user by inviting them into a membership', async () => {
      // The whole point: there is no user id anywhere in the invite path, and
      // the address alone produces a token, never a row in this organization.
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      await service.invite(context, { email: `${IDS.strangerB}@example.com`, role: 'admin' });

      expect(
        membersOf(IDS.orgA).some((row) => (row as { userId: string }).userId === IDS.strangerB),
      ).toBe(false);
    });

    it('a viewer cannot invite anybody', async () => {
      const context = await contextFor(db, IDS.viewerA, IDS.orgA);
      expect(
        await code(service.invite(context, { email: 'new@example.com', role: 'viewer' })),
      ).toBe('forbidden');
    });

    it('a developer cannot invite anybody', async () => {
      const context = await contextFor(db, IDS.developerA, IDS.orgA);
      expect(
        await code(service.invite(context, { email: 'new@example.com', role: 'viewer' })),
      ).toBe('forbidden');
    });
  });

  // ---------------------------------------------------------------------------
  // Enumeration resistance
  // ---------------------------------------------------------------------------

  describe('invite does not reveal who is already on the platform', () => {
    it('answers identically for an address that is already a member', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      const forStranger = await service.invite(context, {
        email: 'nobody-here@example.com',
        role: 'viewer',
      });
      const forMember = await service.invite(context, {
        email: `${IDS.developerA}@example.com`,
        role: 'viewer',
      });

      expect(forMember).toEqual(forStranger);
      // The address owner is told; the caller is not.
      expect(mailer.notices).toEqual([
        { email: `${IDS.developerA}@example.com`, organizationName: 'Acme' },
      ]);
      // No second membership, and no token for an existing member.
      expect(db.tokenRows()).toHaveLength(1);
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({ action: 'member.invite_ignored' }),
      );
    });

    it('still answers 202 when the mail transport is down', async () => {
      jest.spyOn(mailer, 'sendInvitation').mockRejectedValue(new Error('smtp is down'));
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      await expect(
        service.invite(context, { email: 'someone@example.com', role: 'viewer' }),
      ).resolves.toEqual({ status: 'accepted' });
    });
  });

  // ---------------------------------------------------------------------------
  // Vector 2 - role changes always go through the lattice
  // ---------------------------------------------------------------------------

  describe('changeRole', () => {
    it('an admin cannot promote themselves to owner', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(
        await code(service.changeRole(context, memberId(IDS.adminA, IDS.orgA), { role: 'owner' })),
      ).toBe('forbidden');
      expect(roleOf(memberId(IDS.adminA, IDS.orgA))).toBe('admin');
    });

    it('an admin cannot promote anyone else to owner either', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(
        await code(
          service.changeRole(context, memberId(IDS.developerA, IDS.orgA), { role: 'owner' }),
        ),
      ).toBe('forbidden');
      expect(roleOf(memberId(IDS.developerA, IDS.orgA))).toBe('developer');
    });

    it('an admin cannot demote an owner', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(
        await code(service.changeRole(context, memberId(IDS.ownerA, IDS.orgA), { role: 'viewer' })),
      ).toBe('forbidden');
      expect(roleOf(memberId(IDS.ownerA, IDS.orgA))).toBe('owner');
    });

    it('an owner cannot change their own role', async () => {
      // This is what actually keeps the last owner in place: the rank rule means
      // only an owner can demote an owner, and the self rule means they cannot
      // be the same person.
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      expect(
        await code(service.changeRole(context, memberId(IDS.ownerA, IDS.orgA), { role: 'admin' })),
      ).toBe('forbidden');
      expect(roleOf(memberId(IDS.ownerA, IDS.orgA))).toBe('owner');
    });

    it('an owner may demote another owner while a second one remains', async () => {
      const second = addOwner(IDS.secondOwnerA);
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      const updated = await service.changeRole(context, second, { role: 'admin' });

      expect(updated.role).toBe('admin');
      expect(roleOf(second)).toBe('admin');
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          action: 'member.role_changed',
          metadata: expect.objectContaining({ from: 'owner', to: 'admin' }),
        }),
      );
    });

    it('refuses to demote the last owner when a concurrent removal took the other one', async () => {
      // The exact race RoleChange.ownerCount exists for. The actor's context was
      // resolved while there were two owners; by the time the handler runs, the
      // other owner is gone. Counting outside the transaction would let this
      // through and leave the organization with nobody who can administer it.
      const second = addOwner(IDS.secondOwnerA);
      const context = await contextFor(db, IDS.secondOwnerA, IDS.orgA);
      db.rows('organizationMember').delete(second);

      expect(
        await code(service.changeRole(context, memberId(IDS.ownerA, IDS.orgA), { role: 'admin' })),
      ).toBe('conflict');
      expect(roleOf(memberId(IDS.ownerA, IDS.orgA))).toBe('owner');
    });

    it('counts owners inside the same transaction as the write', async () => {
      const second = addOwner(IDS.secondOwnerA);
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      db.transactions.length = 0;

      await service.changeRole(context, second, { role: 'developer' });

      const outer = db.transactions[0];
      expect(outer).toBeDefined();
      expect(outer).toContainEqual({ table: 'organizationMember', op: 'find' });
      expect(outer).toContainEqual({ table: 'organizationMember', op: 'updateMany' });
      expect(outer).toContainEqual({ table: 'auditLog', op: 'create' });
    });

    it('answers 404, not 403, for a member id belonging to another organization', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      expect(
        await code(
          service.changeRole(context, memberId(IDS.strangerB, IDS.orgB), { role: 'viewer' }),
        ),
      ).toBe('not_found');
      expect(roleOf(memberId(IDS.strangerB, IDS.orgB))).toBe('developer');
    });

    it('records nothing for a no-op change', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      const before = db.all('auditLog').length;
      const result = await service.changeRole(context, memberId(IDS.viewerA, IDS.orgA), {
        role: 'viewer',
      });
      expect(result.role).toBe('viewer');
      expect(db.all('auditLog')).toHaveLength(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('removes a lower-ranked member and audits it', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      await service.remove(context, memberId(IDS.viewerA, IDS.orgA));

      expect(db.rows('organizationMember').has(memberId(IDS.viewerA, IDS.orgA))).toBe(false);
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          action: 'member.removed',
          metadata: expect.objectContaining({ user_id: IDS.viewerA, role: 'viewer' }),
        }),
      );
    });

    it('an admin cannot remove an owner', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(await code(service.remove(context, memberId(IDS.ownerA, IDS.orgA)))).toBe('forbidden');
      expect(db.rows('organizationMember').has(memberId(IDS.ownerA, IDS.orgA))).toBe(true);
    });

    it('nobody can remove their own membership', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      expect(await code(service.remove(context, memberId(IDS.ownerA, IDS.orgA)))).toBe('forbidden');
      expect(db.rows('organizationMember').has(memberId(IDS.ownerA, IDS.orgA))).toBe(true);
    });

    it('refuses to remove the last owner when a concurrent removal took the other one', async () => {
      const second = addOwner(IDS.secondOwnerA);
      const context = await contextFor(db, IDS.secondOwnerA, IDS.orgA);
      db.rows('organizationMember').delete(second);

      expect(await code(service.remove(context, memberId(IDS.ownerA, IDS.orgA)))).toBe('conflict');
      expect(db.rows('organizationMember').has(memberId(IDS.ownerA, IDS.orgA))).toBe(true);
    });

    it('answers 404 for a member id in another organization', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      expect(await code(service.remove(context, memberId(IDS.strangerB, IDS.orgB)))).toBe(
        'not_found',
      );
      expect(db.rows('organizationMember').has(memberId(IDS.strangerB, IDS.orgB))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Vector 3 - membership requires the invitee's own consent
  // ---------------------------------------------------------------------------

  describe('accept', () => {
    const inviteOutsider = async (role: 'developer' | 'admin' | 'owner' = 'developer') => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      await service.invite(context, { email: `${IDS.outsider}@example.com`, role });
      return mailer.invitations[mailer.invitations.length - 1].rawToken;
    };

    it('creates the membership only when the invitee redeems it themselves', async () => {
      const token = await inviteOutsider();
      const result = await service.accept(principalFor(IDS.outsider), { token });

      expect(result.organization).toMatchObject({ id: IDS.orgA, role: 'developer' });
      const membership = db
        .all('organizationMember')
        .find((row) => row.organizationId === IDS.orgA && row.userId === IDS.outsider);
      expect(membership).toMatchObject({ role: 'developer' });
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          action: 'member.joined',
          organizationId: IDS.orgA,
          userId: IDS.outsider,
        }),
      );
    });

    it('refuses a token issued to a different address than the session holds', async () => {
      const token = await inviteOutsider();
      // strangerB has an account and a live session; the link was not for them.
      expect(await code(service.accept(principalFor(IDS.strangerB), { token }))).toBe(
        'invalid_request',
      );
      expect(
        db.all('organizationMember').some((row) => row.userId === IDS.strangerB && row.organizationId === IDS.orgA),
      ).toBe(false);
    });

    it('is single-use', async () => {
      const token = await inviteOutsider();
      await service.accept(principalFor(IDS.outsider), { token });
      expect(await code(service.accept(principalFor(IDS.outsider), { token }))).toBe(
        'invalid_request',
      );
    });

    it('rejects an unknown token with the same answer as a consumed one', async () => {
      expect(
        await code(service.accept(principalFor(IDS.outsider), { token: 'not-a-real-token-value' })),
      ).toBe('invalid_request');
    });

    it('refuses when the inviter no longer holds the rank to grant that role', async () => {
      // Invited as an admin by an owner; the owner is demoted to viewer before
      // the link is opened. Without the re-check the invitation would still
      // mint an admin on the strength of a rank nobody holds any more.
      const token = await inviteOutsider('admin');
      addOwner(IDS.secondOwnerA);
      const byOther = await contextFor(db, IDS.secondOwnerA, IDS.orgA);
      await service.changeRole(byOther, memberId(IDS.ownerA, IDS.orgA), { role: 'viewer' });

      expect(await code(service.accept(principalFor(IDS.outsider), { token }))).toBe('conflict');
      expect(db.all('organizationMember').some((row) => row.userId === IDS.outsider)).toBe(false);
    });

    it('refuses when the inviting membership is gone', async () => {
      const token = await inviteOutsider();
      db.rows('organizationMember').delete(memberId(IDS.ownerA, IDS.orgA));

      expect(await code(service.accept(principalFor(IDS.outsider), { token }))).toBe('conflict');
    });

    it('refuses to join an organization that is not active', async () => {
      const token = await inviteOutsider();
      const row = db.rows('organization').get(IDS.orgA);
      db.rows('organization').set(IDS.orgA, { ...row, status: 'suspended' });

      expect(await code(service.accept(principalFor(IDS.outsider), { token }))).toBe('conflict');
    });

    it('does not change an existing role when an old invitation is replayed', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      await service.invite(context, { email: `${IDS.viewerA}@example.com`, role: 'admin' });
      // The address is already a member, so no token was ever issued for it -
      // which is itself the guarantee. Prove the role is untouched.
      expect(mailer.invitations).toHaveLength(0);
      expect(roleOf(memberId(IDS.viewerA, IDS.orgA))).toBe('viewer');
    });
  });
});
