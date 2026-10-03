import { NotificationAlertInput } from '../notifications/templates';

export const OPERATIONAL_MAILER = Symbol('OPERATIONAL_MAILER');

/**
 * Operational mail: alerts, and the confirmation that must precede them.
 *
 * Its own port rather than another method on `AuthMailer`, because the two have
 * different failure semantics. A failed password reset is a user stuck at a
 * screen who will try again; a failed alert is a silence nobody notices, which
 * is exactly the thing alerting exists to prevent. The dispatcher therefore
 * records what happened to every send, and a port it can stub is what makes
 * that testable.
 */
export interface OperationalMailer {
  sendNotificationConfirmation(
    email: string,
    input: { projectName: string; rawToken: string },
  ): Promise<void>;
  sendNotificationAlert(email: string, input: NotificationAlertInput): Promise<void>;
}
