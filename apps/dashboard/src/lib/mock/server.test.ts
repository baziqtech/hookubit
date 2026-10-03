import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AcceptedInvitation,
  Delivery,
  EventDetail,
  OffsetPage,
  Organization,
  Session,
  WebhookEvent,
} from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The mock is a stand-in for the control API, so it is worth holding to the
 * contract: the published paths resolve, pagination is the one offset envelope
 * the schema declares, and failures carry the same error envelope with a
 * `request_id`. These also catch the fixture generator failing at module load.
 */
describe('mock control API', () => {
  beforeEach(() => resetMockState());

  /**
   * `SessionResponseDto` is `{ user }` and NOTHING ELSE. It does not carry an
   * organization list, though the login redirect and the landing route both
   * read `session.organizations[0]` until the generated types said otherwise.
   */
  it('serves a session that is the user and nothing else', async () => {
    const session = await mockRequest<Session>('GET', '/v1/auth/session');
    expect(session.user.email).toContain('@');
    expect(session.user.email_verified).toBe(true);
    expect(session).not.toHaveProperty('organizations');
  });

  it('refuses login for an unverified account with the code the page branches on', async () => {
    await expect(
      mockRequest('POST', '/v1/auth/login', { email: 'ada@example.com', password: 'unverified' }),
    ).rejects.toMatchObject({ status: 403, body: { error: { code: 'email_not_verified' } } });
  });

  it('verify-email answers a SessionResponseDto for a live token and one 400 for every dead one', async () => {
    const verified = await mockRequest<Session>('POST', '/v1/auth/verify-email', {
      token: 'tok_live',
    });
    expect(verified.user.email_verified).toBe(true);
    expect(verified).not.toHaveProperty('organizations');

    for (const token of ['expired', 'invalid']) {
      await expect(mockRequest('POST', '/v1/auth/verify-email', { token })).rejects.toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_request' } },
      });
    }
    await expect(mockRequest('POST', '/v1/auth/verify-email', {})).rejects.toBeInstanceOf(
      MockHttpError,
    );
  });

  it('resend-verification is the same 202 body for any address, then throttles like the server', async () => {
    const bodies = await Promise.all(
      ['registered@example.com', 'nobody@example.com'].map((email) =>
        mockRequest<{ status: string }>('POST', '/v1/auth/resend-verification', { email }),
      ),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({ status: 'accepted' });

    // Five per hour on the real route; the sixth is a 429 with a retry hint.
    for (let i = 0; i < 3; i += 1) {
      await mockRequest('POST', '/v1/auth/resend-verification', { email: 'a@example.com' });
    }
    await expect(
      mockRequest('POST', '/v1/auth/resend-verification', { email: 'a@example.com' }),
    ).rejects.toMatchObject({
      status: 429,
      body: { error: { code: 'rate_limited', details: { retry_after_seconds: 42 } } },
    });
  });

  /*
   * `POST /v1/invitations/accept`, as `MembersService.accept` behaves: consume
   * first, then check the address, then the inviter. One 400 for every dead
   * token, a 409 for an inviter who can no longer support it, and every
   * refusal burns the token.
   */
  it('accepting a live invitation answers { organization } and adds it to the list', async () => {
    const before = await mockRequest<OffsetPage<Organization>>('GET', '/v1/organizations');
    expect(before.data.map((row) => row.id)).not.toContain('org_01JQNORTH');

    const accepted = await mockRequest<AcceptedInvitation>('POST', '/v1/invitations/accept', {
      token: 'inv_live_northline_developer_01',
    });
    expect(accepted.organization).toMatchObject({ id: 'org_01JQNORTH', role: 'developer' });
    expect(accepted).not.toHaveProperty('status');

    const after = await mockRequest<OffsetPage<Organization>>('GET', '/v1/organizations');
    expect(after.data.map((row) => row.id)).toContain('org_01JQNORTH');

    // Single-use: the same token a second time is the dead-token 400.
    await expect(
      mockRequest('POST', '/v1/invitations/accept', { token: 'inv_live_northline_developer_01' }),
    ).rejects.toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('accepting again for an organization you are already in returns it unchanged', async () => {
    const accepted = await mockRequest<AcceptedInvitation>('POST', '/v1/invitations/accept', {
      token: 'inv_live_shaq_already_member_02',
    });
    // The membership as it stands — owner — not the viewer role on the token.
    expect(accepted.organization).toMatchObject({ id: 'org_01JQSHAQ', role: 'owner' });
    const list = await mockRequest<OffsetPage<Organization>>('GET', '/v1/organizations');
    expect(list.data.filter((row) => row.id === 'org_01JQSHAQ')).toHaveLength(1);
  });

  it('expired, used and wrong-address tokens are ONE 400 with ONE sentence', async () => {
    const messages = new Set<string>();
    for (const token of [
      'inv_expired_northline_000000_03',
      'inv_used_northline_00000000_04',
      'inv_live_northline_other_addr_05',
      'inv_unknown_00000000000000_99',
    ]) {
      const failure = await mockRequest('POST', '/v1/invitations/accept', { token }).catch(
        (error: MockHttpError) => error,
      );
      expect(failure).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
      messages.add((failure as MockHttpError).message);
    }
    expect(messages.size).toBe(1);
    // The wrong-address token is burnt by the attempt, as it is on the server.
    await expect(
      mockRequest('POST', '/v1/invitations/accept', { token: 'inv_live_northline_other_addr_05' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses with 409 conflict when the inviter can no longer support the invitation', async () => {
    await expect(
      mockRequest('POST', '/v1/invitations/accept', {
        token: 'inv_live_northline_inviter_gone_06',
      }),
    ).rejects.toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: expect.stringContaining('new invitation') } },
    });
  });

  it('validates the token the way AcceptInvitationDto does, as a per-field 400', async () => {
    await expect(mockRequest('POST', '/v1/invitations/accept', {})).rejects.toBeInstanceOf(
      MockHttpError,
    );
    await expect(
      mockRequest('POST', '/v1/invitations/accept', { token: 'short' }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_request', message: [expect.stringContaining('token')] } },
    });
  });

  it('counts acceptances against the same 20-per-hour bucket as InvitationsController', async () => {
    for (let i = 0; i < 20; i += 1) {
      await expect(
        mockRequest('POST', '/v1/invitations/accept', { token: 'inv_unknown_00000000000000_99' }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      mockRequest('POST', '/v1/invitations/accept', { token: 'inv_unknown_00000000000000_99' }),
    ).rejects.toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
  });

  it('onboarding-completed is a bodiless 204 that sticks on the FIRST call and reads back on the session', async () => {
    const before = await mockRequest<Session>('GET', '/v1/auth/session');
    expect(before.user.onboarding_completed_at).toBeNull();

    expect(await mockRequest('POST', '/v1/auth/onboarding-completed')).toBeUndefined();
    const first = (await mockRequest<Session>('GET', '/v1/auth/session')).user
      .onboarding_completed_at;
    expect(first).toEqual(expect.any(String));

    // A replay is a success that touches nothing.
    await mockRequest('POST', '/v1/auth/onboarding-completed');
    const second = (await mockRequest<Session>('GET', '/v1/auth/session')).user
      .onboarding_completed_at;
    expect(second).toBe(first);
  });

  it('paginates events by OFFSET — `next_cursor` does not exist anywhere', async () => {
    const first = await mockRequest<OffsetPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=10`,
    );
    expect(first.data).toHaveLength(10);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(10);
    expect(first).not.toHaveProperty('next_cursor');

    const second = await mockRequest<OffsetPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=10&offset=${first.next_offset}`,
    );
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  });

  it('omits the payload from list rows and returns it as an ENVELOPE on the detail route', async () => {
    const page = await mockRequest<OffsetPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=1`,
    );
    expect(page.data[0]).not.toHaveProperty('payload');

    // NESTED under the project — `/v1/events/:id` does not exist.
    const detail = await mockRequest<EventDetail>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events/${page.data[0].id}`,
    );
    // `EventPayloadDto`: where the bytes came from, not the bytes alone. An
    // offloaded payload must not render as an empty code block.
    expect(detail.payload.source).toBeDefined();
    expect(detail.payload.sha256).toBeTruthy();
    expect(db.events.some((event) => event.payload.source === 'object_storage')).toBe(true);
  });

  it('materialises routing: one event, one delivery per matching subscription', async () => {
    const event = db.events.find((candidate) => candidate.event_type === 'payment.settled');
    expect(event).toBeDefined();

    const { data } = await mockRequest<OffsetPage<Delivery>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events/${event!.id}/deliveries`,
    );
    expect(data.length).toBeGreaterThan(1);
    // Each delivery is an independent chain against a distinct endpoint.
    expect(new Set(data.map((delivery) => delivery.endpoint_id)).size).toBe(data.length);
  });

  it('contains the hard cases the UI has to render', () => {
    const statuses = new Set(db.deliveries.map((delivery) => delivery.status));
    expect(statuses.has('exhausted')).toBe(true);
    expect(statuses.has('retrying')).toBe(true);

    const exhausted = db.deliveries.find((delivery) => delivery.status === 'exhausted');
    expect(db.attempts[exhausted!.id]).toHaveLength(exhausted!.max_attempts);

    // At least one failure with no HTTP response at all (DNS/TLS/timeout).
    expect(
      Object.values(db.attempts)
        .flat()
        .some((attempt) => attempt.http_status === null && attempt.error_message !== null),
    ).toBe(true);

    // And a payload large enough to exercise the scrollable viewer.
    expect(Math.max(...db.events.map((event) => event.payload_size))).toBeGreaterThan(50_000);
  });

  it('returns the documented error envelope with a request_id', async () => {
    await expect(mockRequest('GET', `/v1/projects/${db.projects[0].id}/events/evt_missing`)).rejects.toBeInstanceOf(MockHttpError);

    try {
      await mockRequest('GET', `/v1/projects/${db.projects[0].id}/events/evt_missing`);
    } catch (error) {
      const body = (error as MockHttpError).body;
      expect(body.error.code).toBe('not_found');
      expect(body.error.request_id).toMatch(/^req_/);
    }
  });

  it('rejects a login with an invalid credential', async () => {
    await expect(
      mockRequest('POST', '/v1/auth/login', { email: 'a@b.com', password: 'wrong' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('never confirms whether an address exists on password reset', async () => {
    await expect(
      mockRequest('POST', '/v1/auth/forgot-password', { email: 'nobody@example.com' }),
    ).resolves.toEqual({ status: 'accepted' });
  });

  /**
   * The enumeration-resistance property, pinned so it cannot be quietly lost.
   * `POST /v1/auth/register` must answer identically for an address that has an
   * account and one that does not — no 409, no session, nothing a caller could
   * diff. If this ever fails, registration has become an oracle for walking a
   * list of addresses to learn which are registered.
   */
  it('answers register identically for a known and an unknown address', async () => {
    const fields = { name: 'Ada', password: 'correct-horse-battery', organization_name: 'Acme' };

    // `db.user.email` is the seeded account, so it is definitely taken.
    const known = await mockRequest('POST', '/v1/auth/register', {
      ...fields,
      email: db.user.email,
    });
    const unknown = await mockRequest('POST', '/v1/auth/register', {
      ...fields,
      email: 'definitely-not-registered@example.com',
    });

    expect(known).toEqual(unknown);
    expect(JSON.stringify(known)).toBe(JSON.stringify(unknown));
    expect(known).toEqual({ status: 'accepted' });
  });

  it('does not authenticate the caller on register', async () => {
    const accepted = await mockRequest<Record<string, unknown>>('POST', '/v1/auth/register', {
      name: 'Ada',
      email: 'someone@example.com',
      password: 'correct-horse-battery',
      organization_name: 'Acme',
    });
    // No session, no user, nothing that could be mistaken for being signed in.
    expect(accepted).not.toHaveProperty('user');
    expect(accepted).not.toHaveProperty('organizations');
    expect(accepted).not.toHaveProperty('token');
  });
});
