import { CROSS_TENANT_MESSAGE } from '../authz';
import { TokenService } from '../auth/token.service';
import { THROTTLE_KEY, ThrottleOptions } from '../common/throttle.guard';
import { TestHarness, createHarness } from '../organizations/testing/http';
import { FakeWorld, IDS, memberId, seedWorld } from '../organizations/testing/world';
import { InvitationInvite, InvitationMailer, INVITATION_MAILER } from './invitation-mailer.port';
import { InvitationsController } from './invitations.controller';
import { MembersController } from './members.controller';
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

describe('members over HTTP', () => {
  let db: FakeWorld;
  let mailer: RecordingMailer;
  let harness: TestHarness;

  beforeEach(async () => {
    db = seedWorld();
    mailer = new RecordingMailer();
    harness = await createHarness(db, [MembersController, InvitationsController], [
      MembersService,
      TokenService,
      { provide: INVITATION_MAILER, useValue: mailer },
    ]);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const call = (
    method: string,
    path: string,
    options?: { as?: string; body?: unknown },
  ): ReturnType<TestHarness['call']> => harness.call(method, path, options);

  const members = (organizationId: string): string =>
    `/v1/organizations/${organizationId}/members`;

  const roleOf = (id: string): unknown => db.rows('organizationMember').get(id)?.role;

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  it('401s with no session cookie', async () => {
    const res = await call('GET', members(IDS.orgA));
    expect(res.status).toBe(401);
  });

  it('lists members for any role in the organization', async () => {
    const res = await call('GET', members(IDS.orgA), { as: IDS.viewerA });
    expect(res.status).toBe(200);
    expect((res.body as { total: number }).total).toBe(4);
  });

  it('404s the member list of an organization the caller is not in', async () => {
    const res = await call('GET', members(IDS.orgB), { as: IDS.ownerA });
    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe(CROSS_TENANT_MESSAGE);
  });

  // ---------------------------------------------------------------------------
  // Inviting
  // ---------------------------------------------------------------------------

  it('403s an invite from a viewer, and 403s one from a developer', async () => {
    for (const actor of [IDS.viewerA, IDS.developerA]) {
      const res = await call('POST', members(IDS.orgA), {
        as: actor,
        body: { email: 'new@example.com', role: 'viewer' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('forbidden');
    }
    expect(mailer.invitations).toHaveLength(0);
  });

  it('403s an admin trying to invite an owner', async () => {
    const res = await call('POST', members(IDS.orgA), {
      as: IDS.adminA,
      body: { email: 'new@example.com', role: 'owner' },
    });
    expect(res.status).toBe(403);
    expect(db.tokenRows()).toHaveLength(0);
  });

  it('rejects a user_id in the invite body outright', async () => {
    // The DTO declares no user id, and `forbidNonWhitelisted` turns an attempt
    // to supply one into a 400 rather than an ignored field - so the shape of
    // the request can never drift towards "add this account to my org".
    const res = await call('POST', members(IDS.orgA), {
      as: IDS.adminA,
      body: { email: 'new@example.com', role: 'developer', user_id: IDS.strangerB },
    });
    expect(res.status).toBe(400);
    expect(
      db.all('organizationMember').some(
        (row) => row.userId === IDS.strangerB && row.organizationId === IDS.orgA,
      ),
    ).toBe(false);
  });

  it('202s an invite and creates no membership', async () => {
    const res = await call('POST', members(IDS.orgA), {
      as: IDS.adminA,
      body: { email: `${IDS.outsider}@example.com`, role: 'developer' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(db.all('organizationMember').some((row) => row.userId === IDS.outsider)).toBe(false);
  });

  it('answers an invite to an existing member exactly as it answers a stranger', async () => {
    const stranger = await call('POST', members(IDS.orgA), {
      as: IDS.ownerA,
      body: { email: 'nobody@example.com', role: 'viewer' },
    });
    const existing = await call('POST', members(IDS.orgA), {
      as: IDS.ownerA,
      body: { email: `${IDS.viewerA}@example.com`, role: 'viewer' },
    });
    expect(existing.status).toBe(stranger.status);
    expect(existing.body).toEqual(stranger.body);
  });

  // ---------------------------------------------------------------------------
  // FIX 7 - the invite endpoint is an outbound-mail primitive
  // ---------------------------------------------------------------------------

  it('429s invitations past the limit', async () => {
    // Unlimited, this was a mail cannon: an attacker-chosen organization name
    // (200 chars), any address the caller names, from the platform's own
    // sending domain.
    const send = (): ReturnType<TestHarness['call']> =>
      call('POST', members(IDS.orgA), {
        as: IDS.ownerA,
        body: { email: 'target@example.com', role: 'viewer' },
      });

    const statuses: number[] = [];
    for (let n = 0; n < 21; n += 1) statuses.push((await send()).status);

    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(202));
    expect(statuses[20]).toBe(429);
    expect(mailer.invitations.length).toBeLessThanOrEqual(20);
  });

  it('limits per RECIPIENT, so one mailbox cannot be targeted from many organizations', async () => {
    // The per-address bucket is the one that protects the victim; the caller
    // here changes organization and role between sends and it makes no
    // difference.
    for (let n = 0; n < 20; n += 1) {
      await call('POST', members(IDS.orgA), {
        as: n % 2 === 0 ? IDS.ownerA : IDS.adminA,
        body: { email: 'victim@example.com', role: n % 2 === 0 ? 'viewer' : 'developer' },
      });
    }
    const over = await call('POST', members(IDS.orgB), {
      as: IDS.ownerB,
      body: { email: 'victim@example.com', role: 'viewer' },
    });

    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe('rate_limited');
  });

  it('does not throttle the member list', async () => {
    for (let n = 0; n < 25; n += 1) {
      const res = await call('GET', members(IDS.orgA), { as: IDS.viewerA });
      expect(res.status).toBe(200);
    }
  });

  // ---------------------------------------------------------------------------
  // Role changes
  // ---------------------------------------------------------------------------

  it('403s a developer changing a role', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.viewerA, IDS.orgA)}`, {
      as: IDS.developerA,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(403);
    expect(roleOf(memberId(IDS.viewerA, IDS.orgA))).toBe('viewer');
  });

  it('403s an admin promoting themselves to owner', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.adminA, IDS.orgA)}`, {
      as: IDS.adminA,
      body: { role: 'owner' },
    });
    expect(res.status).toBe(403);
    expect(roleOf(memberId(IDS.adminA, IDS.orgA))).toBe('admin');
  });

  it('rejects a role that is not in the enum', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.viewerA, IDS.orgA)}`, {
      as: IDS.ownerA,
      body: { role: 'superuser' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a user_id smuggled into a role change', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.viewerA, IDS.orgA)}`, {
      as: IDS.ownerA,
      body: { role: 'admin', user_id: IDS.strangerB },
    });
    expect(res.status).toBe(400);
    expect(db.rows('organizationMember').get(memberId(IDS.viewerA, IDS.orgA))?.userId).toBe(
      IDS.viewerA,
    );
  });

  it('lets an owner promote a viewer to admin', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.viewerA, IDS.orgA)}`, {
      as: IDS.ownerA,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(roleOf(memberId(IDS.viewerA, IDS.orgA))).toBe('admin');
  });

  it('404s a role change aimed at a member of another organization', async () => {
    const res = await call('PATCH', `${members(IDS.orgA)}/${memberId(IDS.strangerB, IDS.orgB)}`, {
      as: IDS.ownerA,
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
    // NOTE: this comes from `ScopedRepository.notFound()`, which still says
    // "Member not found." rather than the single CROSS_TENANT_MESSAGE the
    // resolver uses. Not an oracle - every member id, present or absent, gets
    // the same string on this route - but the two spellings of one policy are
    // written up in HANDOFF.md as an authz-side tidy-up.
    expect(roleOf(memberId(IDS.strangerB, IDS.orgB))).toBe('developer');
  });

  // ---------------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------------

  it('204s a removal by an admin and 403s a self-removal', async () => {
    const removed = await call('DELETE', `${members(IDS.orgA)}/${memberId(IDS.viewerA, IDS.orgA)}`, {
      as: IDS.adminA,
    });
    expect(removed.status).toBe(204);
    expect(db.rows('organizationMember').has(memberId(IDS.viewerA, IDS.orgA))).toBe(false);

    const self = await call('DELETE', `${members(IDS.orgA)}/${memberId(IDS.adminA, IDS.orgA)}`, {
      as: IDS.adminA,
    });
    expect(self.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Redemption
  // ---------------------------------------------------------------------------

  describe('POST /v1/invitations/accept', () => {
    it('carries a throttle, counted rather than enforced per address', async () => {
      // The one route here whose limit cannot be observed as a 429, and
      // deliberately so: it consumes a 256-bit single-use token, so refusing on
      // the per-address bucket would deny service to everyone finishing an
      // invitation behind a proxy without preventing an attack (the posture
      // `auth.verify` and `auth.reset` already take). The counter still exists,
      // so the pressure is visible and a per-subject bucket can enforce on top.
      const options = Reflect.getMetadata(
        THROTTLE_KEY,
        InvitationsController.prototype.accept,
      ) as ThrottleOptions | undefined;

      expect(options).toMatchObject({ name: 'invitations.accept', enforcePerIp: false });
      expect(options?.limit).toBeGreaterThan(0);
    });

    const invite = async (role = 'developer'): Promise<string> => {
      await call('POST', members(IDS.orgA), {
        as: IDS.ownerA,
        body: { email: `${IDS.outsider}@example.com`, role },
      });
      return mailer.invitations[mailer.invitations.length - 1].rawToken;
    };

    it('401s without a session: the token alone is not enough', async () => {
      const token = await invite();
      const res = await call('POST', '/v1/invitations/accept', { body: { token } });
      expect(res.status).toBe(401);
      expect(db.all('organizationMember').some((row) => row.userId === IDS.outsider)).toBe(false);
    });

    it('joins the organization for the invited address', async () => {
      const token = await invite();
      const res = await call('POST', '/v1/invitations/accept', { as: IDS.outsider, body: { token } });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        organization: { id: IDS.orgA, role: 'developer' },
      });
      // And the newly joined member can now use the tenanted routes.
      const list = await call('GET', members(IDS.orgA), { as: IDS.outsider });
      expect(list.status).toBe(200);
    });

    it('400s a token presented from a different account', async () => {
      const token = await invite();
      const res = await call('POST', '/v1/invitations/accept', {
        as: IDS.strangerB,
        body: { token },
      });
      expect(res.status).toBe(400);
      expect(
        db.all('organizationMember').some(
          (row) => row.userId === IDS.strangerB && row.organizationId === IDS.orgA,
        ),
      ).toBe(false);
    });

    it('400s a replayed token', async () => {
      const token = await invite();
      await call('POST', '/v1/invitations/accept', { as: IDS.outsider, body: { token } });
      const replay = await call('POST', '/v1/invitations/accept', {
        as: IDS.outsider,
        body: { token },
      });
      expect(replay.status).toBe(400);
    });

    it('is not reachable under an organization path, where it would 404 anyway', async () => {
      const token = await invite();
      const res = await call('POST', `/v1/organizations/${IDS.orgA}/members/accept`, {
        as: IDS.outsider,
        body: { token },
      });
      expect(res.status).not.toBe(200);
    });
  });
});
