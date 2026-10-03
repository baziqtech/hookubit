/**
 * The four triggers, mirroring `notification-rules.ts` on the server.
 *
 * Duplicated deliberately rather than derived from the OpenAPI enum: the copy
 * that matters here is the PROSE, and prose does not travel on the wire. The
 * server's list is the authority for which values are legal — a value it
 * rejects is a 400 naming it.
 */
export const NOTIFICATION_EVENTS = [
  {
    id: 'endpoint.stopped',
    label: 'An endpoint was stopped by us',
    detail:
      'We gave up on an endpoint after too many failures in a row. Deliveries are being cancelled until someone starts it again.',
    urgent: true,
    wired: true,
  },
  {
    id: 'event.stuck',
    label: 'An event got stuck',
    detail:
      'We accepted an event and then never created any deliveries for it. It will not appear in the delivery list at all.',
    urgent: false,
    wired: false,
  },
  {
    id: 'secret.retiring',
    label: 'A signing secret is about to retire',
    detail:
      'Sent seven days before, then again on the day. After it retires every request to that endpoint fails.',
    urgent: false,
    wired: false,
  },
  {
    id: 'delivery.exhausted',
    label: 'A delivery gave up',
    detail:
      'Only the first one for an endpoint each day, so a bad afternoon does not become four hundred messages.',
    urgent: false,
    wired: false,
  },
] as const;

export type NotificationEventId = (typeof NOTIFICATION_EVENTS)[number]['id'];

export function eventLabel(id: string): string {
  return NOTIFICATION_EVENTS.find((event) => event.id === id)?.label ?? id;
}

/**
 * Which triggers actually fire today.
 *
 * `endpoint.stopped` is raised by the control plane's auto-disable sweep, which
 * is the component that NOTICES. The other three are noticed in the Go data
 * plane — a parked outbox row, an exhausted delivery — or by a sweep that does
 * not exist yet, and nothing raises them.
 *
 * They are still subscribable, and the page says plainly that they are not
 * wired. The alternative — hiding them — would mean an operator subscribes to
 * what is offered, sees nothing for a month, and concludes the whole feature is
 * broken. An unchecked box with a reason beside it is the honest version.
 */
export const UNWIRED_EVENTS = NOTIFICATION_EVENTS.filter((event) => !event.wired).map(
  (event) => event.id as string,
);
