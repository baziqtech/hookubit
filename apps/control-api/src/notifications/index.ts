export { NotificationsModule } from './notifications.module';
export {
  MAIL_TRANSPORT,
  MailDeliveryError,
  type MailKind,
  type MailReceipt,
  type MailTransport,
  type OutboundMail,
} from './mail-transport';
export { DASHBOARD_PATHS, SmtpMailer } from './smtp-mailer';
export { NodemailerSmtpTransport, SMTP_TIMEOUTS_MS } from './smtp-transport';
export {
  STUB_MAILER_ENVIRONMENTS,
  createMailTransport,
  selectMailer,
  templateContextFrom,
  type MailerChoices,
} from './mailer-selection';
export { parseMailbox, type Mailbox } from './mailbox';
export { fingerprintToken, redactRecipient, scrubAddresses } from './redaction';
export { buildDashboardLink, type RenderedMail, type TemplateContext } from './templates';
