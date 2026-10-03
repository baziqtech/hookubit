/**
 * The four triggers a destination can ask for, and what each one means.
 *
 * Deliberately short. The design's rule is "nothing routine, only things a
 * person has to act on", and every entry that fails that test becomes noise
 * that gets filtered to a folder — taking the three that mattered with it.
 */
export const NOTIFICATION_EVENTS = {
  'endpoint.stopped': {
    label: 'An endpoint was stopped by us',
    detail:
      'We gave up on an endpoint after too many failures in a row. Deliveries are being cancelled until someone starts it again.',
    /** Wakes people. See `QUIET_HOURS`. */
    urgent: true,
  },
  'event.stuck': {
    label: 'An event got stuck',
    detail:
      'We accepted an event and then never created any deliveries for it. It will not appear in the delivery list at all.',
    urgent: false,
  },
  'secret.retiring': {
    label: 'A signing secret is about to retire',
    detail:
      'Sent seven days before, then again on the day. After it retires every request to that endpoint fails.',
    urgent: false,
  },
  'delivery.exhausted': {
    label: 'A delivery gave up',
    detail:
      'Only the first one for an endpoint each day, so a bad afternoon does not become four hundred messages.',
    urgent: false,
  },
} as const;

export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;

export const NOTIFICATION_EVENT_NAMES = Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[];

export function isNotificationEvent(value: string): value is NotificationEvent {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, value);
}

/**
 * How long the same subject stays grouped.
 *
 * Thirty minutes. An endpoint that fails again eleven minutes later is the
 * SAME incident, and a second message about it costs the reader attention
 * without adding information — while training them to ignore the next one.
 */
export const GROUPING_WINDOW_MS = 30 * 60_000;

/**
 * Quiet hours, in the destination's day: 22:00 to 07:00.
 *
 * An urgent trigger ignores them. Everything else waits for the morning,
 * because the difference between "your webhooks stopped" and "one delivery
 * gave up" is the difference between something that has to be fixed now and
 * something that has to be fixed today — and a channel that cannot tell them
 * apart is a channel people mute.
 */
export const QUIET_HOURS = { from: 22, until: 7 } as const;

export function inQuietHours(at: Date): boolean {
  const hour = at.getUTCHours();
  // The window crosses midnight, so this is an OR and not an AND. Written as
  // a range check it silently becomes "never".
  return hour >= QUIET_HOURS.from || hour < QUIET_HOURS.until;
}

export type SendVerdict =
  | { send: true; reason: 'new' | 'window-expired' | 'urgent' }
  | { send: false; reason: 'grouped' | 'quiet-hours' | 'not-subscribed' | 'not-confirmed' };

export interface DestinationState {
  status: string;
  events: readonly string[];
}

export interface LastDispatch {
  subject: string;
  lastAt: Date;
  sentAt: Date | null;
}

/**
 * Should this trigger produce a message to this destination, right now?
 *
 * The order of the checks is the policy, and each one is a different kind of
 * "no":
 *
 *  1. NOT CONFIRMED — nobody receives mail they did not agree to, however
 *     urgent. A group address exists precisely so one person can sign
 *     everybody else up, and this is what stops that.
 *  2. NOT SUBSCRIBED — they asked not to hear about this. An empty event list
 *     is a legal, deliberate state: it is how a channel is muted without
 *     losing its confirmation.
 *  3. GROUPED — the same subject within the window. Checked BEFORE quiet
 *     hours, because a repeat is not more worth waking someone for than the
 *     original was.
 *  4. QUIET HOURS — unless the trigger is urgent.
 *
 * Getting 3 and 4 the other way round would mean an endpoint that fails every
 * five minutes through the night sends one message at 07:00 per failure, all
 * at once, which is the exact outcome grouping exists to prevent.
 */
export function shouldSend(
  destination: DestinationState,
  event: NotificationEvent,
  subject: string,
  previous: LastDispatch | null,
  now: Date,
): SendVerdict {
  if (destination.status !== 'confirmed') return { send: false, reason: 'not-confirmed' };
  if (!destination.events.includes(event)) return { send: false, reason: 'not-subscribed' };

  if (previous && previous.subject === subject) {
    const age = now.getTime() - previous.lastAt.getTime();
    if (age < GROUPING_WINDOW_MS) return { send: false, reason: 'grouped' };
    if (inQuietHours(now) && !NOTIFICATION_EVENTS[event].urgent) {
      return { send: false, reason: 'quiet-hours' };
    }
    return { send: true, reason: 'window-expired' };
  }

  if (NOTIFICATION_EVENTS[event].urgent) return { send: true, reason: 'urgent' };
  if (inQuietHours(now)) return { send: false, reason: 'quiet-hours' };
  return { send: true, reason: 'new' };
}
