import {
  GROUPING_WINDOW_MS,
  inQuietHours,
  NOTIFICATION_EVENT_NAMES,
  shouldSend,
  type LastDispatch,
} from './notification-rules';

const confirmed = { status: 'confirmed', events: [...NOTIFICATION_EVENT_NAMES] };
const at = (iso: string) => new Date(iso);

describe('inQuietHours', () => {
  it('covers the window that CROSSES midnight', () => {
    // Written as a range check (`>= 22 && < 7`) this silently becomes "never",
    // and the quiet hours do nothing at all for anybody.
    expect(inQuietHours(at('2026-06-01T22:00:00Z'))).toBe(true);
    expect(inQuietHours(at('2026-06-01T23:59:00Z'))).toBe(true);
    expect(inQuietHours(at('2026-06-02T00:30:00Z'))).toBe(true);
    expect(inQuietHours(at('2026-06-02T06:59:00Z'))).toBe(true);
  });

  it('is over at 07:00 and has not started at 21:59', () => {
    expect(inQuietHours(at('2026-06-02T07:00:00Z'))).toBe(false);
    expect(inQuietHours(at('2026-06-01T21:59:00Z'))).toBe(false);
  });
});

describe('shouldSend', () => {
  const noon = at('2026-06-01T12:00:00Z');
  const night = at('2026-06-02T02:00:00Z');

  it('never sends to an unconfirmed destination, however urgent', () => {
    // A group address exists precisely so one person can sign everybody else
    // up. This is what stops that being a way to mail somebody forever.
    const verdict = shouldSend(
      { status: 'pending', events: [...NOTIFICATION_EVENT_NAMES] },
      'endpoint.stopped',
      'endpoint:ep_1:stopped',
      null,
      noon,
    );
    expect(verdict).toEqual({ send: false, reason: 'not-confirmed' });
  });

  it('respects an empty event list, which is how a channel is muted', () => {
    // Legal and deliberate: muting without deleting keeps the confirmation.
    const verdict = shouldSend(
      { status: 'confirmed', events: [] },
      'event.stuck',
      'event:evt_1:stuck',
      null,
      noon,
    );
    expect(verdict).toEqual({ send: false, reason: 'not-subscribed' });
  });

  it('groups the same subject inside the window', () => {
    const previous: LastDispatch = {
      subject: 'endpoint:ep_1:stopped',
      lastAt: new Date(noon.getTime() - 60_000),
      sentAt: new Date(noon.getTime() - 60_000),
    };
    expect(
      shouldSend(confirmed, 'endpoint.stopped', 'endpoint:ep_1:stopped', previous, noon).send,
    ).toBe(false);
  });

  it('sends again once the window has passed', () => {
    const previous: LastDispatch = {
      subject: 'endpoint:ep_1:stopped',
      lastAt: new Date(noon.getTime() - GROUPING_WINDOW_MS - 1),
      sentAt: new Date(noon.getTime() - GROUPING_WINDOW_MS - 1),
    };
    expect(
      shouldSend(confirmed, 'endpoint.stopped', 'endpoint:ep_1:stopped', previous, noon).reason,
    ).toBe('window-expired');
  });

  it('treats a DIFFERENT subject as a different incident', () => {
    // Two endpoints failing are two problems. Grouping them would hide the
    // second one behind the first for half an hour.
    const previous: LastDispatch = {
      subject: 'endpoint:ep_1:stopped',
      lastAt: noon,
      sentAt: noon,
    };
    expect(
      shouldSend(confirmed, 'endpoint.stopped', 'endpoint:ep_2:stopped', previous, noon).send,
    ).toBe(true);
  });

  it('wakes people for an endpoint we stopped, and only for that', () => {
    expect(shouldSend(confirmed, 'endpoint.stopped', 's', null, night)).toEqual({
      send: true,
      reason: 'urgent',
    });
    expect(shouldSend(confirmed, 'event.stuck', 's', null, night)).toEqual({
      send: false,
      reason: 'quiet-hours',
    });
    expect(shouldSend(confirmed, 'delivery.exhausted', 's', null, night).send).toBe(false);
  });

  it('checks grouping BEFORE quiet hours', () => {
    // The other order means an endpoint failing every five minutes through the
    // night sends one message at 07:00 per failure, all at once — the exact
    // outcome grouping exists to prevent.
    const previous: LastDispatch = {
      subject: 'event:evt_1:stuck',
      lastAt: new Date(night.getTime() - 60_000),
      sentAt: null,
    };
    expect(
      shouldSend(confirmed, 'event.stuck', 'event:evt_1:stuck', previous, night).reason,
    ).toBe('grouped');
  });
});
