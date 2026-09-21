/**
 * The seam between "what to say" (templates + `SmtpMailer`) and "how to get it
 * there" (`NodemailerSmtpTransport`). Tests substitute a recording transport
 * here; nothing above this line knows nodemailer exists.
 */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type MailKind =
  | 'email_verification'
  | 'password_reset'
  | 'registration_attempt'
  | 'invitation'
  | 'already_member'
  // Operational alerts, and the confirmation that has to come before them.
  // Kept as their own kinds so a transport, a log line or a suppression list
  // can tell "your webhooks stopped" apart from "reset your password" — they
  // have different urgency and, for most providers, different deliverability.
  | 'notification_confirmation'
  | 'notification_alert';

export interface OutboundMail {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailReceipt {
  /** The transport's own id for the message, if it issued one. Safe to log. */
  messageId: string | null;
}

export interface MailTransport {
  send(mail: OutboundMail): Promise<MailReceipt>;
}

/**
 * What a transport throws. Its `message` has already had every address-shaped
 * substring scrubbed (see `scrubAddresses`), because the callers - `AuthService`
 * and `MembersService` - log `err.message` and an SMTP rejection line such as
 * `550 5.1.1 <someone@example.com>: user unknown` would otherwise put the
 * recipient into the log by the back door. The upstream error is deliberately
 * NOT attached as `cause` for the same reason: whatever logs the error object
 * would log the unscrubbed text with it.
 */
export class MailDeliveryError extends Error {
  constructor(
    readonly kind: MailKind,
    message: string,
    /** nodemailer's error code (`ECONNECTION`, `EAUTH`, `EENVELOPE`...) when it had one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}
