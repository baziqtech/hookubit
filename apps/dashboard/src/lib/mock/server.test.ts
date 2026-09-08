import { beforeEach, describe, expect, it } from 'vitest';
import type { CursorPage, Delivery, EventDetail, Session, WebhookEvent } from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The mock is a stand-in for the control API, so it is worth holding to the
 * contract: the documented paths resolve, pagination is shaped like the real
 * `Page<T>`, and failures carry the same error envelope with a `request_id`.
 * These also catch the fixture generator failing at module load.
 */
describe('mock control API', () => {
  beforeEach(() => resetMockState());

  it('serves a session with organizations', async () => {
    const session = await mockRequest<Session>('GET', '/v1/auth/session');
    expect(session.user.email).toContain('@');
    expect(session.organizations.length).toBeGreaterThan(0);
  });

  it('paginates events with an opaque cursor', async () => {
    const first = await mockRequest<CursorPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=10`,
    );
    expect(first.data).toHaveLength(10);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = await mockRequest<CursorPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=10&cursor=${first.next_cursor}`,
    );
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  });

  it('omits the payload from list rows and includes it on the detail route', async () => {
    const page = await mockRequest<CursorPage<WebhookEvent>>(
      'GET',
      `/v1/projects/${db.projects[0].id}/events?limit=1`,
    );
    expect(page.data[0]).not.toHaveProperty('payload');

    const detail = await mockRequest<EventDetail>('GET', `/v1/events/${page.data[0].id}`);
    expect(detail.payload).toBeDefined();
  });

  it('materialises fan-out: one event, one delivery per matching subscription', async () => {
    const event = db.events.find((candidate) => candidate.event_type === 'payment.settled');
    expect(event).toBeDefined();

    const { data } = await mockRequest<{ data: Delivery[] }>(
      'GET',
      `/v1/events/${event!.id}/deliveries`,
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
        .some((attempt) => attempt.status_code === null && attempt.error !== null),
    ).toBe(true);

    // And a payload large enough to exercise the scrollable viewer.
    expect(Math.max(...db.events.map((event) => event.payload_size_bytes))).toBeGreaterThan(50_000);
  });

  it('returns the documented error envelope with a request_id', async () => {
    await expect(mockRequest('GET', '/v1/events/evt_missing')).rejects.toBeInstanceOf(MockHttpError);

    try {
      await mockRequest('GET', '/v1/events/evt_missing');
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
